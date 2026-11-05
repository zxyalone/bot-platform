import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../helpers.ts";
import { Memory } from "../../src/daemon/git.ts";
import { Projects } from "../../src/daemon/projects.ts";
import { Store } from "../../src/daemon/store.ts";
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
  reply(text = "好", tokens = 0) {
    this.emit({ type: "text_done", key: `k${Math.random()}`, text });
    if (tokens) this.emit({ type: "usage", inputTokens: tokens, cachedTokens: 0, outputTokens: 0 });
    this.emit({ type: "turn_end", status: "completed" });
  }
  fail() {
    this.emit({ type: "turn_end", status: "failed", error: "坏了" });
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
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "bot-repo-"));
  gitIn(cwd, "init", "-q");
  writeFileSync(join(cwd, "a.py"), "1\n");
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-qm", "first");
  return cwd;
}
async function setup(cwd = repo()) {
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  });
  const mk = async (name: string, dir = cwd) => (await t.api("POST", "/api/bots", { name, role: `ROLE-${name}`, agent: "codex", model: "gpt-6-luna", cwd: dir })).body;
  const bots: Record<string, any> = { A: await mk("A"), B: await mk("B") };
  const pid = Memory.projectId(cwd);
  const say = (n: string, text = "go", conversationId?: string) => t.api("POST", `/api/bots/${bots[n].id}/messages`, { text, conversationId });
  const rt = (n: string, i = -1) => made.filter((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`)).at(i);
  const waitRt = async (n: string, sends = 1) => {
    await t.waitFor(() => (rt(n)?.sent.length ?? 0) >= sends, `${n} gets ${sends}`);
    return rt(n)!;
  };
  const view = async (q: Record<string, string> = {}) => (await t.api("GET", `/api/projects/${pid}/overview?${new URLSearchParams({ cwd, ...q })}`)).body;
  const brief = (body: object) => t.api("PUT", `/api/projects/${pid}/brief`, body);
  const idle = (id: string) => t.waitFor(async () => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation.status === "idle", "idle");
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end");
    await new Promise((r) => setTimeout(r, 30));
    t.close();
  };
  return { t, cwd, pid, made, bots, mk, say, rt, waitRt, view, brief, idle, end };
}

test("what the person writes about a project reaches every Bot in it, labelled, and no Bot elsewhere", async () => {
  const s = await setup();
  assert.equal((await s.brief({ name: "分割模型", goal: "Dice 提到 0.85", notes: "不能改数据划分", references: "docs/plan.md" })).status, 200);
  await s.say("A");
  const a = await s.waitRt("A");
  assert.match(a.opts.systemPrompt, /用户写的项目说明：分割模型/);
  assert.match(a.opts.systemPrompt, /Dice 提到 0\.85/);
  assert.match(a.opts.systemPrompt, /不能改数据划分/);
  assert.match(a.opts.systemPrompt, /docs\/plan\.md/);
  assert.ok(a.opts.systemPrompt.startsWith("ROLE-A"), "after the Bot's own role");
  // A Bot it calls hears the same, since the work is the same project.
  const r = await fetch(`${s.t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${a.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool: "assign_task", args: { bot: "B", task: "做" } }) }).then((x) => x.json()) as any;
  assert.equal(r.isError, false);
  const b = await s.waitRt("B");
  assert.match(b.opts.systemPrompt, /Dice 提到 0\.85/);
  b.reply();
  a.reply();

  s.bots.Z = await s.mk("Z", mkdtempSync(join(tmpdir(), "bot-other-")));
  await s.say("Z");
  const z = await s.waitRt("Z");
  assert.doesNotMatch(z.opts.systemPrompt, /Dice/);
  z.reply();
  await s.end();
});

test("an empty brief adds nothing, and an edit applies from the next message", async () => {
  const s = await setup();
  const id = (await s.say("A")).body.id;
  const a = await s.waitRt("A");
  assert.doesNotMatch(a.opts.systemPrompt, /项目说明/);
  await s.brief({ goal: "新目标" });
  assert.equal(s.made.length, 1, "the running turn is left alone");
  a.reply();
  await s.idle(id);
  await s.say("A", "再来", id);
  await s.t.waitFor(() => s.made.length === 2, "restarted to read it");
  assert.match(s.made[1].opts.systemPrompt, /新目标/);
  s.made[1].reply();
  await s.end();
});

