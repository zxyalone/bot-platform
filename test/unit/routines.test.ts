import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../helpers.ts";
import { nextRun } from "../../src/daemon/routines.ts";
import type { AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "botctl.mjs");

class Fake implements AgentRuntime {
  sent: string[] = [];
  opts: RuntimeOptions;
  auto: boolean;
  constructor(opts: RuntimeOptions, auto: boolean) {
    this.opts = opts;
    this.auto = auto;
  }
  reply(text = "好") {
    this.opts.onEvent({ type: "text_done", key: `k${Math.random()}`, text });
    this.opts.onEvent({ type: "usage", inputTokens: 100, cachedTokens: 40, outputTokens: 5 });
    this.opts.onEvent({ type: "turn_end", status: "completed" });
  }
  async start() {}
  async send(t: string) {
    this.sent.push(t);
    if (this.auto) setTimeout(() => this.reply(`回复：${t.slice(0, 20)}`), 20);
  }
  async interrupt() {}
  answerApproval(_: string, __: ApprovalDecision) {}
  stop() {}
}

async function setup(auto = false) {
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o, auto);
    made.push(f);
    return f;
  });
  const cwd = mkdtempSync(join(tmpdir(), "bot-routine-"));
  const bot = (await t.api("POST", "/api/bots", { name: "Watcher", role: "ROLE", agent: "codex", model: "gpt-6-luna", cwd })).body;
  const sends = () => made.flatMap((f) => f.sent);
  const routines = t.app.engine.routines;
  return { t, made, bot, sends, routines, cwd };
}

test("next run: intervals count from now, daily times skip days that are not picked", () => {
  const from = new Date(2026, 10, 6, 10, 0).getTime(); // a Friday
  assert.equal(nextRun({ every_minutes: 90, daily_at: null, weekdays: [] }, from), from + 90 * 60000);
  assert.equal(nextRun({ every_minutes: null, daily_at: "09:00", weekdays: [] }, from), new Date(2026, 10, 7, 9, 0).getTime(), "already past today");
  assert.equal(nextRun({ every_minutes: null, daily_at: "11:30", weekdays: [] }, from), new Date(2026, 10, 6, 11, 30).getTime());
  assert.equal(nextRun({ every_minutes: null, daily_at: "09:00", weekdays: [1, 2, 3, 4, 5] }, from), new Date(2026, 10, 9, 9, 0).getTime(), "Monday");
});

test("a due routine sends its prompt, keeps one conversation, skips while the last run is going, and respects pause", async () => {
  const s = await setup();
  assert.equal((await s.t.api("POST", `/api/bots/${s.bot.id}/routines`, { name: "x", prompt: "p", every_minutes: 2 })).status, 400);
  assert.equal((await s.t.api("POST", `/api/bots/${s.bot.id}/routines`, { name: "x", prompt: "p", daily_at: "25:00" })).status, 400);
  const r = (await s.t.api("POST", `/api/bots/${s.bot.id}/routines`, { name: "检查训练", prompt: "看一下 train.log", every_minutes: 60 })).body;
  assert.ok(r.next_run > Date.now() + 59 * 60000);
  const state = (await s.t.api("GET", "/api/state")).body;
  assert.equal(state.bots.find((b: any) => b.id === s.bot.id).routines.length, 1);

  await s.routines.tick(Date.now());
  assert.equal(s.sends().length, 0, "not due yet");
  await s.routines.tick(r.next_run);
  await s.t.waitFor(() => s.sends().length === 1, "sent");
  assert.match(s.sends()[0], /定时任务「检查训练」[\s\S]*train\.log/);
  const fired = s.routines.get(r.id);
  assert.ok(fired.conv_id);
  assert.equal(fired.last_status, "已发出");
  assert.ok(fired.next_run > r.next_run);

  await s.routines.runNow(r.id);
  assert.match(s.routines.get(r.id).last_status, /上一次还没结束/);
  assert.equal(s.sends().length, 1);
  s.made[0].reply();
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${fired.conv_id}/items`)).body.conversation.status === "idle", "idle");

  await s.routines.runNow(r.id);
  await s.t.waitFor(() => s.sends().length === 2, "second");
  assert.equal(s.routines.get(r.id).conv_id, fired.conv_id, "same conversation");
  s.made[0].reply();
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${fired.conv_id}/items`)).body.conversation.status === "idle", "idle");

  await s.t.api("PATCH", `/api/bots/${s.bot.id}`, { paused: true });
  await s.routines.runNow(r.id);
  assert.match(s.routines.get(r.id).last_status, /暂停/);

  const off = (await s.t.api("PATCH", `/api/routines/${r.id}`, { enabled: false })).body;
  assert.equal(off.enabled, false);
  await s.routines.tick(Date.now() + 10 * 86400000);
  assert.equal(s.sends().length, 2, "a paused routine never fires");
  assert.ok(s.t.events.some((e) => e.type === "routine" && e.id === r.id));
  assert.equal((await s.t.api("DELETE", `/api/routines/${r.id}`)).status, 200);
  assert.equal((await s.t.api("GET", `/api/bots/${s.bot.id}/routines`)).body.routines.length, 0);
  s.t.close();
});

