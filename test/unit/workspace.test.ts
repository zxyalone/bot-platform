import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { Memory } from "../../src/daemon/git.ts";
import { ensureSeedBots, Store } from "../../src/daemon/store.ts";
import type { AgentEvent, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

class Fake implements AgentRuntime {
  sent: string[] = [];
  opts: RuntimeOptions;
  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }
  emit(e: AgentEvent) {
    this.opts.onEvent(e);
  }
  reply(text = "好") {
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
  stop() {}
}

async function setup() {
  const home = tempHome();
  const seed = new Store(home);
  ensureSeedBots(seed);
  seed.close();
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  }, { home });
  const create = (body: object) => t.api("POST", "/api/workspaces", body);
  const fresh = () => join(mkdtempSync(join(tmpdir(), "bot-ws-")), "project");
  const state = async () => (await t.api("GET", "/api/state")).body;
  const say = async (bot: any, text = "go") => {
    const before = made.length;
    const id = (await t.api("POST", `/api/bots/${bot.id}/messages`, { text })).body.id as string;
    await t.waitFor(() => made.length > before && made.at(-1)!.sent.length, "agent");
    return { conv: id, f: made.at(-1)! };
  };
  const bus = (f: Fake, tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end");
    await new Promise((r) => setTimeout(r, 30));
    t.close();
  };
  return { t, made, create, fresh, state, say, bus, end };
}

