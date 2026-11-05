import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import type { Worktree } from "./git.ts";
import type { Bot, Conversation, Effort, Group, Item, PermissionPreset, Route, AgentKind } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL,
  effort TEXT NOT NULL, permission TEXT NOT NULL, route TEXT NOT NULL, cwd TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), title TEXT NOT NULL, agent TEXT NOT NULL,
  route TEXT NOT NULL, cwd TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL DEFAULT 'idle',
  cost_total REAL NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conv_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT, type TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_conv ON items(conv_id, seq);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, budget_tokens INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id), bot_id TEXT NOT NULL REFERENCES bots(id), position INTEGER NOT NULL,
  PRIMARY KEY (group_id, bot_id)
);
CREATE TABLE IF NOT EXISTS root_turns (
  id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, budget INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY, root_turn_id TEXT NOT NULL, root_conv_id TEXT NOT NULL, caller_conv_id TEXT NOT NULL,
  child_conv_id TEXT, parent_call_id TEXT, from_bot TEXT NOT NULL, to_bot TEXT NOT NULL, mode TEXT NOT NULL, depth INTEGER NOT NULL,
  question TEXT NOT NULL, answer TEXT, status TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS calls_root ON calls(root_turn_id, created_at);
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY, root_conv_id TEXT NOT NULL, repo_root TEXT NOT NULL, base_branch TEXT NOT NULL, base_commit TEXT NOT NULL,
  branch TEXT NOT NULL, path TEXT NOT NULL, bot_name TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_log (
  turn_id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, bot_id TEXT NOT NULL, input_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd REAL, created_at INTEGER NOT NULL
);
`;

export const SETTING_DEFAULTS = {
  theme: "dark",
  accent: "indigo",
  font: "medium",
  density: "comfortable",
  width: "normal",
  details_open: true,
  default_agent: "claude",
  default_effort: "medium",
  default_permission: "ask",
  default_budget_bot: 150000,
  default_budget_group: 300000,
  idle_minutes: 10,
  max_depth: 3,
  max_calls: 10,
  max_active: 3,
  max_global_active: 8,
  notify_enabled: true,
  task_timeout_minutes: 30,
  low_quota: 20,
  quota_refresh_minutes: 2,
};
export type AppSettings = typeof SETTING_DEFAULTS;

type Row = Record<string, unknown>;
const toItem = (r: Row): Item => ({ ...(r as unknown as Item), data: JSON.parse(r.data as string) });

export class Store {
  readonly db: DatabaseSync;
  readonly home: string;

  constructor(home: string) {
    this.home = home;
    mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(join(home, "platform.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(SCHEMA);
    this.migrate();
    this.relocate();
  }

  close() {
    this.db.close();
  }

  settings(): AppSettings {
    const saved = this.db.prepare("SELECT key, value FROM app_settings").all() as Row[];
    return { ...SETTING_DEFAULTS, ...Object.fromEntries(saved.filter((r) => (r.key as string) in SETTING_DEFAULTS).map((r) => [r.key, JSON.parse(r.value as string)])) };
  }

  saveSettings(patch: Partial<AppSettings>) {
    for (const [k, v] of Object.entries(patch)) this.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(k, JSON.stringify(v));
    return this.settings();
  }

  // Bots and conversations store absolute paths, so moving the data folder would strand them
  // in a directory that no longer exists. Paths outside the data folder are the user's and stay as they are.
  private relocate() {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key='_home'").get() as Row | undefined;
    const old = row ? (JSON.parse(row.value as string) as string) : this.inferOldHome();
    if (old && old !== this.home) this.movePaths(old);
    this.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('_home', ?)").run(JSON.stringify(this.home));
    // Copying a folder can drop empty directories, and an agent cannot start in one that is missing.
    // Only inside the data folder: a missing directory elsewhere is the user's to deal with.
    for (const t of ["bots", "conversations", "groups"]) {
      for (const r of this.db.prepare(`SELECT DISTINCT cwd FROM ${t} WHERE archived=0`).all() as Row[]) {
        const cwd = String(r.cwd);
        if (cwd.startsWith(`${this.home}/workspaces/`) && !existsSync(cwd)) mkdirSync(cwd, { recursive: true });
      }
    }
  }

  // Databases from before this was recorded: a Bot's default directory reveals where the data lived.
  private inferOldHome() {
    for (const r of this.db.prepare("SELECT cwd FROM bots").all() as Row[]) {
      const m = String(r.cwd).match(/^(.*)\/workspaces\/[^/]+$/);
      if (m && m[1] !== this.home && basename(m[1]) === ".data") return m[1];
    }
    return null;
  }

  private movePaths(old: string) {
    const hasTable = (t: string) => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
    const inOld = (p: string) => p === old || p.startsWith(`${old}/`);
    const moved = (p: string) => this.home + p.slice(old.length);
    const projectId = (cwd: string) => createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    const cwds = new Set<string>();
    for (const t of ["bots", "conversations", "groups"]) for (const r of this.db.prepare(`SELECT DISTINCT cwd FROM ${t}`).all() as Row[]) if (inOld(String(r.cwd))) cwds.add(String(r.cwd));

    this.db.exec("BEGIN");
    try {
      // Claude Code files its sessions under the directory they started in, so these cannot resume from the new one.
      this.db.prepare("UPDATE conversations SET session_id=NULL WHERE agent='claude' AND (cwd=? OR substr(cwd,1,?)=?)").run(old, old.length + 1, `${old}/`);
      const targets: [string, string][] = [["bots", "cwd"], ["conversations", "cwd"], ["groups", "cwd"], ["worktrees", "path"], ["experiments", "cwd"], ["jobs", "dir"], ["artifacts", "path"], ["artifacts", "root"], ["artifacts", "project_cwd"]];
      for (const [t, c] of targets) {
        if (!hasTable(t)) continue;
        this.db.prepare(`UPDATE ${t} SET ${c} = ? || substr(${c}, ?) WHERE ${c} = ? OR substr(${c}, 1, ?) = ?`).run(this.home, old.length + 1, old, old.length + 1, `${old}/`);
      }
      // Project memory and experiments are keyed by a hash of the directory, which just changed.
      for (const cwd of cwds) {
        const from = projectId(cwd);
        const to = projectId(moved(cwd));
        for (const t of ["ideas", "experiments", "project_settings"]) if (hasTable(t)) this.db.prepare(`UPDATE OR IGNORE ${t} SET project_id=? WHERE project_id=?`).run(to, from);
        const dir = join(this.home, "memory", "projects");
        if (existsSync(join(dir, from)) && !existsSync(join(dir, to))) renameSync(join(dir, from), join(dir, to));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private migrate() {
    const has = (t: string, c: string) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as Row[]).some((r) => r.name === c);
    if (!has("bots", "budget_tokens")) this.db.exec("ALTER TABLE bots ADD COLUMN budget_tokens INTEGER NOT NULL DEFAULT 150000");
    if (!has("bots", "can_call")) this.db.exec("ALTER TABLE bots ADD COLUMN can_call TEXT");
    if (!has("bots", "is_chief")) this.db.exec("ALTER TABLE bots ADD COLUMN is_chief INTEGER NOT NULL DEFAULT 0");
    if (!has("bots", "paused")) this.db.exec("ALTER TABLE bots ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
    for (const [c, type] of [["reason", "TEXT"], ["chain", "TEXT"], ["depends_on", "TEXT"], ["retry_of", "TEXT"], ["timeout_ms", "INTEGER"]]) if (!has("calls", c)) this.db.exec(`ALTER TABLE calls ADD COLUMN ${c} ${type}`);
    this.db.exec("CREATE INDEX IF NOT EXISTS calls_task ON calls(root_conv_id, mode, created_at); CREATE INDEX IF NOT EXISTS calls_retry ON calls(retry_of);");
    if (has("conversations", "kind")) return;
    // bot_id must become nullable for group conversations, which SQLite can only do by rebuilding the table.
    this.db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE conversations_new (
        id TEXT PRIMARY KEY, bot_id TEXT REFERENCES bots(id), group_id TEXT REFERENCES groups(id), parent_conv_id TEXT,
        kind TEXT NOT NULL DEFAULT 'direct', last_seq INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, agent TEXT NOT NULL,
        route TEXT NOT NULL, cwd TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL DEFAULT 'idle',
        cost_total REAL NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO conversations_new (id,bot_id,title,agent,route,cwd,session_id,status,cost_total,archived,created_at,updated_at)
        SELECT id,bot_id,title,agent,route,cwd,session_id,status,cost_total,archived,created_at,updated_at FROM conversations;
      DROP TABLE conversations;
      ALTER TABLE conversations_new RENAME TO conversations;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
  }

  defaultCwd(botId: string) {
    const dir = join(this.home, "workspaces", botId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  listBots(): Bot[] {
    return this.db.prepare("SELECT * FROM bots WHERE archived=0 ORDER BY is_chief DESC, created_at, name").all() as unknown as Bot[];
  }

  getBot(id: string): Bot | undefined {
    return this.db.prepare("SELECT * FROM bots WHERE id=? AND archived=0").get(id) as unknown as Bot | undefined;
  }

  createBot(input: { name: string; role: string; agent: AgentKind; model: string; effort: Effort; permission: PermissionPreset; route: Route; cwd?: string; budget_tokens?: number; can_call?: string | null; is_chief?: number }): Bot {
    const id = randomUUID();
    const now = Date.now();
    const cwd = input.cwd || this.defaultCwd(id);
    this.db
      .prepare("INSERT INTO bots (id,name,role,agent,model,effort,permission,route,cwd,budget_tokens,can_call,is_chief,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.name, input.role, input.agent, input.model, input.effort, input.permission, input.route, cwd, input.budget_tokens ?? this.settings().default_budget_bot, input.can_call ?? null, input.is_chief ?? 0, now, now);
    return this.getBot(id)!;
  }

  updateBot(id: string, patch: Partial<Pick<Bot, "name" | "role" | "agent" | "model" | "effort" | "permission" | "route" | "cwd" | "budget_tokens" | "can_call" | "paused">>): Bot | undefined {
    const bot = this.getBot(id);
    if (!bot) return undefined;
    const next = { ...bot, ...patch, updated_at: Date.now() };
    this.db
      .prepare("UPDATE bots SET name=?,role=?,agent=?,model=?,effort=?,permission=?,route=?,cwd=?,budget_tokens=?,can_call=?,paused=?,updated_at=? WHERE id=?")
      .run(next.name, next.role, next.agent, next.model, next.effort, next.permission, next.route, next.cwd, next.budget_tokens, next.can_call, next.paused, next.updated_at, id);
    return this.getBot(id);
  }

  archiveBot(id: string) {
    this.db.prepare("UPDATE bots SET archived=1, updated_at=? WHERE id=?").run(Date.now(), id);
  }

  listConversations(botId: string): Conversation[] {
    return this.db.prepare("SELECT * FROM conversations WHERE bot_id=? AND kind='direct' AND archived=0 ORDER BY updated_at DESC").all(botId) as unknown as Conversation[];
  }

  getConversation(id: string): Conversation | undefined {
    return this.db.prepare("SELECT * FROM conversations WHERE id=? AND archived=0").get(id) as unknown as Conversation | undefined;
  }

  // The agent, route and working directory are fixed per conversation: an agent's session
  // only exists on the backend and in the directory it was started with.
  createConversation(bot: Bot, title: string): Conversation {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO conversations (id,bot_id,title,agent,route,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, bot.id, title, bot.agent, bot.route, bot.cwd, now, now);
    return this.getConversation(id)!;
  }

  // Hidden conversation holding one Bot's agent session inside a group chat or a call.
  findChild(kind: "member" | "call", parentId: string, botId: string, cwd?: string): Conversation | undefined {
    const rows = this.db.prepare("SELECT * FROM conversations WHERE kind=? AND parent_conv_id=? AND bot_id=? AND archived=0 ORDER BY created_at DESC").all(kind, parentId, botId) as unknown as Conversation[];
    return rows.find((c) => !cwd || c.cwd === cwd);
  }

  chief(): Bot | undefined {
    return this.db.prepare("SELECT * FROM bots WHERE is_chief=1 AND archived=0").get() as unknown as Bot | undefined;
  }

  addWorktree(w: { id: string; rootConvId: string; repoRoot: string; baseBranch: string; baseCommit: string; branch: string; path: string; botName: string }): Worktree {
    this.db
      .prepare("INSERT INTO worktrees (id,root_conv_id,repo_root,base_branch,base_commit,branch,path,bot_name,status,created_at) VALUES (?,?,?,?,?,?,?,?,'active',?)")
      .run(w.id, w.rootConvId, w.repoRoot, w.baseBranch, w.baseCommit, w.branch, w.path, w.botName, Date.now());
    return this.getWorktree(w.id)!;
  }

  getWorktree(id: string): Worktree | undefined {
    return this.db.prepare("SELECT * FROM worktrees WHERE id=?").get(id) as unknown as Worktree | undefined;
  }

  listWorktrees(rootConvId: string): Worktree[] {
    return this.db.prepare("SELECT * FROM worktrees WHERE root_conv_id=? ORDER BY created_at").all(rootConvId) as unknown as Worktree[];
  }

  setWorktreeStatus(id: string, status: Worktree["status"]) {
    this.db.prepare("UPDATE worktrees SET status=? WHERE id=?").run(status, id);
  }

  createChild(kind: "member" | "call", parentId: string, bot: Bot, cwd: string, title: string): Conversation {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO conversations (id,bot_id,parent_conv_id,kind,title,agent,route,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, bot.id, parentId, kind, title, bot.agent, bot.route, cwd, now, now);
    return this.getConversation(id)!;
  }

  listGroups(): Group[] {
    return this.db.prepare("SELECT * FROM groups WHERE archived=0 ORDER BY created_at").all() as unknown as Group[];
  }

  getGroup(id: string): Group | undefined {
    return this.db.prepare("SELECT * FROM groups WHERE id=? AND archived=0").get(id) as unknown as Group | undefined;
  }

  groupMembers(groupId: string): Bot[] {
    return this.db.prepare("SELECT b.* FROM group_members m JOIN bots b ON b.id=m.bot_id WHERE m.group_id=? AND b.archived=0 ORDER BY m.position").all(groupId) as unknown as Bot[];
  }

  setGroupMembers(groupId: string, botIds: string[]) {
    this.db.prepare("DELETE FROM group_members WHERE group_id=?").run(groupId);
    botIds.forEach((b, i) => this.db.prepare("INSERT INTO group_members (group_id,bot_id,position) VALUES (?,?,?)").run(groupId, b, i));
  }

  createGroup(input: { name: string; cwd?: string; budget_tokens?: number; members: string[] }): Group {
    const id = randomUUID();
    const now = Date.now();
    const cwd = input.cwd || this.defaultCwd(`group-${id}`);
    this.db.prepare("INSERT INTO groups (id,name,cwd,budget_tokens,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, input.name, cwd, input.budget_tokens ?? this.settings().default_budget_group, now, now);
    this.setGroupMembers(id, input.members);
    return this.getGroup(id)!;
  }

  updateGroup(id: string, patch: { name?: string; cwd?: string; budget_tokens?: number; members?: string[] }): Group | undefined {
    const g = this.getGroup(id);
    if (!g) return undefined;
    this.db.prepare("UPDATE groups SET name=?,cwd=?,budget_tokens=?,updated_at=? WHERE id=?").run(patch.name ?? g.name, patch.cwd || g.cwd, patch.budget_tokens ?? g.budget_tokens, Date.now(), id);
    if (patch.members) this.setGroupMembers(id, patch.members);
    return this.getGroup(id);
  }

  archiveGroup(id: string) {
    this.db.prepare("UPDATE groups SET archived=1, updated_at=? WHERE id=?").run(Date.now(), id);
  }

  listGroupConversations(groupId: string): Conversation[] {
    return this.db.prepare("SELECT * FROM conversations WHERE group_id=? AND kind='group' AND archived=0 ORDER BY updated_at DESC").all(groupId) as unknown as Conversation[];
  }

  createGroupConversation(g: Group, title: string): Conversation {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare("INSERT INTO conversations (id,group_id,kind,title,agent,route,cwd,created_at,updated_at) VALUES (?,?,'group',?,'','',?,?,?)").run(id, g.id, title, g.cwd, now, now);
    return this.getConversation(id)!;
  }

  createRootTurn(id: string, convId: string, budget: number) {
    this.db.prepare("INSERT INTO root_turns (id,conv_id,budget,status,created_at) VALUES (?,?,?,'running',?)").run(id, convId, budget, Date.now());
  }

  // Written as it is spent, so a crash mid-round cannot make a project look cheaper than it was.
  setRootSpent(id: string, spent: number) {
    this.db.prepare("UPDATE root_turns SET spent=? WHERE id=?").run(spent, id);
  }

  projectSpent(cwd: string, since: number) {
    return Number((this.db.prepare("SELECT COALESCE(SUM(r.spent),0) n FROM root_turns r JOIN conversations c ON c.id=r.conv_id WHERE c.cwd=? AND r.created_at>=?").get(cwd, since) as Row).n);
  }

  projectSpending(cwd: string) {
    return {
      conversations: this.db.prepare("SELECT c.id, c.title, c.bot_id, c.group_id, SUM(r.spent) tokens FROM root_turns r JOIN conversations c ON c.id=r.conv_id WHERE c.cwd=? GROUP BY c.id HAVING tokens>0 ORDER BY tokens DESC LIMIT 5").all(cwd) as Row[],
      calls: this.db.prepare("SELECT k.id, k.to_bot, k.question, k.tokens, k.status, k.mode FROM calls k JOIN conversations c ON c.id=k.root_conv_id WHERE c.cwd=? AND k.tokens>0 ORDER BY k.tokens DESC LIMIT 5").all(cwd) as Row[],
    };
  }

  updateRootTurn(id: string, spent: number, status: string) {
    this.db.prepare("UPDATE root_turns SET spent=?, status=? WHERE id=?").run(spent, status, id);
  }

  latestRootTurn(convId: string) {
    return this.db.prepare("SELECT * FROM root_turns WHERE conv_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(convId) as Row | undefined;
  }

  addCall(c: { id: string; rootTurnId: string; rootConvId: string; callerConvId: string; childConvId: string | null; parentCallId: string | null; from: string; to: string; mode: string; depth: number; question: string; status: string; answer?: string; reason?: string; chain?: string[]; dependsOn?: string[]; retryOf?: string; timeoutMs?: number }) {
    this.db
      .prepare("INSERT INTO calls (id,root_turn_id,root_conv_id,caller_conv_id,child_conv_id,parent_call_id,from_bot,to_bot,mode,depth,question,answer,status,reason,chain,depends_on,retry_of,timeout_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(c.id, c.rootTurnId, c.rootConvId, c.callerConvId, c.childConvId, c.parentCallId, c.from, c.to, c.mode, c.depth, c.question, c.answer ?? null, c.status, c.reason ?? null, c.chain ? JSON.stringify(c.chain) : null, c.dependsOn?.length ? JSON.stringify(c.dependsOn) : null, c.retryOf ?? null, c.timeoutMs ?? null, Date.now());
  }

  startCall(id: string) {
    this.db.prepare("UPDATE calls SET status='running' WHERE id=?").run(id);
  }

  finishCall(id: string, status: string, answer: string, tokens: number, reason: string | null = null) {
    this.db.prepare("UPDATE calls SET status=?, answer=?, tokens=?, reason=?, ended_at=? WHERE id=?").run(status, answer, tokens, reason, Date.now(), id);
  }

  getCall(id: string) {
    return this.db.prepare("SELECT * FROM calls WHERE id=?").get(id) as Row | undefined;
  }

  // A retry is a new row, so each attempt stays accounted to the round that paid for it.
  latestAttempt(id: string) {
    let cur = this.getCall(id);
    for (let next = cur; next; next = this.db.prepare("SELECT * FROM calls WHERE retry_of=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(next.id as string) as Row | undefined) cur = next;
    return cur;
  }

  attemptNumber(id: string) {
    let n = 1;
    for (let cur = this.getCall(id); cur?.retry_of; cur = this.getCall(cur.retry_of as string)) n++;
    return n;
  }

  listTasks(convId: string | null, limit: number) {
    const where = convId ? "AND c.root_conv_id=?" : "";
    return this.db.prepare(`SELECT c.*, v.title conv_title, v.kind conv_kind, v.bot_id conv_bot_id, v.group_id conv_group_id FROM calls c JOIN conversations v ON v.id=c.root_conv_id WHERE c.mode='task' AND v.archived=0 ${where} ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?`).all(...(convId ? [convId, limit] : [limit])) as Row[];
  }

  listCalls(rootTurnId: string) {
    return this.db.prepare("SELECT * FROM calls WHERE root_turn_id=? ORDER BY created_at, rowid").all(rootTurnId) as Row[];
  }

  updateConversation(id: string, patch: Partial<Pick<Conversation, "title" | "session_id" | "status" | "cost_total" | "archived" | "last_seq">>) {
    for (const [k, v] of Object.entries(patch)) {
      if (!["title", "session_id", "status", "cost_total", "archived", "last_seq"].includes(k)) throw new Error(`bad field ${k}`);
      this.db.prepare(`UPDATE conversations SET ${k}=?, updated_at=? WHERE id=?`).run(v as string, Date.now(), id);
    }
  }

  // Only conversations the sidebar can still open: archiving a Bot or group leaves its conversations unmarked.
  listInbox(limit: number) {
    return this.db
      .prepare(
        `SELECT i.id, i.seq, i.type, i.data, i.conv_id, i.created_at, v.title conv_title, v.bot_id, v.group_id,
                (SELECT MAX(r.seq) FROM items r WHERE r.conv_id=i.conv_id AND r.type='result') latest_result
         FROM items i JOIN conversations v ON v.id=i.conv_id
         LEFT JOIN bots b ON b.id=v.bot_id LEFT JOIN groups g ON g.id=v.group_id
         WHERE v.archived=0 AND ((v.kind='direct' AND b.archived=0) OR (v.kind='group' AND g.archived=0))
           AND ((i.type='approval' AND i.status='pending') OR (i.type='queued' AND i.status='unsent') OR (i.type='result' AND COALESCE(json_extract(i.data, '$.accepted'), 0)=0 AND COALESCE(json_extract(i.data, '$.review'), '')!='dismissed'))
         ORDER BY i.created_at DESC, i.seq DESC LIMIT ?`,
      )
      .all(limit) as Row[];
  }

  listItems(convId: string): Item[] {
    return (this.db.prepare("SELECT * FROM items WHERE conv_id=? ORDER BY seq").all(convId) as Row[]).map(toItem);
  }

  getItem(id: string): Item | undefined {
    const r = this.db.prepare("SELECT * FROM items WHERE id=?").get(id) as Row | undefined;
    return r ? toItem(r) : undefined;
  }

  addItem(i: { convId: string; turnId: string | null; type: Item["type"]; status: string; data: Record<string, unknown> }): Item {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO items (id,conv_id,turn_id,type,status,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, i.convId, i.turnId, i.type, i.status, JSON.stringify(i.data), now, now);
    return this.getItem(id)!;
  }

  updateItem(id: string, patch: { status?: string; data?: Record<string, unknown> }): Item {
    const cur = this.getItem(id);
    if (!cur) throw new Error(`no item ${id}`);
    this.db
      .prepare("UPDATE items SET status=?, data=?, updated_at=? WHERE id=?")
      .run(patch.status ?? cur.status, JSON.stringify(patch.data ?? cur.data), Date.now(), id);
    return this.getItem(id)!;
  }

  logUsage(u: { turnId: string; convId: string; botId: string; inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number | null }) {
    this.db
      .prepare("INSERT OR REPLACE INTO usage_log (turn_id,conv_id,bot_id,input_tokens,cached_tokens,output_tokens,cost_usd,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(u.turnId, u.convId, u.botId, u.inputTokens, u.cachedTokens, u.outputTokens, u.costUsd, Date.now());
  }

  botUsage(botId: string) {
    return this.db
      .prepare("SELECT COUNT(*) turns, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(cached_tokens),0) cached_tokens, COALESCE(SUM(output_tokens),0) output_tokens, SUM(cost_usd) cost_usd FROM usage_log WHERE bot_id=?")
      .get(botId) as Row;
  }

  // A daemon crash leaves in-flight state behind; the agent processes died with it.
  recover(): string[] {
    const stuck = (this.db.prepare("SELECT id FROM conversations WHERE status='running'").all() as Row[]).map((r) => r.id as string);
    const now = Date.now();
    this.db.prepare("UPDATE items SET status='interrupted', updated_at=? WHERE status='streaming' OR (type='tool' AND status='running')").run(now);
    this.db.prepare("UPDATE items SET status='expired', updated_at=? WHERE type='approval' AND status='pending'").run(now);
    this.db.prepare("UPDATE conversations SET status='idle' WHERE status='running'").run();
    // Nothing can pick these up: the agent working on them is gone. A person can retry a task, which resumes its session.
    const reason = "守护进程重启时还没结束，agent 进程已随之退出，不会再继续";
    this.db.prepare("UPDATE calls SET status='interrupted', reason=?, answer=COALESCE(answer, ?), ended_at=? WHERE status IN ('running','waiting')").run(reason, reason, now);
    this.db.prepare("UPDATE items SET status='interrupted', data=json_set(data, '$.answer', ?), updated_at=? WHERE type='call' AND status IN ('running','waiting')").run(reason, now);
    this.db.prepare("UPDATE root_turns SET status='interrupted' WHERE status='running'").run();
    this.db.prepare("UPDATE items SET status='unsent', data=json_set(data, '$.reason', ?), updated_at=? WHERE type='queued' AND status='queued'").run("守护进程重启了，这条没有发出", now);
    const visible = (this.db.prepare("SELECT id FROM conversations WHERE kind IN ('direct','group')").all() as Row[]).map((r) => r.id as string);
    return stuck.filter((id) => visible.includes(id));
  }
}

const CHIEF_ROLE_V1_HEAD = "你是团队的主 Bot Chief：理解用户的需求，拆解任务，调度其他 Bot，再汇总结果。你不亲自写代码或改文件。";
const CHIEF_ROLE_HEAD = "你是团队的主 Bot Chief：理解用户的需求，拆解任务，调度其他 Bot，再汇总结果。任务不限类型，可以是写代码、调研、写作、分析或别的事。你不亲自改文件。";

export const CHIEF_ROLE = `${CHIEF_ROLE_HEAD}

做法：
1. 先用 list_bots 看团队里有谁。小事直接自己回答。
2. 一个 Bot 能做完的事就用 ask_bot 交给最合适的那个；能并行的用 assign_task，结束前必须用 get_task 取回结果。
3. 对方看不到用户的原话，问题里要写清背景、要求和需要的结论。
4. 写代码的任务传 isolated: true，让它在独立的 Git 工作树里做（要求工作目录是 Git 仓库）。不要要求对方提交，用户验收后平台会统一提交。之后请别人审查时，用 workspace 指向这个工作树的路径。
5. 对方可能会误报完成。回答末尾有平台检查的“实际改动”，以它为准：如果显示没有改动，就是没做成，要重新明确要求一次；还不行就如实告诉用户。
6. 现有 Bot 确实胜任不了时才用 create_bot，用户批准后才生效。
7. 省额度：不要为了流程多拉人，不要重复问同一件事。

最后用简短的话汇报：做了什么、结论是什么、改动在哪个分支、哪些事需要用户决定。不要替用户合并改动。`;

const ENGINEER_V1 = "你是团队的工程师 Engineer，负责实现分割模型相关代码。先读懂现有代码再动手，改动要小，并说明如何验证。";
const REVIEWER_V1 = "你是团队的审查员 Reviewer，负责审查代码。重点检查损失函数、指标、数据加载和后处理，只报告有依据的问题。";
const ENGINEER_ROLE = "你是团队的工程师 Engineer，负责写代码和改代码。先读懂现有代码再动手，改动要小，并说明如何验证。";
const REVIEWER_ROLE = "你是团队的审查员 Reviewer，负责审查别人的成果。重点找会出错的地方，只报告有依据的问题。";

// The first seeds were written for one kind of project. Text the user has edited is left alone.
function upgradeSeedRoles(store: Store) {
  const old: [string, string][] = [[ENGINEER_V1, ENGINEER_ROLE], [REVIEWER_V1, REVIEWER_ROLE], [CHIEF_ROLE.replace(CHIEF_ROLE_HEAD, CHIEF_ROLE_V1_HEAD), CHIEF_ROLE]];
  for (const b of store.listBots()) {
    const hit = old.find(([from]) => from === b.role);
    if (hit) store.updateBot(b.id, { role: hit[1] });
  }
}

export function ensureChief(store: Store) {
  if (store.chief()) return;
  store.createBot({ name: "Chief", role: CHIEF_ROLE, agent: "claude", model: "claude-opus-5-5", effort: "medium", permission: "read_only", route: "official", budget_tokens: 300000, is_chief: 1 });
}

export function ensureSeedBots(store: Store) {
  ensureChief(store);
  upgradeSeedRoles(store);
  if (store.listBots().length > 1) return;
  store.createBot({
    name: "Engineer",
    role: ENGINEER_ROLE,
    agent: "codex",
    model: "gpt-6.1-terra",
    effort: "medium",
    permission: "ask",
    route: "official",
  });
  store.createBot({
    name: "Reviewer",
    role: REVIEWER_ROLE,
    agent: "claude",
    model: "claude-sonnet-5-5",
    effort: "medium",
    permission: "ask",
    route: "official",
  });
}