test("a resumed session is told about an edit once, and a new one is not", async () => {
  const s = await setup();
  await s.brief({ goal: "旧目标" });
  const id = (await s.say("A")).body.id;
  const a = await s.waitRt("A");
  a.emit({ type: "session", sessionId: "s1" });
  assert.doesNotMatch(a.sent[0], /平台通知/, "a new session has it in its system prompt");
  a.reply();
  await s.idle(id);

  await s.say("A", "没改说明", id);
  await s.waitRt("A", 2);
  assert.equal(a.sent[1], "没改说明");
  a.reply();
  await s.idle(id);

  await s.brief({ goal: "新目标" });
  await s.say("A", "改了说明", id);
  await s.t.waitFor(() => s.made.length === 2, "restarted");
  const again = s.made[1];
  await s.t.waitFor(() => again.sent.length === 1, "sent");
  assert.match(again.sent[0], /用户更新了项目说明[\s\S]*新目标[\s\S]*改了说明/);
  again.reply();
  await s.idle(id);

  await s.say("A", "再问一次", id);
  await s.t.waitFor(() => again.sent.length === 2, "next");
  assert.equal(again.sent[1], "再问一次", "only once");
  again.reply();
  await s.idle(id);

  await s.brief({ goal: "" });
  await s.say("A", "清空了", id);
  await s.t.waitFor(() => s.made.length === 3, "restarted again");
  await s.t.waitFor(() => s.made[2].sent.length === 1, "sent");
  assert.match(s.made[2].sent[0], /清空了项目说明/);
  s.made[2].reply();
  await s.end();
});

test("a brief is validated, and saving one field leaves the others", async () => {
  const s = await setup();
  await s.brief({ goal: "目标", notes: "约束" });
  await s.brief({ notes: "新约束" });
  const b = (await s.view()).brief;
  assert.deepEqual([b.goal, b.notes], ["目标", "新约束"]);
  assert.equal((await s.brief({ goal: "x".repeat(4001) })).status, 413);
  assert.equal((await s.brief({ goal: 1 })).status, 400);
  assert.equal((await s.t.api("GET", `/api/projects/${s.pid}/overview?cwd=/elsewhere`)).status, 400);
  s.t.close();
});

test("the overview shows who works here, what is going on, what waits and what came out", async () => {
  const s = await setup();
  await s.brief({ name: "项目甲" });
  const g = (await s.t.api("POST", "/api/groups", { name: "群", members: [s.bots.A.id, s.bots.B.id], cwd: s.cwd })).body;
  const id = (await s.say("A", "改文件")).body.id;
  const a = await s.waitRt("A");
  a.emit({ type: "approval", requestId: "r", title: "写入 x", detail: "", canRemember: false });
  let v = await s.view();
  assert.equal(v.name, "项目甲");
  assert.deepEqual(v.bots.map((b: any) => b.name), ["A", "B"]);
  assert.deepEqual(v.groups.map((x: any) => x.id), [g.id]);
  assert.equal(v.active.length, 1);
  assert.match(v.active[0].activity.text, /等待你批准/);
  assert.deepEqual(v.inbox.map((i: any) => i.kind), ["approval"]);

  writeFileSync(join(s.cwd, "a.py"), "2\n");
  a.reply("改好了");
  await s.t.waitFor(async () => (await s.view()).results.length === 1, "result");
  await s.idle(id);
  v = await s.view();
  assert.equal(v.active.length, 0);
  assert.deepEqual([v.results[0].summary, v.results[0].files, v.results[0].accepted], ["改好了", 1, false]);
  assert.equal(v.artifact_total, 1);
  assert.deepEqual(v.inbox.map((i: any) => i.kind), ["result"]);
  await s.end();
});

test("another project's work does not show up here", async () => {
  const s = await setup();
  s.bots.Z = await s.mk("Z", mkdtempSync(join(tmpdir(), "bot-other-")));
  const id = (await s.say("Z", "别处的活")).body.id;
  (await s.waitRt("Z")).reply();
  await s.idle(id);
  const v = await s.view();
  assert.equal(v.conversations.length, 0);
  assert.equal(v.since, null);
  assert.equal(v.budget.total.spent, 0);
  await s.end();
});

