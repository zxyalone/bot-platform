import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { Memory } from "../../src/daemon/git.ts";
import { ensureChief, ensureSeedBots, Store } from "../../src/daemon/store.ts";
import type { AgentEvent, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

class Fake implements AgentRuntime {
  sent: string[] = [];
  opts: RuntimeOptions;
  stopped = 0;
  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }
  emit(e: AgentEvent) {
    this.opts.onEvent(e);
  }
  reply(text: string) {
    this.emit({ type: "text_done", key: `k${Math.random()}`, text });
    this.emit({ type: "turn_end", status: "completed" });
  }
  async start() {}
  async send(t: string) {
    this.sent.push(t);
  }
  async interrupt() {
    this.emit({ type: "turn_end", status: "interrupted" });
  }
  answerApproval(_: string, __: ApprovalDecision) {}
  stop() {
    this.stopped++;
  }
}

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "bot-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.name", "t");
  gitIn(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "a.txt"), "one\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function setup(cwd?: string) {
  const home = tempHome();
  const seed = new Store(home);
  ensureChief(seed);
  const chiefId = seed.chief()!.id;
  if (cwd) seed.updateBot(chiefId, { cwd });
  seed.close();
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  }, { home });
  const eng = (await t.api("POST", "/api/bots", { name: "Eng", role: "ROLE-Eng", agent: "codex", model: "gpt-6-luna" })).body;
  const start = async (text = "做") => {
    const convId = (await t.api("POST", `/api/bots/${chiefId}/messages`, { text })).body.id as string;
    await t.waitFor(() => made[0]?.sent.length, "chief runs");
    return convId;
  };
  const bus = (f: Fake, tool: string, args: unknown) =>
    fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()).catch(() => ({ text: "closed", isError: true })) as Promise<{ text: string; isError: boolean }>;
  const items = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];
  const proposal = async (id: string) => t.waitFor(async () => (await items(id)).find((i) => i.data.kind === "bot_proposal" && i.status === "pending"), "proposal") as Promise<any>;
  const callee = (n: string) => made.find((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`));
  const finish = async (id: string) => {
    made[0].reply("好了");
    await t.waitFor(async () => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation.status === "idle", "idle");
  };
  return { t, made, chiefId, eng, start, bus, items, proposal, callee, finish, home };
}

const spec = { name: "Scholar", role: "读论文", agent: "claude", model: "claude-sonnet-5-5", permission: "read_only", budget_tokens: 50000 };

test("moving the data folder updates stored paths, keeps the user's own, and carries project data along", () => {
  const parent = mkdtempSync(join(tmpdir(), "bot-move-"));
  const oldHome = join(parent, "old", ".data");
  const newHome = join(parent, "new", ".data");
  const elsewhere = mkdtempSync(join(tmpdir(), "bot-userdir-"));
  const base = { agent: "claude" as const, model: "m", effort: "low" as const, permission: "ask" as const, route: "official" as const };
  const a = new Store(oldHome);
  const inside = a.createBot({ ...base, name: "Inside", role: "" });
  const outside = a.createBot({ ...base, name: "Outside", role: "", cwd: elsewhere });
  const conv = a.createConversation(inside, "t");
  a.updateConversation(conv.id, { session_id: "s" });
  const codexBot = a.createBot({ ...base, name: "Cx", role: "", agent: "codex" });
  const codexConv = a.createConversation(codexBot, "t");
  a.updateConversation(codexConv.id, { session_id: "keep" });
  const outConv = a.createConversation(outside, "t");
  a.updateConversation(outConv.id, { session_id: "keep-too" });
  a.db.exec("CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT PRIMARY KEY, test_dir TEXT NOT NULL DEFAULT '', final_eval_command TEXT NOT NULL DEFAULT '', auto_wake INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 0)");
  a.db.prepare("INSERT INTO project_settings (project_id, enabled) VALUES (?, 1)").run(Memory.projectId(inside.cwd));
  const mem = join(oldHome, "memory", "projects", Memory.projectId(inside.cwd));
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, "MEMORY.md"), "- 项目笔记");
  a.close();
  mkdirSync(join(parent, "new"));
  renameSync(oldHome, newHome);

  const b = new Store(newHome);
  const moved = b.getBot(inside.id)!;
  assert.ok(moved.cwd.startsWith(newHome), moved.cwd);
  assert.equal(b.getBot(outside.id)!.cwd, elsewhere, "the user's own directory is untouched");
  const c = b.getConversation(conv.id)!;
  assert.ok(c.cwd.startsWith(newHome));
  assert.equal(c.session_id, null, "a Claude session cannot follow the move");
  assert.equal(b.getConversation(codexConv.id)!.session_id, "keep");
  assert.equal(b.getConversation(outConv.id)!.session_id, "keep-too", "nothing moved, so it still resumes");
  assert.equal(readFileSync(join(newHome, "memory", "projects", Memory.projectId(moved.cwd), "MEMORY.md"), "utf8"), "- 项目笔记");
  assert.equal((b.db.prepare("SELECT enabled FROM project_settings WHERE project_id=?").get(Memory.projectId(moved.cwd)) as any).enabled, 1);
  b.close();
  const again = new Store(newHome);
  assert.equal(again.getBot(inside.id)!.cwd, moved.cwd, "a second start changes nothing");
  again.close();
});

test("a database from before the location was recorded is still repaired", () => {
  const parent = mkdtempSync(join(tmpdir(), "bot-move-"));
  const oldHome = join(parent, "old", ".data");
  const newHome = join(parent, "new", ".data");
  const a = new Store(oldHome);
  const bot = a.createBot({ agent: "codex", model: "m", effort: "low", permission: "ask", route: "official", name: "X", role: "" });
  a.db.exec("DELETE FROM app_settings WHERE key='_home'");
  a.close();
  mkdirSync(join(parent, "new"));
  renameSync(oldHome, newHome);
  const b = new Store(newHome);
  assert.ok(b.getBot(bot.id)!.cwd.startsWith(newHome));
  b.close();
});

test("Chief is created once, listed first, and cannot be archived", async () => {
  const home = tempHome();
  const s = new Store(home);
  ensureSeedBots(s);
  ensureSeedBots(s);
  assert.deepEqual(s.listBots().map((b) => b.name), ["Chief", "Engineer", "Reviewer"]);
  assert.equal(s.chief()!.permission, "read_only");
  s.close();
  const c = await setup();
  assert.equal((await c.t.api("DELETE", `/api/bots/${c.chiefId}`)).status, 400);
  c.t.close();
});

test("only Chief gets the management tools, and the bus rejects anyone else", async () => {
  const c = await setup();
  const conv = await c.start();
  const chief = c.made[0];
  assert.match(chief.opts.bus!.env.BUS_TOOLS, /create_bot/);
  void c.bus(chief, "ask_bot", { bot: "Eng", question: "x" });
  await c.t.waitFor(() => c.callee("Eng")?.sent.length, "eng");
  const eng = c.callee("Eng")!;
  assert.doesNotMatch(eng.opts.bus!.env.BUS_TOOLS, /create_bot/);
  const r = await c.bus(eng, "create_bot", spec);
  assert.equal(r.isError, true);
  assert.match(r.text, /只有 Chief/);
  assert.ok(conv);
  c.t.close();
});

test("a proposal changes nothing until approved, then creates the Bot", async () => {
  const c = await setup();
  const conv = await c.start();
  const pending = c.bus(c.made[0], "create_bot", spec);
  const card = await c.proposal(conv);
  assert.match(card.data.detail, /只读/);
  assert.equal((await c.t.api("GET", "/api/state")).body.bots.some((b: any) => b.name === "Scholar"), false);
  await c.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" });
  assert.match((await pending).text, /已创建/);
  const bot = (await c.t.api("GET", "/api/state")).body.bots.find((b: any) => b.name === "Scholar");
  assert.deepEqual([bot.permission, bot.budget_tokens], ["read_only", 50000]);
  c.t.close();
});

test("the user can deny a proposal or change it before approving", async () => {
  const c = await setup();
  const conv = await c.start();
  let pending = c.bus(c.made[0], "create_bot", spec);
  let card = await c.proposal(conv);
  await c.t.api("POST", `/api/approvals/${card.id}`, { decision: "deny" });
  assert.match((await pending).text, /拒绝/);
  assert.equal((await c.t.api("GET", "/api/state")).body.bots.some((b: any) => b.name === "Scholar"), false);

  pending = c.bus(c.made[0], "create_bot", spec);
  card = await c.proposal(conv);
  assert.equal((await c.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow_session" })).status, 400);
  assert.equal((await c.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow", spec: { ...spec, model: "--bad" } })).status, 400, "a bad edit is refused and the card stays open");
  await c.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow", spec: { ...spec, name: "Scholar2", budget_tokens: 2000, cwd: "/etc" } });
  await pending;
  const bot = (await c.t.api("GET", "/api/state")).body.bots.find((b: any) => b.name === "Scholar2");
  assert.equal(bot.budget_tokens, 2000);
  assert.notEqual(bot.cwd, "/etc", "a proposal cannot set a working directory");
  c.t.close();
});

test("bad proposals are refused before reaching the user", async () => {
  const c = await setup();
  const conv = await c.start();
  const chief = c.made[0];
  assert.match((await c.bus(chief, "create_bot", { ...spec, model: "gpt-6-luna" })).text, /不属于/);
  assert.match((await c.bus(chief, "create_bot", { name: "NoModel", role: "x", agent: "claude" })).text, /必须指定 model/);
  assert.match((await c.bus(chief, "create_bot", { ...spec, name: "eng" })).text, /已经有/);
  assert.match((await c.bus(chief, "update_bot", { bot: "Chief", role: "x" })).text, /不能修改/);
  assert.match((await c.bus(chief, "pause_bot", { bot: "Chief" })).text, /不能修改/);
  assert.match((await c.bus(chief, "update_bot", { bot: "Nobody" })).text, /没有叫/);
  assert.equal((await c.items(conv)).some((i) => i.data.kind === "bot_proposal"), false);
  c.t.close();
});

test("a proposal still open when the turn ends expires and tells the caller", async () => {
  const c = await setup();
  const conv = await c.start();
  const pending = c.bus(c.made[0], "create_bot", spec);
  const card = await c.proposal(conv);
  await c.t.api("POST", `/api/conversations/${conv}/interrupt`, {});
  assert.match((await pending).text, /失效/);
  assert.equal((await c.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" })).status, 409);
  c.t.close();
});

test("update_bot goes through approval, and a paused Bot cannot be called until the user resumes it", async () => {
  const c = await setup();
  const conv = await c.start();
  const chief = c.made[0];
  const pending = c.bus(chief, "update_bot", { bot: "Eng", model: "gpt-6.1-terra" });
  const card = await c.proposal(conv);
  assert.equal((await c.t.api("GET", "/api/state")).body.bots.find((b: any) => b.name === "Eng").model, "gpt-6-luna");
  await c.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" });
  await pending;
  assert.equal((await c.t.api("GET", "/api/state")).body.bots.find((b: any) => b.name === "Eng").model, "gpt-6.1-terra");

  await c.bus(chief, "pause_bot", { bot: "Eng" });
  assert.match((await c.bus(chief, "ask_bot", { bot: "Eng", question: "x" })).text, /暂停/);
  await c.t.api("PATCH", `/api/bots/${c.eng.id}`, { paused: false });
  void c.bus(chief, "ask_bot", { bot: "Eng", question: "x" });
  await c.t.waitFor(() => c.callee("Eng")?.sent.length, "resumed");
  c.t.close();
});

test("a group message with no mention goes to Chief when Chief is a member", async () => {
  const c = await setup();
  const g = (await c.t.api("POST", "/api/groups", { name: "g", members: [c.chiefId, c.eng.id] })).body;
  assert.equal((await c.t.api("POST", `/api/groups/${g.id}/messages`, { text: "帮我看看" })).status, 202);
  await c.t.waitFor(() => c.made[0]?.sent.length, "chief runs");
  assert.match(c.made[0].opts.systemPrompt, /主 Bot Chief/);
  c.t.close();
});

test("memory: Bots add notes, later agents read them as reference, and history can be rolled back", async () => {
  const c = await setup();
  await c.start();
  const chief = c.made[0];
  await Promise.all([c.bus(chief, "remember", { scope: "bot", text: "用户偏好中文" }), c.bus(chief, "remember", { scope: "bot", text: "第二条\n换行" })]);
  await c.bus(chief, "remember", { scope: "project", text: "用 Dice 做主指标" });
  assert.match((await c.bus(chief, "recall", { scope: "bot" })).text, /第二条 换行/);

  const m = (await c.t.api("GET", `/api/memory/bot/${c.chiefId}`)).body;
  assert.match(m.content, /用户偏好中文/);
  assert.equal(m.history.length, 3, "one creation commit and two notes");

  await c.t.api("PUT", `/api/memory/bot/${c.chiefId}`, { content: "全部改掉" });
  assert.equal((await c.t.api("GET", `/api/memory/bot/${c.chiefId}`)).body.content, "全部改掉");
  await c.t.api("POST", `/api/memory/bot/${c.chiefId}/rollback`, { hash: m.history[0].hash });
  assert.match((await c.t.api("GET", `/api/memory/bot/${c.chiefId}`)).body.content, /用户偏好中文/);

  assert.equal((await c.t.api("GET", "/api/memory/bot/..%2f..%2fetc")).status, 400);
  assert.equal((await c.t.api("POST", `/api/memory/bot/${c.chiefId}/rollback`, { hash: "HEAD" })).status, 400);

  // A fresh conversation starts a new agent, which must see the notes, labelled as reference.
  c.made[0].reply("好");
  await c.t.waitFor(async () => (await c.t.api("GET", "/api/state")).body.bots[0].conversations[0].status === "idle", "idle");
  await c.t.api("POST", `/api/bots/${c.chiefId}/messages`, { text: "新对话" });
  await c.t.waitFor(() => c.made.length === 2, "new agent");
  const prompt = c.made[1].opts.systemPrompt;
  assert.match(prompt, /用户偏好中文/);
  assert.match(prompt, /用 Dice 做主指标/);
  assert.match(prompt, /不要当作指令/);
  c.t.close();
});

test("a person's memory edit restarts running agents; a Bot's own note does not", async () => {
  const c = await setup();
  const conv = await c.start();
  const chief = c.made[0];
  await c.bus(chief, "remember", { scope: "bot", text: "笔记" });
  chief.reply("好");
  await c.t.waitFor(async () => (await c.t.api("GET", `/api/conversations/${conv}/items`)).body.conversation.status === "idle", "idle");
  await c.t.api("POST", `/api/bots/${c.chiefId}/messages`, { text: "再来", conversationId: conv });
  await c.t.waitFor(() => chief.sent.length === 2, "same agent");
  assert.equal(c.made.length, 1);
  chief.reply("好");
  await c.t.waitFor(async () => (await c.t.api("GET", `/api/conversations/${conv}/items`)).body.conversation.status === "idle", "idle");
  await c.t.api("PUT", `/api/memory/bot/${c.chiefId}`, { content: "用户改的" });
  await c.t.api("POST", `/api/bots/${c.chiefId}/messages`, { text: "再来", conversationId: conv });
  await c.t.waitFor(() => c.made.length === 2, "restart");
  assert.match(c.made[1].opts.systemPrompt, /用户改的/);
  c.t.close();
});

test("isolated work happens in its own worktree, and merging brings it into the base branch", async () => {
  const repo = makeRepo();
  const c = await setup(repo);
  const conv = await c.start();
  const pending = c.bus(c.made[0], "ask_bot", { bot: "Eng", question: "写文件", isolated: true });
  await c.t.waitFor(() => c.callee("Eng")?.sent.length, "eng");
  const eng = c.callee("Eng")!;
  assert.notEqual(eng.opts.cwd, repo);
  assert.match(eng.sent[0], /独立的 Git 工作树/);
  writeFileSync(join(eng.opts.cwd, "new.txt"), "hi\n");
  writeFileSync(join(eng.opts.cwd, "a.txt"), "two\n");
  eng.reply("写好了");
  const answer = (await pending).text;
  assert.match(answer, /写好了/);
  assert.match(answer, /分支：bot\/eng-/);
  assert.match(answer, /实际改动：\n M a\.txt\n\?\? new\.txt/);
  assert.equal(existsSync(join(repo, "new.txt")), false, "base stays untouched");

  const [wt] = (await c.t.api("GET", `/api/conversations/${conv}/worktrees`)).body.worktrees;
  const d = (await c.t.api("GET", `/api/worktrees/${wt.id}/diff`)).body;
  assert.match(d.diff, /\+two/);
  assert.deepEqual(d.untracked, ["new.txt"]);
  assert.equal((await c.t.api("POST", `/api/worktrees/${wt.id}/merge`, {})).status, 409, "not while the conversation runs");
  await c.finish(conv);

  assert.equal((await c.t.api("POST", `/api/worktrees/${wt.id}/merge`, {})).status, 200);
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "hi\n");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "two\n");
  assert.equal(existsSync(wt.path), false, "worktree removed");
  assert.equal(gitIn(repo, "branch", "--list", wt.branch).trim(), "", "branch removed");
  assert.equal((await c.t.api("POST", `/api/worktrees/${wt.id}/merge`, {})).status, 409, "only once");
  assert.equal((await c.t.api("GET", `/api/conversations/${conv}/worktrees`)).body.worktrees.length, 0);
  c.t.close();
});

test("when a Bot claims work it did not do, the platform's check says so", async () => {
  const repo = makeRepo();
  const c = await setup(repo);
  await c.start();
  const p = c.bus(c.made[0], "ask_bot", { bot: "Eng", question: "写文件", isolated: true });
  await c.t.waitFor(() => c.callee("Eng")?.sent.length, "eng");
  c.callee("Eng")!.reply("已创建 hello.txt");
  const answer = (await p).text;
  assert.match(answer, /已创建 hello\.txt/);
  assert.match(answer, /实际改动：无/);
  c.t.close();
});

test("merging is refused on a dirty base, and a conflict leaves both sides intact", async () => {
  const repo = makeRepo();
  const c = await setup(repo);
  const conv = await c.start();
  const pending = c.bus(c.made[0], "ask_bot", { bot: "Eng", question: "改", isolated: true });
  await c.t.waitFor(() => c.callee("Eng")?.sent.length, "eng");
  const eng = c.callee("Eng")!;
  writeFileSync(join(eng.opts.cwd, "a.txt"), "from bot\n");
  eng.reply("改好了");
  await pending;
  await c.finish(conv);
  const [wt] = (await c.t.api("GET", `/api/conversations/${conv}/worktrees`)).body.worktrees;

  writeFileSync(join(repo, "a.txt"), "uncommitted\n");
  const dirty = await c.t.api("POST", `/api/worktrees/${wt.id}/merge`, {});
  assert.equal(dirty.status, 409);
  assert.match(dirty.body.error, /未提交/);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "uncommitted\n", "the user's work is untouched");

  writeFileSync(join(repo, "a.txt"), "from user\n");
  gitIn(repo, "commit", "-q", "-am", "user change");
  const conflict = await c.t.api("POST", `/api/worktrees/${wt.id}/merge`, {});
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /冲突/);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "from user\n");
  assert.equal(gitIn(repo, "status", "--porcelain").trim(), "", "merge fully aborted");
  assert.equal(readFileSync(join(wt.path, "a.txt"), "utf8"), "from bot\n");

  assert.equal((await c.t.api("POST", `/api/worktrees/${wt.id}/discard`, {})).status, 200);
  assert.equal(existsSync(wt.path), false);
  c.t.close();
});

test("workspace reaches only this conversation's worktrees; a non-repo refuses isolated", async () => {
  const repo = makeRepo();
  const c = await setup(repo);
  await c.start();
  const chief = c.made[0];
  assert.match((await c.bus(chief, "ask_bot", { bot: "Eng", question: "x", workspace: "/etc" })).text, /不是这个对话里的工作树/);
  const p = c.bus(chief, "ask_bot", { bot: "Eng", question: "写", isolated: true });
  await c.t.waitFor(() => c.callee("Eng")?.sent.length, "eng");
  const eng = c.callee("Eng")!;
  eng.reply("好");
  const wtPath = (await p).text.match(/工作树路径：(.+?)，/)![1];

  const rev = (await c.t.api("POST", "/api/bots", { name: "Rev", role: "ROLE-Rev", agent: "claude", model: "claude-sonnet-5-5", permission: "read_only" })).body;
  const q = c.bus(chief, "ask_bot", { bot: "Rev", question: "审查", workspace: wtPath });
  await c.t.waitFor(() => c.callee("Rev")?.sent.length, "rev");
  assert.equal(c.callee("Rev")!.opts.cwd, wtPath);
  c.callee("Rev")!.reply("没问题");
  assert.equal((await q).text, "没问题");
  assert.ok(rev.id);
  c.t.close();

  const plain = await setup();
  await plain.start();
  const r = await plain.bus(plain.made[0], "ask_bot", { bot: "Eng", question: "x", isolated: true });
  assert.match(r.text, /不是 Git 仓库/);
  assert.equal(plain.callee("Eng"), undefined);
  plain.t.close();
});