test("one call makes a directory, Git with a first commit, and a team of its own", async () => {
  const s = await setup();
  const cwd = s.fresh();
  const r = await s.create({ name: "肝脏肿瘤分割", cwd, goal: "把 Dice 提到 0.85" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.bots.map((b: any) => b.name), ["Chief", "Engineer", "Reviewer"], "the defaults");
  assert.ok(existsSync(join(cwd, ".git")));
  assert.equal(execFileSync("git", ["log", "--oneline"], { cwd, encoding: "utf8" }).trim().split("\n").length, 1);
  for (const b of r.body.bots) assert.deepEqual([b.cwd, b.workspace_id], [cwd, r.body.id]);
  assert.equal(r.body.bots[0].is_chief, 1);
  assert.equal(r.body.bots[0].permission, "read_only");
  assert.equal(r.body.bots[0].model, "claude-sonnet-5-5", "not the priciest by default");

  const st = await s.state();
  assert.deepEqual(st.workspaces.map((w: any) => w.name), ["默认工作空间", "肝脏肿瘤分割"]);
  assert.equal(st.bots.filter((b: any) => b.is_chief).length, 2, "each has its own Chief");
  assert.ok(st.workspace_templates.every((t: any) => t.role === undefined));
  const brief = (await s.t.api("GET", `/api/projects/${Memory.projectId(cwd)}/overview?cwd=${encodeURIComponent(cwd)}`)).body.brief;
  assert.deepEqual([brief.name, brief.goal], ["肝脏肿瘤分割", "把 Dice 提到 0.85"]);
  s.t.close();
});

test("the team and models can be chosen, Chief always comes, and bad choices are refused", async () => {
  const s = await setup();
  const r = await s.create({ name: "选人", cwd: s.fresh(), bots: [{ key: "scholar" }, { key: "engineer", agent: "codex", model: "gpt-6-luna" }, { key: "nope" }] });
  assert.deepEqual(r.body.bots.map((b: any) => [b.name, b.model]), [["Chief", "claude-sonnet-5-5"], ["Engineer", "gpt-6-luna"], ["Scholar", "gemini-3.8-flash"]]);
  assert.equal(r.body.bots[2].permission, "read_only");
  assert.equal((await s.create({ name: "", cwd: s.fresh() })).status, 400);
  assert.equal((await s.create({ name: "x", cwd: "relative/path" })).status, 400);
  const bad = s.fresh();
  assert.equal((await s.create({ name: "x", cwd: bad, bots: [{ key: "chief", agent: "codex", model: "claude-opus-5-5" }] })).status, 400);
  assert.equal(existsSync(bad), false, "nothing is created when the request is wrong");
  s.t.close();
});

test("with no directory given it goes under the home folder, and never reuses one", async () => {
  const s = await setup();
  const unique = `bot-test-${Date.now()}`;
  const a = await s.create({ name: unique });
  const b = await s.create({ name: unique });
  try {
    assert.equal(a.body.cwd, join(homedir(), "BotWorkspaces", unique));
    assert.equal(b.body.cwd, `${a.body.cwd}-2`);
    assert.ok(existsSync(join(b.body.cwd, ".git")));
  } finally {
    for (const d of [a.body.cwd, b.body.cwd]) execFileSync("rm", ["-rf", d]);
  }
  s.t.close();
});

test("an existing directory keeps its files out of any commit, and one directory is one workspace", async () => {
  const s = await setup();
  const cwd = mkdtempSync(join(tmpdir(), "bot-existing-"));
  writeFileSync(join(cwd, "mine.txt"), "我的文件");
  const r = await s.create({ name: "已有", cwd });
  assert.equal(r.status, 201);
  assert.match(r.body.notes[0], /提交一次/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim(), "?? mine.txt", "not committed for them");
  assert.equal((await s.create({ name: "再来", cwd })).status, 409);
  assert.deepEqual(readdirSync(cwd).sort(), [".git", "mine.txt"]);

  const repo = mkdtempSync(join(tmpdir(), "bot-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "a.py"), "1");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e.com", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e.com", "commit", "-qm", "theirs"], { cwd: repo });
  const kept = await s.create({ name: "别人的仓库", cwd: repo });
  assert.deepEqual(kept.body.notes, []);
  assert.equal(execFileSync("git", ["log", "--format=%s"], { cwd: repo, encoding: "utf8" }).trim(), "theirs", "history untouched");
  s.t.close();
});

test("Bots only see and call their own workspace, even with the same names", async () => {
  const s = await setup();
  const one = (await s.create({ name: "一", cwd: s.fresh() })).body;
  const two = (await s.create({ name: "二", cwd: s.fresh() })).body;
  const { conv, f } = await s.say(one.bots[0]);
  const listed = (await s.bus(f, "list_bots", {})).text;
  assert.match(listed, /Engineer/);
  assert.equal(listed.split("\n").length, 2, `only its own two: ${listed}`);

  const asked = s.bus(f, "ask_bot", { bot: "Engineer", question: "你在哪" });
  await s.t.waitFor(() => s.made.length === 2 && s.made[1].sent.length, "engineer");
  assert.equal(s.made[1].opts.cwd, one.cwd, "this workspace's Engineer, not the other one");
  s.made[1].reply("这里");
  assert.match((await asked).text, /这里/);

  await s.t.api("POST", "/api/bots", { name: "只在二里", role: "x", agent: "codex", model: "gpt-6-luna", workspace_id: two.id });
  assert.match((await s.bus(f, "ask_bot", { bot: "只在二里", question: "?" })).text, /没有叫/);
  f.reply();
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.conversation.status === "idle", "idle");
  await s.end();
});

test("Chief's new Bots stay in its workspace; names are unique only within one", async () => {
  const s = await setup();
  const one = (await s.create({ name: "一", cwd: s.fresh() })).body;
  const { conv, f } = await s.say(one.bots[0]);
  const p = s.bus(f, "create_bot", { name: "Scholar", role: "查资料", agent: "codex", model: "gpt-6-luna" });
  const card: any = await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.items.find((i: any) => i.data.kind === "bot_proposal" && i.status === "pending"), "proposal");
  await s.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" });
  await p;
  const bot = (await s.state()).bots.find((b: any) => b.name === "Scholar");
  assert.deepEqual([bot.workspace_id, bot.cwd], [one.id, one.cwd]);
  f.reply();

  const dup = await s.t.api("POST", "/api/bots", { name: "engineer", role: "x", agent: "codex", model: "gpt-6-luna", workspace_id: one.id });
  assert.equal(dup.status, 409);
  const elsewhere = await s.t.api("POST", "/api/bots", { name: "Scholar", role: "x", agent: "codex", model: "gpt-6-luna" });
  assert.equal(elsewhere.status, 201, "another workspace may use the name");
  assert.equal(elsewhere.body.workspace_id, "default");
  const inHere = await s.t.api("POST", "/api/bots", { name: "New", role: "x", agent: "codex", model: "gpt-6-luna", workspace_id: one.id });
  assert.equal(inHere.body.cwd, one.cwd, "a blank directory means the workspace's");
  assert.equal((await s.t.api("POST", "/api/bots", { name: "N", role: "x", agent: "codex", model: "gpt-6-luna", workspace_id: "nope" })).status, 400);
  await s.end();
});

test("a plan and a group can only use the Bots in their workspace", async () => {
  const s = await setup();
  const one = (await s.create({ name: "一", cwd: s.fresh() })).body;
  const two = (await s.create({ name: "二", cwd: s.fresh() })).body;
  await s.t.api("POST", "/api/bots", { name: "别处的人", role: "x", agent: "codex", model: "gpt-6-luna", workspace_id: two.id });
  const { f } = await s.say(one.bots[0]);
  const r = await s.bus(f, "propose_plan", { title: "x", tasks: [{ id: "a", bot: "别处的人", task: "做" }] });
  assert.match(r.text, /不存在/);
  f.reply();

  const mixed = await s.t.api("POST", "/api/groups", { name: "混合", members: [one.bots[1].id, two.bots[1].id], workspace_id: one.id });
  assert.equal(mixed.status, 400);
  assert.match(mixed.body.error, /同一个工作空间/);
  const g = await s.t.api("POST", "/api/groups", { name: "好群", members: [one.bots[1].id, one.bots[2].id], workspace_id: one.id });
  assert.equal(g.status, 201);
  assert.deepEqual([g.body.workspace_id, g.body.cwd], [one.id, one.cwd]);
  await s.end();
});

test("budgets and briefs stay with their own workspace", async () => {
  const s = await setup();
  const one = (await s.create({ name: "一", cwd: s.fresh(), goal: "一的目标" })).body;
  const two = (await s.create({ name: "二", cwd: s.fresh(), goal: "二的目标" })).body;
  await s.t.api("PUT", `/api/projects/${Memory.projectId(one.cwd)}/settings`, { budget_total: 1 });
  const { conv: c2, f } = await s.say(two.bots[0]);
  assert.match(f.opts.systemPrompt, /二的目标/);
  assert.doesNotMatch(f.opts.systemPrompt, /一的目标/);
  f.emit({ type: "usage_tick", tokens: 500 });
  assert.equal((await s.t.api("GET", `/api/conversations/${c2}/items`)).body.conversation.status, "running", "the other workspace's limit does not touch it");
  const a = await s.say(one.bots[0]);
  a.f.emit({ type: "usage_tick", tokens: 500 });
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${a.conv}/items`)).body.conversation.status === "idle", "one stops");
  assert.equal((await s.t.api("GET", `/api/conversations/${c2}/items`)).body.conversation.status, "running");
  f.reply();
  await s.end();
});

test("restoring an archived Bot checks names only within its workspace, and existing Bots stay in the default one", async () => {
  const s = await setup();
  const st = await s.state();
  assert.ok(st.bots.every((b: any) => b.workspace_id === "default"));
  assert.ok(st.groups.every((g: any) => g.workspace_id === "default"));
  assert.deepEqual(st.workspaces.map((w: any) => w.id), ["default"]);
  const one = (await s.create({ name: "一", cwd: s.fresh() })).body;
  const eng = one.bots[1];
  await s.t.api("DELETE", `/api/bots/${eng.id}`);
  assert.equal((await s.t.api("POST", `/api/bots/${eng.id}/restore`, {})).status, 200, "the default workspace's Engineer does not block it");
  s.t.close();
});

test("an old database upgrades: every Bot and group lands in the default workspace", () => {
  const home = tempHome();
  const s1 = new Store(home);
  s1.createBot({ name: "老 Bot", role: "", agent: "codex", model: "m", effort: "low", permission: "ask", route: "official" });
  s1.db.exec("ALTER TABLE bots DROP COLUMN workspace_id");
  s1.close();
  const s2 = new Store(home);
  assert.deepEqual(s2.listBots().map((b) => [b.name, b.workspace_id]), [["老 Bot", "default"]]);
  s2.close();
});