test("coming back shows what happened since, from the records", async () => {
  const s = await setup();
  assert.equal((await s.view()).since, null, "first visit");
  await s.t.api("POST", `/api/projects/${s.pid}/seen`, {});
  const before = (await s.view()).brief.last_seen;
  assert.ok(before);
  await new Promise((r) => setTimeout(r, 5));

  const id = (await s.say("A")).body.id;
  const a = await s.waitRt("A");
  const r = await fetch(`${s.t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${a.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool: "assign_task", args: { bot: "B", task: "要失败的" } }) }).then((x) => x.json()) as any;
  const { task_id } = JSON.parse(r.text);
  (await s.waitRt("B")).fail();
  await s.t.waitFor(async () => (await s.t.api("GET", "/api/tasks")).body.tasks.find((x: any) => x.id === task_id)?.status === "failed", "failed");
  writeFileSync(join(s.cwd, "a.py"), "2\n");
  a.reply("完", 700);
  await s.t.waitFor(async () => (await s.view()).results.length === 1, "result");
  await s.idle(id);

  const v = await s.view();
  assert.equal(v.since.at, before);
  assert.deepEqual([v.since.rounds, v.since.failed_tasks, v.since.files, v.since.tokens], [1, 1, 1, 700]);
  assert.equal((await s.view({ since: String(Date.now() + 1000) })).since.rounds, 0, "a visit can stay anchored to when it began");
  assert.equal(v.tasks.attention.length, 1);

  await s.t.api("POST", `/api/projects/${s.pid}/seen`, {});
  assert.equal((await s.view()).since.rounds, 0);
  await s.end();
});

test("projects are listed by directory, most recently used first, under the name given", async () => {
  const s = await setup();
  await s.brief({ name: "项目甲" });
  const other = mkdtempSync(join(tmpdir(), "bot-zzz-"));
  s.bots.Z = await s.mk("Z", other);
  const id = (await s.say("Z")).body.id;
  (await s.waitRt("Z")).reply();
  await s.idle(id);
  const { projects } = (await s.t.api("GET", "/api/projects")).body;
  const mine = projects.filter((p: any) => p.cwd === s.cwd || p.cwd === other);
  assert.deepEqual(mine.map((p: any) => p.cwd), [other, s.cwd]);
  assert.equal(mine[1].name, "项目甲");
  assert.equal(mine[1].bots, 2);
  assert.ok(mine[0].name.startsWith("bot-zzz-"), "the directory's name until one is given");
  await s.end();
});

test("the overview costs no tokens and starts no agent", async () => {
  const s = await setup();
  await s.view();
  await s.t.api("POST", `/api/projects/${s.pid}/seen`, {});
  await s.view();
  assert.equal(s.made.length, 0);
  s.t.close();
});

test("moving the data folder keeps a project's brief", () => {
  const base = mkdtempSync(join(tmpdir(), "bot-move-"));
  const oldHome = join(base, "old", ".data");
  mkdirSync(oldHome, { recursive: true });
  const s1 = new Store(oldHome);
  const cwd = join(oldHome, "workspaces", "w");
  mkdirSync(cwd, { recursive: true });
  s1.createBot({ name: "A", role: "", agent: "codex", model: "m", effort: "low", permission: "ask", route: "official", cwd });
  new Projects(s1).saveBrief(Memory.projectId(cwd), { goal: "留下来" });
  s1.close();
  const newHome = join(base, "new", ".data");
  mkdirSync(join(base, "new"), { recursive: true });
  execFileSync("cp", ["-R", oldHome, newHome]);
  const s2 = new Store(newHome);
  const moved = join(newHome, "workspaces", "w");
  assert.equal(new Projects(s2).brief(Memory.projectId(moved)).goal, "留下来");
  s2.close();
});

test("the web bundle's project page is served", async () => {
  const s = await setup();
  assert.match(await fetch(`${s.t.base}/project.js`).then((r) => r.text()), /mountProject/);
  s.t.close();
});
