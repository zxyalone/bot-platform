import { HttpError } from "./errors.ts";
import { Memory } from "./git.ts";
import type { Store } from "./store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project_info (
  project_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', refs TEXT NOT NULL DEFAULT '', last_seen INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS session_brief (conv_id TEXT PRIMARY KEY, brief TEXT NOT NULL);
`;
const MAX_BRIEF = 4000;
const PROMPT_LIMIT = 6000;

type Row = Record<string, any>;
const text = (v: unknown, cur: string, max: number, label: string) => {
  if (v === undefined) return cur;
  if (typeof v !== "string") throw new HttpError(400, `${label}必须是文本`);
  if (v.length > max) throw new HttpError(413, `${label}不能超过 ${max} 字`);
  return v.trim();
};

// A project is a working directory. This is what the person says about it, plus what the records say happened in it.
export class Projects {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
    store.db.exec(SCHEMA);
  }

  list() {
    const rows = this.store.db
      .prepare(
        `SELECT cwd, SUM(n) bots, SUM(g) groups FROM (
           SELECT cwd, 1 n, 0 g FROM bots WHERE archived=0 UNION ALL SELECT cwd, 0 n, 1 g FROM groups WHERE archived=0
         ) GROUP BY cwd`,
      )
      .all() as Row[];
    return rows
      .map((r) => {
        const id = Memory.projectId(r.cwd);
        const brief = this.brief(id);
        const last = this.store.db.prepare("SELECT MAX(updated_at) n FROM conversations WHERE cwd=? AND kind IN ('direct','group')").get(r.cwd) as Row;
        return { project_id: id, cwd: r.cwd, name: brief.name || (r.cwd as string).split("/").filter(Boolean).slice(-1)[0] || r.cwd, bots: r.bots, groups: r.groups, updated_at: last.n ?? 0 };
      })
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  brief(id: string) {
    const r = this.store.db.prepare("SELECT * FROM project_info WHERE project_id=?").get(id) as Row | undefined;
    return { name: (r?.name as string) ?? "", goal: (r?.goal as string) ?? "", notes: (r?.notes as string) ?? "", references: (r?.refs as string) ?? "", last_seen: (r?.last_seen as number) ?? null };
  }

  saveBrief(id: string, a: any) {
    const cur = this.brief(id);
    const next = { name: text(a?.name, cur.name, 60, "名称"), goal: text(a?.goal, cur.goal, MAX_BRIEF, "目标"), notes: text(a?.notes, cur.notes, MAX_BRIEF, "约束和决定"), references: text(a?.references, cur.references, MAX_BRIEF, "参考资料") };
    this.store.db
      .prepare("INSERT INTO project_info (project_id,name,goal,notes,refs,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET name=excluded.name, goal=excluded.goal, notes=excluded.notes, refs=excluded.refs, updated_at=excluded.updated_at")
      .run(id, next.name, next.goal, next.notes, next.references, Date.now());
    return this.brief(id);
  }

  markSeen(id: string) {
    this.store.db.prepare("INSERT INTO project_info (project_id,last_seen) VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET last_seen=excluded.last_seen").run(id, Date.now());
  }

  // Sent to every Bot working in this project. It is the person's own words, so it is labelled as such.
  promptSection(cwd: string) {
    const b = this.brief(Memory.projectId(cwd));
    const parts = [b.goal && `目标：\n${b.goal}`, b.notes && `约束和当前决定：\n${b.notes}`, b.references && `参考资料：\n${b.references}`].filter(Boolean);
    if (!parts.length) return "";
    return `[用户写的项目说明${b.name ? `：${b.name}` : ""}。工作时以此为准；发现它和实际情况不符时，告诉用户，不要自行修改]\n${parts.join("\n\n").slice(0, PROMPT_LIMIT)}`;
  }

  // A resumed session still remembers the old brief and tends to believe it over a changed system prompt,
  // so an edit is also said out loud, once, in the next message. New sessions read it from the system prompt.
  updateNote(convId: string, current: string, resuming: boolean) {
    const seen = this.store.db.prepare("SELECT brief FROM session_brief WHERE conv_id=?").get(convId) as Row | undefined;
    if ((seen?.brief ?? "") === current && seen) return "";
    this.store.db.prepare("INSERT OR REPLACE INTO session_brief (conv_id, brief) VALUES (?,?)").run(convId, current);
    if (!resuming || (seen?.brief ?? "") === current) return "";
    return current ? `[平台通知，不是用户发的：用户更新了项目说明，之前的说明作废，以下面为准]\n${current}\n\n` : "[平台通知，不是用户发的：用户清空了项目说明，之前的说明作废]\n\n";
  }

  // Only what the records can show. No model is asked, so opening this page costs nothing.
  since(cwd: string, at: number) {
    const db = this.store.db;
    const rounds = db.prepare("SELECT r.status, COUNT(*) n FROM root_turns r JOIN conversations c ON c.id=r.conv_id WHERE c.cwd=? AND r.created_at>=? GROUP BY r.status").all(cwd, at) as Row[];
    const count = (...statuses: string[]) => rounds.filter((r) => statuses.includes(r.status)).reduce((a, r) => a + Number(r.n), 0);
    const one = (sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as Row).n);
    const experiments = (status: string) => (db.prepare("SELECT 1 FROM sqlite_master WHERE name='experiments'").get() ? one(`SELECT COUNT(*) n FROM experiments WHERE project_id=? AND ended_at>=? AND status${status}`, Memory.projectId(cwd), at) : 0);
    return {
      at,
      rounds: count("completed", "failed", "interrupted", "over_budget", "running"),
      failed_rounds: count("failed"),
      stopped_rounds: count("interrupted", "over_budget"),
      failed_tasks: one("SELECT COUNT(*) n FROM calls k JOIN conversations c ON c.id=k.root_conv_id WHERE c.cwd=? AND k.mode='task' AND k.status IN ('failed','timeout') AND k.ended_at>=?", cwd, at),
      done_tasks: one("SELECT COUNT(*) n FROM calls k JOIN conversations c ON c.id=k.root_conv_id WHERE c.cwd=? AND k.mode='task' AND k.status='done' AND k.ended_at>=?", cwd, at),
      files: one("SELECT COUNT(*) n FROM artifacts WHERE project_cwd=? AND kind='file' AND updated_at>=?", cwd, at),
      experiments_done: experiments("='done'"),
      experiments_failed: experiments(" IN ('failed','lost')"),
      tokens: this.store.projectSpent(cwd, at),
    };
  }

  recent(cwd: string) {
    const db = this.store.db;
    return {
      conversations: db.prepare("SELECT id, title, status, updated_at, bot_id, group_id FROM conversations WHERE cwd=? AND kind IN ('direct','group') AND archived=0 ORDER BY updated_at DESC LIMIT 8").all(cwd) as Row[],
      results: (db
        .prepare("SELECT i.id, i.conv_id, i.status, i.data, i.created_at, c.title conv_title, c.bot_id, c.group_id FROM items i JOIN conversations c ON c.id=i.conv_id WHERE c.cwd=? AND c.archived=0 AND i.type='result' ORDER BY i.seq DESC LIMIT 5")
        .all(cwd) as Row[]).map((r) => {
        const d = JSON.parse(r.data);
        return { id: r.id, conv_id: r.conv_id, conv_title: r.conv_title, bot_id: r.bot_id, group_id: r.group_id, status: r.status, at: r.created_at, summary: d.summary ?? "", files: d.total ?? 0, accepted: Boolean(d.accepted), review: d.review ?? null };
      }),
      worktrees: db.prepare("SELECT w.id, w.branch, w.bot_name, w.created_at, w.root_conv_id FROM worktrees w JOIN conversations c ON c.id=w.root_conv_id WHERE c.cwd=? AND w.status='active' ORDER BY w.created_at DESC").all(cwd) as Row[],
    };
  }
}