test("a Bot can set up, list and cancel its own routines from a conversation, within a floor and a cap", async () => {
  const s = await setup();
  const conv = (await s.t.api("POST", `/api/bots/${s.bot.id}/messages`, { text: "每小时看一下训练" })).body;
  await s.t.waitFor(() => s.sends().length === 1, "sent");
  const f = s.made[0];
  const bus = (args: unknown) => fetch(`${s.t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool: "routine", args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  assert.ok(f.opts.bus!.env.BUS_TOOLS.split(",").includes("routine"));

  assert.equal((await bus({ action: "create", name: "太频繁", prompt: "p", every_minutes: 5 })).isError, true, "bots get a 15 minute floor");
  const made = await bus({ action: "create", name: "训练检查", prompt: "看 train.log 有没有 NaN", every_minutes: 60 });
  assert.equal(made.isError, false, made.text);
  const r = s.routines.list(s.bot.id)[0];
  assert.equal(r.created_by, "bot");
  assert.equal(r.conv_id, conv.id, "results land in the chat where it was asked for");
  const items = (await s.t.api("GET", `/api/conversations/${conv.id}/items`)).body.items;
  assert.ok(items.some((i: any) => i.type === "notice" && /新建了定时任务「训练检查」/.test(i.data.text)));
  assert.match((await bus({ action: "list" })).text, /训练检查.*每 1 小时/);
  for (let i = 0; i < 9; i++) await bus({ action: "create", name: `r${i}`, prompt: "p", every_minutes: 60 });
  assert.equal((await bus({ action: "create", name: "too many", prompt: "p", every_minutes: 60 })).isError, true);
  assert.equal((await bus({ action: "cancel", id: r.id })).isError, false);
  assert.equal(s.routines.get(r.id).enabled, false);
  f.reply();
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${conv.id}/items`)).body.conversation.status === "idle", "idle");
  s.t.close();
});

function cli(base: string, args: string[]) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, BOT_PLATFORM_URL: base } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

test("botctl runs a message to completion, lists Bots, exports, and fails clearly", async () => {
  const s = await setup(true);
  const listed = await cli(s.t.base, ["list"]);
  assert.equal(listed.code, 0);
  assert.match(listed.out, /Watcher\s+codex · gpt-6-luna/);

  const out = join(s.cwd, "out.md");
  const run = await cli(s.t.base, ["run", "Watcher", "总结", "一下", "--json", "--export", out]);
  assert.equal(run.code, 0, run.err);
  const result = JSON.parse(run.out);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.replies, [{ bot: "Watcher", text: "回复：总结 一下" }]);
  assert.equal(result.tokens, 65);
  assert.match(readFileSync(out, "utf8"), /回复：总结 一下/);

  const next = await cli(s.t.base, ["run", "Watcher", "继续", "--conversation", result.conversationId]);
  assert.equal(next.code, 0, next.err);
  assert.equal(next.out.trim(), "回复：继续", "only this round's reply");

  assert.equal((await cli(s.t.base, ["run", "Nobody", "hi"])).code, 3);
  assert.equal((await cli(s.t.base, ["run", "Watcher"])).code, 3);
  const down = await cli("http://127.0.0.1:9", ["list"]);
  assert.equal(down.code, 4);
  assert.match(down.err, /连不上/);
  s.t.close();
});
