import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.ts";
import type { Store } from "./store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
  every_minutes INTEGER, daily_at TEXT, weekdays TEXT,
  conv_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL DEFAULT 'person',
  next_run INTEGER, last_run INTEGER, last_status TEXT, created_at INTEGER NOT NULL
);
`;
export const MIN_EVERY_PERSON = 5;
// A Bot sets these up from a conversation without asking first, so it gets a coarser floor and a cap.
export const MIN_EVERY_BOT = 15;
export const MAX_PER_BOT = 10;
const MAX_PROMPT = 4000;

export interface Routine {
  id: string;
  bot_id: string;
  name: string;
  prompt: string;
  every_minutes: number | null;
  daily_at: string | null;
  weekdays: number[];
  conv_id: string | null;
  enabled: boolean;
  created_by: "person" | "bot";
  next_run: number | null;
  last_run: number | null;
  last_status: string | null;
  created_at: number;
}

type Row = Record<string, any>;
const view = (r: Row): Routine => ({ ...(r as Routine), weekdays: r.weekdays ? String(r.weekdays).split(",").map(Number) : [], enabled: Boolean(r.enabled) });

// Local time, so "09:00" means nine on this computer's clock.
export function nextRun(r: Pick<Routine, "every_minutes" | "daily_at" | "weekdays">, from: number): number {
  if (r.every_minutes) return from + r.every_minutes * 60000;
  const [hh, mm] = String(r.daily_at).split(":").map(Number);
  for (let d = 0; d <= 7; d++) {
    const at = new Date(from);
    at.setDate(at.getDate() + d);
    at.setHours(hh, mm, 0, 0);
    if (at.getTime() > from && (!r.weekdays.length || r.weekdays.includes(at.getDay()))) return at.getTime();
  }
  throw new Error("no run within a week");
}

export function describeSchedule(r: Pick<Routine, "every_minutes" | "daily_at" | "weekdays">) {
  if (r.every_minutes) return r.every_minutes % 60 === 0 ? `每 ${r.every_minutes / 60} 小时` : `每 ${r.every_minutes} 分钟`;
  const names = "日一二三四五六";
  const days = !r.weekdays.length || r.weekdays.length === 7 ? "每天" : r.weekdays.join(",") === "1,2,3,4,5" ? "工作日" : `每周${r.weekdays.map((d) => names[d]).join("、")}`;
  return `${days} ${r.daily_at}`;
}

function parseSpec(input: any, by: "person" | "bot", cur?: Routine) {
  const floor = by === "bot" ? MIN_EVERY_BOT : MIN_EVERY_PERSON;
  const name = input?.name === undefined ? cur?.name : String(input.name).trim().slice(0, 60);
  const prompt = input?.prompt === undefined ? cur?.prompt : String(input.prompt).trim();
  if (!name) throw new HttpError(400, "请填写定时任务名称");
  if (!prompt) throw new HttpError(400, "请填写要发给 Bot 的内容");
  if (prompt.length > MAX_PROMPT) throw new HttpError(413, `内容不能超过 ${MAX_PROMPT} 字`);
  const scheduleGiven = input?.every_minutes !== undefined || input?.daily_at !== undefined;
  let every = scheduleGiven ? input.every_minutes ?? null : cur?.every_minutes ?? null;
  let daily = scheduleGiven ? input.daily_at ?? null : cur?.daily_at ?? null;
  if (every !== null && every !== "") {
    every = Number(every);
    if (!Number.isInteger(every) || every < floor || every > 7 * 24 * 60) throw new HttpError(400, `间隔要在 ${floor} 分钟到 7 天之间`);
    daily = null;
  } else every = null;
  if (every === null) {
    if (typeof daily !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(daily)) throw new HttpError(400, "请给出间隔分钟数，或每天的时间（如 09:00）");
  }
  const rawDays = input?.weekdays === undefined ? cur?.weekdays ?? [] : input.weekdays;
  if (!Array.isArray(rawDays) || rawDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, "星期要用 0（周日）到 6（周六）");
  const weekdays = [...new Set(rawDays as number[])].sort();
  return { name, prompt, every_minutes: every as number | null, daily_at: every === null ? (daily as string) : null, weekdays };
}

export class Routines {
  private readonly store: Store;
  private readonly fire: (r: Routine) => Promise<{ convId: string }>;
  private readonly onChange: (r: Routine | null, botId: string, id: string) => void;
  private readonly timer: NodeJS.Timeout;
  private readonly firing = new Set<string>();

  constructor(o: { store: Store; fire: (r: Routine) => Promise<{ convId: string }>; onChange: (r: Routine | null, botId: string, id: string) => void; tickMs?: number }) {
    this.store = o.store;
    this.fire = o.fire;
    this.onChange = o.onChange;
    o.store.db.exec(SCHEMA);
    this.timer = setInterval(() => void this.tick(), o.tickMs ?? 20000);
    this.timer.unref();
  }

  close() {
    clearInterval(this.timer);
  }

  get(id: string) {
    const r = this.store.db.prepare("SELECT * FROM routines WHERE id=?").get(id) as Row | undefined;
    if (!r) throw new HttpError(404, "定时任务不存在");
    return view(r);
  }

  list(botId?: string) {
    const rows = (botId ? this.store.db.prepare("SELECT * FROM routines WHERE bot_id=? ORDER BY created_at").all(botId) : this.store.db.prepare("SELECT * FROM routines ORDER BY created_at").all()) as Row[];
    return rows.map(view);
  }

  create(botId: string, input: any, by: "person" | "bot" = "person") {
    if (!this.store.getBot(botId)) throw new HttpError(404, "Bot 不存在");
    const spec = parseSpec(input, by);
    if (by === "bot" && this.list(botId).filter((r) => r.enabled).length >= MAX_PER_BOT) throw new HttpError(409, `一个 Bot 最多 ${MAX_PER_BOT} 个开启的定时任务`);
    const id = randomUUID();
    const now = Date.now();
    this.store.db
      .prepare("INSERT INTO routines (id,bot_id,name,prompt,every_minutes,daily_at,weekdays,conv_id,enabled,created_by,next_run,created_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)")
      .run(id, botId, spec.name, spec.prompt, spec.every_minutes, spec.daily_at, spec.weekdays.join(",") || null, typeof input?.conv_id === "string" ? input.conv_id : null, by, nextRun(spec, now), now);
    return this.changed(id);
  }

  update(id: string, input: any) {
    const cur = this.get(id);
    const spec = parseSpec(input, "person", cur);
    const enabled = input?.enabled === undefined ? cur.enabled : Boolean(input.enabled);
    const rescheduled = spec.every_minutes !== cur.every_minutes || spec.daily_at !== cur.daily_at || spec.weekdays.join() !== cur.weekdays.join() || (enabled && !cur.enabled);
    const next = rescheduled || cur.next_run === null ? nextRun(spec, Date.now()) : cur.next_run;
    this.store.db
      .prepare("UPDATE routines SET name=?, prompt=?, every_minutes=?, daily_at=?, weekdays=?, enabled=?, next_run=? WHERE id=?")
      .run(spec.name, spec.prompt, spec.every_minutes, spec.daily_at, spec.weekdays.join(",") || null, enabled ? 1 : 0, next, id);
    return this.changed(id);
  }

  remove(id: string) {
    const cur = this.get(id);
    this.store.db.prepare("DELETE FROM routines WHERE id=?").run(id);
    this.onChange(null, cur.bot_id, id);
  }

  // Runs now without moving the schedule.
  async runNow(id: string) {
    await this.run(this.get(id));
    return this.get(id);
  }

  async tick(now = Date.now()) {
    const due = (this.store.db.prepare("SELECT * FROM routines WHERE enabled=1 AND next_run<=?").all(now) as Row[]).map(view);
    for (const r of due) {
      // A missed run (the computer was asleep) fires once, then the schedule carries on from now.
      this.store.db.prepare("UPDATE routines SET next_run=? WHERE id=?").run(nextRun(r, now), r.id);
      await this.run(r);
    }
  }

  private async run(r: Routine) {
    if (this.firing.has(r.id)) return;
    this.firing.add(r.id);
    let status: string;
    let convId = r.conv_id;
    try {
      const bot = this.store.getBot(r.bot_id);
      if (!bot) {
        this.store.db.prepare("UPDATE routines SET enabled=0 WHERE id=?").run(r.id);
        status = "Bot 已删除，定时任务已关闭";
      } else if (bot.paused) status = "Bot 已暂停，这次跳过";
      else {
        convId = (await this.fire(r)).convId;
        status = "已发出";
      }
    } catch (e) {
      status = `没有发出：${(e as Error).message}`;
    } finally {
      this.firing.delete(r.id);
    }
    this.store.db.prepare("UPDATE routines SET last_run=?, last_status=?, conv_id=? WHERE id=?").run(Date.now(), status, convId, r.id);
    this.changed(r.id);
  }

  private changed(id: string) {
    const r = this.get(id);
    this.onChange(r, r.bot_id, id);
    return r;
  }
}
