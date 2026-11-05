// Features that each work alone, used together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { Memory } from "../../src/daemon/git.ts";
import { ensureSeedBots, Store } from "../../src/daemon/store.ts";
import type { AgentEvent, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

class Fake implements AgentRuntime {
  sent: string[] = [];
  interrupted = 0;
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
    this.interrupted++;
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
async function setup(names: string[], cwd = repo(), withChief = false) {
  const home = tempHome();
  if (withChief) {
    const seed = new Store(home);
    ensureSeedBots(seed);
    seed.close();
  }
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  }, { home });
  const bots: Record<string, any> = {};
  for (const b of (await t.api("GET", "/api/state")).body.bots) bots[b.name] = b;
  for (const n of names) bots[n] = (await t.api("POST", "/api/bots", { name: n, role: `ROLE-${n}`, agent: "codex", model: "gpt-6-luna", cwd })).body;
  const pid = Memory.projectId(cwd);
  const say = async (n: string, text = "go", extra: object = {}) => (await t.api("POST", `/api/bots/${bots[n].id}/messages`, { text, ...extra })).body.id as string;
  const rt = (n: string) => made.find((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`));
  const waitRt = async (n: string) => {
    await t.waitFor(() => rt(n)?.sent.length, `${n} starts`);
    return rt(n)!;
  };
  const bus = (f: Fake, tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  const items = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];
  const idle = (id: string) => t.waitFor(async () => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation.status === "idle", "idle");
  const task = async (id: string) => (await t.api("GET", "/api/tasks")).body.tasks.find((x: any) => x.id === id);
  const list = async () => (await t.api("GET", `/api/artifacts?${new URLSearchParams({ cwd })}`)).body.artifacts as any[];
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end");
    await new Promise((r) => setTimeout(r, 30));
    t.close();
  };
  return { t, made, cwd, pid, bots, say, rt, waitRt, bus, items, idle, task, list, end };
}

// ---------- shared budget ----------
test("running out of a project's budget stops every round in that project, and only that project", async () => {
  const s = await setup(["A", "B", "C"]);
  const other = mkdtempSync(join(tmpdir(), "bot-other-"));
  s.bots.Z = (await s.t.api("POST", "/api/bots", { name: "Z", role: "ROLE-Z", agent: "codex", model: "gpt-6-luna", cwd: other })).body;
  await s.t.api("PUT", `/api/projects/${s.pid}/settings`, { budget_total: 1000 });
  const ca = await s.say("A");
  const a = await s.waitRt("A");
  const cb = await s.say("B");
  const b = await s.waitRt("B");
  await s.t.api("POST", `/api/conversations/${cb}/followup`, { text: "B 排队的" });
  const cz = await s.say("Z");
  const z = await s.waitRt("Z");

  a.emit({ type: "usage_tick", tokens: 1200 });
  await s.idle(ca);
  await s.idle(cb);
  assert.equal(b.interrupted, 1, "the other conversation was stopped too");
  assert.match((await s.items(cb)).filter((i) => i.type === "error").at(-1).data.message, /总预算用完了/);
  const queued = (await s.items(cb)).find((i) => i.type === "queued");
  assert.equal(queued.status, "unsent");
  assert.match(queued.data.reason, /预算用完了/);
  assert.equal(z.interrupted, 0, "another project is untouched");
  assert.equal((await s.t.api("GET", `/api/conversations/${cz}/items`)).body.conversation.status, "running");
  z.reply();
  await s.end();
});

test("a round stopped by the shared budget can hand out no more work", async () => {
  const s = await setup(["A", "B", "C"]);
  await s.t.api("PUT", `/api/projects/${s.pid}/settings`, { budget_daily: 1000 });
  await s.say("A");
  const a = await s.waitRt("A");
  await s.say("B");
  const b = await s.waitRt("B");
  // B cannot end its turn yet, so it is still able to try.
  b.interrupt = async () => {};
  a.emit({ type: "usage_tick", tokens: 1200 });
  const r = await s.bus(b, "assign_task", { bot: "C", task: "再派一个" });
  assert.equal(r.isError, true);
  assert.match(r.text, /预算/);
  assert.equal(s.rt("C"), undefined);
  b.emit({ type: "turn_end", status: "interrupted" });
  await s.end();
});

test("the default has no budget limit", async () => {
  const s = await setup(["A"]);
  const id = await s.say("A");
  const a = await s.waitRt("A");
  a.emit({ type: "usage_tick", tokens: 50_000 });
  const v = (await s.t.api("GET", `/api/projects/${s.pid}/budget?cwd=${encodeURIComponent(s.cwd)}`)).body;
  assert.deepEqual([v.total.limit, v.today.limit], [0, 0]);
  assert.equal((await s.t.api("GET", `/api/conversations/${id}/items`)).body.conversation.status, "running");
  a.reply();
  await s.end();
});

// ---------- a plan bigger than the concurrency limit ----------
test("an approved plan runs in full: steps beyond the limit wait for a slot instead of being refused", async () => {
  const s = await setup(["W1", "W2", "W3", "W4"], repo(), true);
  await s.t.api("PATCH", `/api/bots/${s.bots.Chief.id}`, { cwd: s.cwd });
  await s.say("Chief");
  await s.t.waitFor(() => s.made[0]?.sent.length, "chief");
  const boss = s.made[0];
  const p = s.bus(boss, "propose_plan", { title: "四步", tasks: ["W1", "W2", "W3", "W4"].map((bot, i) => ({ id: `s${i}`, bot, task: `第 ${i + 1} 步` })) });
  const conv = (s.t.store.db.prepare("SELECT conv_id FROM root_turns ORDER BY created_at DESC").get() as any).conv_id;
  const card: any = await s.t.waitFor(async () => (await s.items(conv)).find((i) => i.data.kind === "plan" && i.status === "pending"), "plan");
  assert.equal((await s.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" })).status, 200);
  const out = JSON.parse((await p).text);
  assert.deepEqual(out.tasks.map((t: any) => t.status), ["running", "running", "running", "waiting"]);
  assert.match((await s.task(out.tasks[3].task_id)).waiting_reason, /并发/);
  (await s.waitRt("W1")).reply("一好了");
  const w4 = await s.waitRt("W4");
  assert.match(w4.sent[0], /第 4 步/);
  for (const n of ["W2", "W3", "W4"]) s.rt(n)!.reply();
  for (const t of out.tasks) await s.t.waitFor(async () => (await s.task(t.task_id)).status === "done", "done");
  boss.reply();
  await s.end();
});

test("a plain assign_task over the limit is still refused: only a plan someone approved queues past it", async () => {
  const s = await setup(["A", "W1", "W2", "W3", "W4"]);
  await s.say("A");
  const a = await s.waitRt("A");
  for (const n of ["W1", "W2", "W3"]) assert.equal(JSON.parse((await s.bus(a, "assign_task", { bot: n, task: "做" })).text).status, "running");
  assert.match((await s.bus(a, "assign_task", { bot: "W4", task: "做" })).text, /同时进行的调用已达上限/);
  for (const n of ["W1", "W2", "W3"]) (await s.waitRt(n)).reply();
  a.reply();
  await s.end();
});

// ---------- attachments in a worktree ----------
test("an attachment can be read at the same relative path from a worktree, and is never merged", async () => {
  const s = await setup(["A", "B"]);
  const up = await fetch(`${s.t.base}/api/uploads?name=data.csv`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "a,b\n" }).then((r) => r.json()) as any;
  const conv = await s.say("A", "看附件", { attachments: [up.id] });
  const a = await s.waitRt("A");
  const rel = a.sent[0].match(/- (\.bot-attachments\/[^（\s]+)/)![1];
  assert.equal(readFileSync(join(s.cwd, rel), "utf8"), "a,b\n");

  const r = JSON.parse((await s.bus(a, "assign_task", { bot: "B", task: `处理 ${rel}`, isolated: true })).text);
  const b = await s.waitRt("B");
  assert.notEqual(realpathSync(b.opts.cwd), realpathSync(s.cwd), "it is in its own worktree");
  assert.match(b.sent[0], new RegExp(rel.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  assert.equal(readFileSync(join(b.opts.cwd, rel), "utf8"), "a,b\n", "the path it was given works there");
  assert.equal(gitIn(b.opts.cwd, "status", "--porcelain"), "", "and does not count as a change");

  writeFileSync(join(b.opts.cwd, "out.py"), "x\n");
  b.reply();
  await s.t.waitFor(async () => (await s.task(r.task_id)).status === "done", "task done");
  a.reply();
  await s.idle(conv);
  const wt = (await s.t.api("GET", `/api/conversations/${conv}/worktrees`)).body.worktrees[0];
  assert.equal((await s.t.api("POST", `/api/worktrees/${wt.id}/merge`, {})).status, 200);
  assert.ok(existsSync(join(s.cwd, "out.py")));
  assert.equal(gitIn(s.cwd, "log", "--name-only", "--format=", "-3").includes(".bot-attachments"), false);
  await s.end();
});

test("an attachment sent after a worktree exists reaches it when work is handed there", async () => {
  const s = await setup(["A", "B", "C"]);
  const conv = await s.say("A");
  const a = await s.waitRt("A");
  const first = JSON.parse((await s.bus(a, "assign_task", { bot: "B", task: "开工", isolated: true })).text);
  const b = await s.waitRt("B");
  b.reply();
  await s.t.waitFor(async () => (await s.task(first.task_id)).status === "done", "first");
  const up = await fetch(`${s.t.base}/api/uploads?name=later.txt`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "晚到的" }).then((r) => r.json()) as any;
  await s.t.api("POST", `/api/conversations/${conv}/followup`, { text: "加上这个", attachments: [up.id], mode: "queue" });
  a.reply();
  await s.t.waitFor(() => a.sent.length === 2, "second message");
  const rel = a.sent[1].match(/- (\.bot-attachments\/[^（\s]+)/)![1];
  const wt = (await s.t.api("GET", `/api/conversations/${conv}/worktrees`)).body.worktrees[0];
  const second = JSON.parse((await s.bus(a, "assign_task", { bot: "C", task: `看 ${rel}`, workspace: wt.path })).text);
  const c = await s.waitRt("C");
  assert.equal(readFileSync(join(c.opts.cwd, rel), "utf8"), "晚到的");
  c.reply();
  await s.t.waitFor(async () => (await s.task(second.task_id)).status === "done", "second");
  a.reply();
  await s.end();
});

// ---------- artifacts after a worktree ends ----------
async function worktreeWithFile() {
  const s = await setup(["A", "B"]);
  const conv = await s.say("A");
  const a = await s.waitRt("A");
  const r = JSON.parse((await s.bus(a, "assign_task", { bot: "B", task: "写答案", isolated: true })).text);
  const b = await s.waitRt("B");
  b.emit({ type: "tool", key: "e", title: "写入", status: "running", files: ["answer.txt"] });
  mkdirSync(join(b.opts.cwd, "sub"), { recursive: true });
  writeFileSync(join(b.opts.cwd, "answer.txt"), "42\n");
  writeFileSync(join(b.opts.cwd, "sub", "more.txt"), "x\n");
  b.reply();
  await s.t.waitFor(async () => (await s.task(r.task_id)).status === "done", "done");
  a.reply();
  await s.t.waitFor(async () => (await s.list()).length === 2, "artifacts");
  await s.idle(conv);
  const wt = (await s.t.api("GET", `/api/conversations/${conv}/worktrees`)).body.worktrees[0];
  return { s, conv, wt };
}

test("merging a worktree moves its artifacts along, keeping where they came from", async () => {
  const { s, wt } = await worktreeWithFile();
  const before = (await s.list()).find((x) => x.name === "answer.txt");
  assert.match(before.origin, /B 的任务：写答案/);
  assert.equal((await s.t.api("POST", `/api/worktrees/${wt.id}/merge`, {})).status, 200);
  const rows = await s.list();
  const after = rows.find((x) => x.name === "answer.txt");
  assert.equal(after.id, before.id, "the same record");
  assert.equal(after.state, "same");
  assert.equal(after.origin, before.origin);
  assert.equal(after.rel, "answer.txt");
  assert.equal(rows.find((x) => x.name === "more.txt").rel, join("sub", "more.txt"));
  assert.equal((await s.t.api("GET", `/api/artifacts/${after.id}/text`)).body.text, "42\n");
  assert.equal((await fetch(`${s.t.base}/api/artifacts/${after.id}/file?download=1`)).status, 200);
  await s.end();
});

test("merging over a file already listed keeps one line, and the worktree's origin", async () => {
  const s = await setup(["A", "B"]);
  const conv = await s.say("A");
  const a = await s.waitRt("A");
  writeFileSync(join(s.cwd, "answer.txt"), "main\n");
  gitIn(s.cwd, "add", "-A");
  gitIn(s.cwd, "commit", "-qm", "base");
  const r = JSON.parse((await s.bus(a, "assign_task", { bot: "B", task: "改答案", isolated: true })).text);
  const b = await s.waitRt("B");
  b.emit({ type: "tool", key: "e", title: "写入", status: "running", files: ["answer.txt"] });
  writeFileSync(join(b.opts.cwd, "answer.txt"), "worktree\n");
  b.reply();
  await s.t.waitFor(async () => (await s.task(r.task_id)).status === "done", "done");
  a.reply();
  await s.t.waitFor(async () => (await s.list()).some((x) => x.origin.includes("改答案")), "artifact");
  await s.idle(conv);
  const wt = (await s.t.api("GET", `/api/conversations/${conv}/worktrees`)).body.worktrees[0];
  // The commit made during the round already listed it from the main directory, so the merge has a row to collide with.
  assert.equal((await s.list()).filter((x) => x.name === "answer.txt").length, 2);
  assert.equal((await s.t.api("POST", `/api/worktrees/${wt.id}/merge`, {})).status, 200);
  const rows = (await s.list()).filter((x) => x.name === "answer.txt");
  assert.equal(rows.length, 1);
  assert.match(rows[0].origin, /改答案/);
  assert.equal((await s.t.api("GET", `/api/artifacts/${rows[0].id}/text`)).body.text, "worktree\n");
  await s.end();
});

test("discarding a worktree says its artifacts went with it", async () => {
  const { s, wt } = await worktreeWithFile();
  assert.equal((await s.t.api("POST", `/api/worktrees/${wt.id}/discard`, {})).status, 200);
  const rows = await s.list();
  const row = rows.find((x) => x.name === "answer.txt");
  assert.deepEqual([row.state, row.preview], ["discarded", "none"]);
  assert.match(row.origin, /B 的任务/, "the record of who made it stays");
  const r = await s.t.api("GET", `/api/artifacts/${row.id}/text`);
  assert.equal(r.status, 410);
  assert.match(r.body.error, /随工作树丢弃/);
  assert.equal((await fetch(`${s.t.base}/api/artifacts/${row.id}/file`)).status, 410);
  assert.equal((await s.t.api("POST", `/api/artifacts/${row.id}/reveal`, {})).status, 410);
  await s.end();
});

test("a merge that fails leaves the artifacts in the worktree, where they still are", async () => {
  const { s, wt } = await worktreeWithFile();
  writeFileSync(join(s.cwd, "a.py"), "dirty\n");
  assert.equal((await s.t.api("POST", `/api/worktrees/${wt.id}/merge`, {})).status, 409);
  const row = (await s.list()).find((x) => x.name === "answer.txt");
  assert.notEqual(row.state, "gone");
  assert.equal((await s.t.api("GET", `/api/artifacts/${row.id}/text`)).body.text, "42\n");
  await s.end();
});
