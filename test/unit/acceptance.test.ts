import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../helpers.ts";
import { Memory } from "../../src/daemon/git.ts";
import type { AgentEvent, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

class Fake implements AgentRuntime {
  sent: string[] = [];
  opts: RuntimeOptions;
  interrupted = 0;
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
    this.interrupted++;
    this.emit({ type: "turn_end", status: "interrupted" });
  }
  answerApproval(_: string, __: ApprovalDecision) {}
  stop() {}
}

async function setup(cwd = mkdtempSync(join(tmpdir(), "bot-proj-"))) {
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  });
  const mk = async (name: string) => (await t.api("POST", "/api/bots", { name, role: `ROLE-${name}`, agent: "codex", model: "gpt-6-luna", cwd })).body;
  const bots = { A: await mk("A"), B: await mk("B"), C: await mk("C") } as Record<string, any>;
  const rt = (n: string) => made.find((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`));
  const waitRt = async (n: string, sends = 1) => {
    await t.waitFor(() => (rt(n)?.sent.length ?? 0) >= sends, `${n} gets ${sends}`);
    return rt(n)!;
  };
  const bus = (f: Fake, tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  const assign = async (f: Fake, args: object) => JSON.parse((await bus(f, "assign_task", { task: "做", ...args })).text) as { task_id: string; status: string };
  const say = async (n = "A", text = "go", conversationId?: string) => (await t.api("POST", `/api/bots/${bots[n].id}/messages`, { text, conversationId })).body.id as string;
  const task = async (id: string) => (await t.api("GET", "/api/tasks")).body.tasks.find((x: any) => x.id === id);
  const items = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];
  const status = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation.status;
  const idle = (id: string) => t.waitFor(async () => (await status(id)) === "idle", "idle");
  const settle = (id: string, s: string) => t.waitFor(async () => (await task(id))?.status === s, `task ${s}`);
  const inbox = async () => (await t.api("GET", "/api/inbox")).body.items as any[];
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end");
    await new Promise((r) => setTimeout(r, 30));
    t.close();
  };
  return { t, made, bots, rt, waitRt, bus, assign, say, task, items, idle, settle, inbox, end, cwd };
}
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "bot-repo-"));
  gitIn(cwd, "init", "-q");
  writeFileSync(join(cwd, "a.py"), "start\n");
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-qm", "first");
  return cwd;
}
type S = Awaited<ReturnType<typeof setup>>;
const cardIn = (s: S, conv: string, n = 1) => s.t.waitFor(async () => (await s.items(conv)).filter((i) => i.type === "result")[n - 1], "card") as Promise<any>;
const diffOf = async (s: S, id: string) => (await s.t.api("GET", `/api/items/${id}/diff`)).body;

// ---------- one Bot, two requests at once ----------
test("two tasks given to one Bot at the same moment take turns on its session", async () => {
  const s = await setup();
  await s.say();
  const a = await s.waitRt("A");
  const [one, two] = await Promise.all([s.assign(a, { bot: "B", task: "一" }), s.assign(a, { bot: "B", task: "二" })]);
  assert.deepEqual([one.status, two.status].sort(), ["running", "waiting"]);
  const b = await s.waitRt("B");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(b.sent.length, 1, "the session is not handed a second request while it works");
  const first = one.status === "running" ? one : two;
  const second = one.status === "running" ? two : one;
  assert.match((await s.task(second.task_id)).waiting_reason, /B 忙完/);
  b.reply("第一个好了");
  await s.settle(first.task_id, "done");
  await s.waitRt("B", 2);
  b.reply("第二个好了");
  await s.settle(second.task_id, "done");
  assert.match((await s.task(first.task_id)).answer, /第一个/);
  assert.match((await s.task(second.task_id)).answer, /第二个/);
  a.reply("完");
  await s.end();
});

test("two questions at the same moment: the second is told to wait, and the first is unharmed", async () => {
  const s = await setup();
  await s.say();
  const a = await s.waitRt("A");
  const p1 = s.bus(a, "ask_bot", { bot: "B", question: "一" });
  const p2 = s.bus(a, "ask_bot", { bot: "B", question: "二" });
  const refused = await p2;
  assert.match(refused.text, /正在处理/);
  const b = await s.waitRt("B");
  b.reply("答");
  assert.match((await p1).text, /答/);
  a.reply("完");
  await s.end();
});

test("a Bot that has just finished can be asked again, and a task queued behind a question starts after it", async () => {
  const s = await setup();
  await s.say();
  const a = await s.waitRt("A");
  const p = s.bus(a, "ask_bot", { bot: "B", question: "一" });
  const b = await s.waitRt("B");
  const queued = await s.assign(a, { bot: "B", task: "二" });
  assert.equal(queued.status, "waiting");
  b.reply("答");
  await p;
  await s.waitRt("B", 2);
  b.reply("二好了");
  await s.settle(queued.task_id, "done");
  a.reply("完");
  await s.end();
});

// ---------- the result stays what it was ----------
test("an old result still shows what that round did, whatever happens to the file later", async () => {
  const cwd = repo();
  const s = await setup(cwd);
  const conv = await s.say();
  const a = await s.waitRt("A");
  writeFileSync(join(cwd, "a.py"), "round-one\n");
  a.reply();
  const first = await cardIn(s, conv);
  await s.idle(conv);
  await s.say("A", "再来", conv);
  await s.waitRt("A", 2);
  writeFileSync(join(cwd, "a.py"), "round-two\n");
  a.reply();
  await cardIn(s, conv, 2);
  const d = await diffOf(s, first.id);
  assert.match(d.diff, /\+round-one/);
  assert.doesNotMatch(d.diff, /round-two/);
  writeFileSync(join(cwd, "a.py"), "start\n");
  assert.match((await diffOf(s, first.id)).diff, /\+round-one/, "not even if it was put back");
  await s.end();
});

test("a new text file shows its content; a binary or huge one says what it is instead", async () => {
  const cwd = repo();
  const s = await setup(cwd);
  const conv = await s.say();
  const a = await s.waitRt("A");
  mkdirSync(join(cwd, "sub dir"));
  writeFileSync(join(cwd, "sub dir", "new loss.py"), "def boundary_loss():\n    return 0\n");
  writeFileSync(join(cwd, "pic.png"), Buffer.from([137, 80, 0, 1, 2]));
  writeFileSync(join(cwd, "huge.csv"), Buffer.alloc(2 * 1024 * 1024, 97));
  const before = gitIn(cwd, "status", "--porcelain");
  a.reply();
  const d = await diffOf(s, (await cardIn(s, conv)).id);
  assert.match(d.diff, /\+def boundary_loss/);
  assert.match(d.diff, /Binary files|pic\.png/);
  assert.doesNotMatch(d.diff, /aaaaaaaa/);
  assert.deepEqual(d.skipped, [{ path: "huge.csv", size: 2 * 1024 * 1024, type: ".csv" }]);
  assert.equal(gitIn(cwd, "status", "--porcelain"), before, "the user's index is untouched");
  await s.end();
});

test("a repository with no commits yet can still show what was made", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bot-empty-"));
  gitIn(cwd, "init", "-q");
  const s = await setup(cwd);
  const conv = await s.say();
  const a = await s.waitRt("A");
  writeFileSync(join(cwd, "first.py"), "hello\n");
  a.reply();
  assert.match((await diffOf(s, (await cardIn(s, conv)).id)).diff, /\+hello/);
  await s.end();
});

test("the test set stays out of a saved result", async () => {
  const cwd = repo();
  const s = await setup(cwd);
  await s.t.api("PUT", `/api/projects/${Memory.projectId(cwd)}/settings`, { test_dir: join(cwd, "held_out") });
  const conv = await s.say();
  const a = await s.waitRt("A");
  mkdirSync(join(cwd, "held_out"));
  writeFileSync(join(cwd, "held_out", "labels.txt"), "SECRET\n");
  writeFileSync(join(cwd, "ok.py"), "fine\n");
  a.reply();
  const d = await diffOf(s, (await cardIn(s, conv)).id);
  assert.match(d.diff, /fine/);
  assert.doesNotMatch(d.diff, /SECRET/);
  await s.end();
});

// ---------- the inbox ----------
test("a result can wait or be waved off without being accepted", async () => {
  const cwd = repo();
  const s = await setup(cwd);
  const conv = await s.say();
  const a = await s.waitRt("A");
  writeFileSync(join(cwd, "a.py"), "1\n");
  a.reply();
  const c = await cardIn(s, conv);
  await s.idle(conv);
  const mark = (state: string) => s.t.api("POST", `/api/items/${c.id}/review`, { state });
  assert.equal((await s.inbox())[0].kind, "result");
  assert.equal((await mark("nonsense")).status, 400);
  assert.equal((await mark("later")).body.data.review, "later");
  assert.equal((await s.inbox())[0].kind, "later", "still there, but not asking for attention");
  assert.equal((await mark("dismissed")).body.data.review, "dismissed");
  assert.equal((await s.inbox()).length, 0);
  assert.equal((await s.items(conv)).find((i) => i.id === c.id).data.accepted, false, "waving it off is not accepting it");
  await s.end();
});

test("the inbox says when a newer result has come since", async () => {
  const cwd = repo();
  const s = await setup(cwd);
  const conv = await s.say();
  const a = await s.waitRt("A");
  writeFileSync(join(cwd, "a.py"), "1\n");
  a.reply();
  await cardIn(s, conv);
  await s.idle(conv);
  await s.say("A", "再来", conv);
  await s.waitRt("A", 2);
  writeFileSync(join(cwd, "a.py"), "2\n");
  a.reply();
  await cardIn(s, conv, 2);
  const rows = await s.inbox();
  assert.deepEqual(rows.map((r) => r.superseded), [false, true]);
  await s.end();
});

// ---------- cancelling one task ----------
test("cancelling a task stops it and what hangs off it, and leaves the rest of the round alone", async () => {
  const s = await setup();
  const conv = await s.say();
  const a = await s.waitRt("A");
  const target = await s.assign(a, { bot: "B", task: "要取消的" });
  const b = await s.waitRt("B");
  const child = JSON.parse((await s.bus(b, "assign_task", { bot: "C", task: "它派的" })).text);
  const next = await s.assign(a, { bot: "C", task: "依赖它的", depends_on: [target.task_id] });
  const other = await s.assign(a, { bot: "C", task: "无关的", isolated: false }).catch(() => null);

  const view = await s.task(target.task_id);
  assert.deepEqual(view.affects.map((x: any) => [x.owner, x.why]).sort(), [["C", "它派的任务"], ["C", "依赖它的任务"]].sort());
  assert.equal(view.can_cancel, true);

  assert.equal((await s.t.api("POST", `/api/tasks/${target.task_id}/cancel`, {})).status, 202);
  await s.settle(target.task_id, "interrupted");
  assert.match((await s.task(target.task_id)).failure_reason, /你取消/);
  await s.settle(child.task_id, "interrupted");
  await s.settle(next.task_id, "failed");
  assert.ok(b.interrupted >= 1);
  assert.equal((await s.task(target.task_id)).can_cancel, false);
  assert.equal((await s.t.api("POST", `/api/tasks/${target.task_id}/cancel`, {})).status, 409);
  assert.equal(await s.t.api("GET", `/api/conversations/${conv}/items`).then((r) => r.body.conversation.status), "running", "the round goes on");
  void other;
  a.reply("完");
  await s.end();
});

test("a waiting task can be cancelled before it starts", async () => {
  const s = await setup();
  await s.say();
  const a = await s.waitRt("A");
  const first = await s.assign(a, { bot: "B", task: "一" });
  const second = await s.assign(a, { bot: "C", task: "二", depends_on: [first.task_id] });
  assert.equal((await s.t.api("POST", `/api/tasks/${second.task_id}/cancel`, {})).status, 202);
  await s.settle(second.task_id, "interrupted");
  (await s.waitRt("B")).reply("好");
  await s.settle(first.task_id, "done");
  assert.equal(s.rt("C"), undefined, "it never reached its Bot");
  a.reply("完");
  await s.end();
});

// ---------- what a retry will do ----------
test("a task that can be retried says where, whether earlier work stays, and what it costs", async () => {
  const s = await setup();
  const conv = await s.say();
  const a = await s.waitRt("A");
  const one = await s.assign(a, { bot: "B", task: "一" });
  const b = await s.waitRt("B");
  await s.t.api("POST", `/api/tasks/${one.task_id}/cancel`, {});
  await s.settle(one.task_id, "interrupted");
  void b;
  let info = (await s.task(one.task_id)).retry_info;
  assert.equal(info.cwd, s.cwd);
  assert.equal(info.keeps_changes, true);
  assert.equal(info.new_round, false, "this round is still open");
  a.reply("完");
  await s.idle(conv);
  info = (await s.task(one.task_id)).retry_info;
  assert.equal(info.new_round, true);
  assert.ok(info.budget > 0);
  assert.equal(info.worktree, null);
  await s.end();
});
