import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { Store } from "../../src/daemon/store.ts";
import type { AgentEvent, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

class Fake implements AgentRuntime {
  sent: string[] = [];
  answers: [string, ApprovalDecision][] = [];
  interrupted = 0;
  opts: RuntimeOptions;
  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }
  emit(e: AgentEvent) {
    this.opts.onEvent(e);
  }
  reply(text: string, tokens = 0) {
    this.emit({ type: "text_done", key: `k${Math.random()}`, text });
    if (tokens) this.emit({ type: "usage", inputTokens: tokens, cachedTokens: 0, outputTokens: 0 });
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
  answerApproval(id: string, d: ApprovalDecision) {
    this.answers.push([id, d]);
  }
  stop() {}
}

async function setup(o: { home?: string; names?: string[]; budget?: number } = {}) {
  const made: Fake[] = [];
  const t = await boot(
    (opts) => {
      const f = new Fake(opts);
      made.push(f);
      return f;
    },
    { home: o.home },
  );
  const bots: Record<string, any> = {};
  for (const b of (await t.api("GET", "/api/state")).body.bots) bots[b.name] = b;
  for (const n of o.names ?? (o.home ? [] : ["A", "B", "C", "D", "E"])) bots[n] = (await t.api("POST", "/api/bots", { name: n, role: `ROLE-${n}`, agent: "codex", model: "gpt-6-luna", ...(o.budget ? { budget_tokens: o.budget } : {}) })).body;
  const rt = (n: string, index = 0) => made.filter((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`))[index];
  const waitRt = async (n: string, sends = 1, index = 0) => {
    await t.waitFor(() => (rt(n, index)?.sent.length ?? 0) >= sends, `${n} to receive ${sends}`);
    return rt(n, index);
  };
  const bus = (f: Fake, tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  const assign = async (f: Fake, args: Record<string, unknown>) => JSON.parse((await bus(f, "assign_task", { task: "做", ...args })).text) as { task_id: string; status: string };
  const say = async (n: string, text = "go", conv?: string) => (await t.api("POST", `/api/bots/${bots[n].id}/messages`, { text, conversationId: conv })).body.id as string;
  const tasks = async (conv?: string) => (await t.api("GET", `/api/tasks${conv ? `?conv=${conv}` : ""}`)).body.tasks as any[];
  const task = async (id: string) => (await tasks()).find((x) => x.id === id);
  const items = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];
  const conv = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation;
  const idle = (id: string) => t.waitFor(async () => (await conv(id)).status === "idle", "conversation idle");
  const retry = (id: string) => t.api("POST", `/api/tasks/${id}/retry`, {});
  // Rounds wind down asynchronously, and closing the store under them is not what these tests are about.
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds to end");
    await new Promise((r) => setTimeout(r, 20));
    t.close();
  };
  const settle = (id: string, status: string) => t.waitFor(async () => (await task(id))?.status === status, `task to be ${status}`);
  return { t, made, bots, rt, waitRt, bus, assign, say, tasks, task, items, conv, idle, retry, settle, end };
}

test("a task waits for its dependency, says so, and starts with the dependency's conclusion", async () => {
  const s = await setup();
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  const first = await s.assign(a, { bot: "B", task: "先审查" });
  const second = await s.assign(a, { bot: "C", task: "再修改", depends_on: [first.task_id] });
  assert.equal(second.status, "waiting");

  const view = await s.task(second.task_id);
  assert.equal(view.owner, "C");
  assert.equal(view.from, "A");
  assert.deepEqual(view.depends_on.map((d: any) => [d.owner, d.status]), [["B", "running"]]);
  assert.match(view.waiting_reason, /等 B 完成“先审查”/);
  assert.equal(s.rt("C"), undefined, "must not start early");
  assert.equal((await s.items(convId)).find((i) => i.type === "call" && i.data.callId === second.task_id).status, "waiting");

  (await s.waitRt("B")).reply("发现一个问题");
  const c = await s.waitRt("C");
  assert.match(c.sent[0], /发现一个问题/);
  assert.equal((await s.task(second.task_id)).status, "running");
  assert.equal((await s.task(second.task_id)).waiting_reason, null);
  c.reply("改好了");
  await s.settle(second.task_id, "done");
  assert.equal((await s.task(second.task_id)).answer, "改好了");
  a.reply("完");
  await s.idle(convId);
  await s.end();
});

test("when a dependency fails, what waits on it fails with the reason, all the way down", async () => {
  const s = await setup();
  await s.say("A");
  const a = await s.waitRt("A");
  const first = await s.assign(a, { bot: "B" });
  const second = await s.assign(a, { bot: "C", depends_on: [first.task_id] });
  const third = await s.assign(a, { bot: "D", depends_on: [second.task_id] });
  (await s.waitRt("B")).emit({ type: "turn_end", status: "failed", error: "磁盘满了" });
  await s.settle(third.task_id, "failed");
  assert.equal((await s.task(first.task_id)).failure_reason, "磁盘满了");
  assert.match((await s.task(second.task_id)).failure_reason, /B.*磁盘满了/);
  assert.match((await s.task(third.task_id)).failure_reason, /C/);
  assert.equal(s.rt("C"), undefined);
  assert.equal(s.rt("D"), undefined);
  // Depending on something already failed is refused outright.
  const late = await s.bus(a, "assign_task", { bot: "E", task: "做", depends_on: [first.task_id] });
  assert.match(late.text, /REFUSED.*没有完成/);
  assert.match((await s.bus(a, "assign_task", { bot: "E", task: "做", depends_on: ["nope"] })).text, /REFUSED.*没有任务/);
  a.reply("完");
  await s.end();
});

test("a waiting task takes no slot until it starts, then waits its turn for one", async () => {
  const s = await setup();
  await s.t.api("PUT", "/api/settings", { max_active: 1 });
  await s.say("A");
  const a = await s.waitRt("A");
  const first = await s.assign(a, { bot: "B" });
  const second = await s.assign(a, { bot: "C", depends_on: [first.task_id] });
  // Full slots refuse a plain task, as they always did, but not one that is only queued.
  assert.match((await s.bus(a, "assign_task", { bot: "D", task: "做" })).text, /同时进行/);
  const third = await s.assign(a, { bot: "D", depends_on: [first.task_id] });
  (await s.waitRt("B")).reply("好");
  await s.settle(second.task_id, "running");
  assert.equal((await s.task(third.task_id)).status, "waiting");
  assert.match((await s.task(third.task_id)).waiting_reason, /并发名额/);
  (await s.waitRt("C")).reply("好");
  await s.settle(third.task_id, "running");
  (await s.waitRt("D")).reply("好");
  await s.settle(third.task_id, "done");
  a.reply("完");
  await s.end();
});

test("two queued tasks for one Bot take turns on its session", async () => {
  const s = await setup();
  await s.say("A");
  const a = await s.waitRt("A");
  const first = await s.assign(a, { bot: "B", task: "一" });
  const second = await s.assign(a, { bot: "B", task: "二", depends_on: [first.task_id] });
  const third = await s.assign(a, { bot: "B", task: "三", depends_on: [first.task_id] });
  const b = await s.waitRt("B");
  b.reply("一好了");
  await s.waitRt("B", 2);
  assert.match((await s.task(third.task_id)).waiting_reason, /B 忙完/);
  b.reply("二好了");
  await s.waitRt("B", 3);
  b.reply("三好了");
  await s.settle(third.task_id, "done");
  assert.equal((await s.task(second.task_id)).status, "done");
  a.reply("完");
  await s.end();
});

test("the task list covers all conversations, shows the running reasons, and can be narrowed to one", async () => {
  const s = await setup();
  const one = await s.say("A");
  const a = await s.waitRt("A");
  const running = await s.assign(a, { bot: "B", task: "要审批" });
  const b = await s.waitRt("B");
  b.emit({ type: "approval", requestId: "r1", title: "写入 x.py", detail: "", canRemember: false });
  await s.t.waitFor(async () => /等你审批：B 的“写入 x.py”/.test((await s.task(running.task_id)).waiting_reason), "approval reason");

  const asking = await s.assign(a, { bot: "C", task: "要问人" });
  const c = await s.waitRt("C");
  void s.bus(c, "ask_bot", { bot: "D", question: "你看呢" });
  await s.t.waitFor(async () => /等 D 回复/.test((await s.task(asking.task_id)).waiting_reason), "sub-call reason");

  // ask_bot is a call, not a task.
  assert.equal((await s.tasks(one)).length, 2);
  const two = await s.say("E");
  assert.deepEqual(await s.tasks(two), []);
  assert.equal((await s.tasks()).length, 2);
  assert.equal((await s.tasks())[0].conv_id, one);
  (await s.waitRt("D")).reply("好");
  c.reply("好");
  b.reply("好");
  a.reply("完");
  (await s.waitRt("E")).reply("好");
  await s.end();
});

test("a task nobody collected ends with that reason, and so does one still waiting", async () => {
  const s = await setup();
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  const running = await s.assign(a, { bot: "B" });
  const queued = await s.assign(a, { bot: "C", depends_on: [running.task_id] });
  await s.waitRt("B");
  a.reply("我先结束了");
  await s.idle(convId);
  await s.settle(running.task_id, "interrupted");
  const view = await s.task(running.task_id);
  assert.match(view.failure_reason, /没有人取回/);
  assert.equal(view.can_retry, true);
  assert.equal((await s.task(queued.task_id)).status, "interrupted");
  assert.match((await s.task(queued.task_id)).failure_reason, /没有人取回/);
  assert.equal(s.rt("C"), undefined);
  await s.end();
});

test("stopping or running out of budget gives its own reason", async () => {
  const s = await setup({ budget: 1000 });
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  const spent = await s.assign(a, { bot: "B" });
  (await s.waitRt("B")).emit({ type: "usage_tick", tokens: 5000 });
  await s.settle(spent.task_id, "interrupted");
  assert.match((await s.task(spent.task_id)).failure_reason, /预算用完/);
  await s.idle(convId);

  const stopped = await s.say("C");
  const c = await s.waitRt("C");
  const task = await s.assign(c, { bot: "D" });
  await s.waitRt("D");
  await s.t.api("POST", `/api/conversations/${stopped}/interrupt`, {});
  await s.settle(task.task_id, "interrupted");
  assert.match((await s.task(task.task_id)).failure_reason, /用户停止/);
  await s.end();
});

test("a timeout stops that task and what it started, and leaves the rest of the round alone", async () => {
  const s = await setup();
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  const slow = await s.assign(a, { bot: "B", task: "慢", timeout_seconds: 0.15 });
  const other = await s.assign(a, { bot: "C", task: "正常" });
  const b = await s.waitRt("B");
  const c = await s.waitRt("C");
  void s.bus(b, "ask_bot", { bot: "D", question: "帮忙" });
  const d = await s.waitRt("D");

  await s.settle(slow.task_id, "timeout");
  const view = await s.task(slow.task_id);
  assert.match(view.failure_reason, /超过 0\.2 秒没有完成/);
  assert.equal(view.can_retry, true);
  assert.equal(d.interrupted, 1, "what it started stops too");
  assert.equal(c.interrupted, 0, "the rest of the round keeps going");
  assert.equal((await s.task(other.task_id)).status, "running");
  assert.equal((await s.conv(convId)).status, "running");
  const seen = JSON.parse((await s.bus(a, "get_task", { task_id: slow.task_id })).text);
  assert.equal(seen.status, "timeout");
  assert.match(seen.reason, /超过/);
  assert.equal((await s.items(convId)).find((i) => i.data.callId === slow.task_id).status, "timeout");
  c.reply("好");
  a.reply("完");
  await s.end();
});

test("time waiting for a person's approval does not count toward the timeout", async () => {
  const s = await setup();
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  const task = await s.assign(a, { bot: "B", timeout_seconds: 0.2 });
  const b = await s.waitRt("B");
  b.emit({ type: "approval", requestId: "r1", title: "写文件", detail: "", canRemember: false });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await s.task(task.task_id)).status, "running");
  const card = (await s.items(convId)).find((i) => i.type === "approval");
  assert.equal((await s.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" })).status, 200);
  await s.settle(task.task_id, "timeout");
  a.reply("完");
  await s.end();
});

test("a Bot can only shorten the timeout, and the setting is the default", async () => {
  const s = await setup();
  await s.t.api("PUT", "/api/settings", { task_timeout_minutes: 1 });
  await s.say("A");
  const a = await s.waitRt("A");
  const row = (id: string) => s.t.store.getCall(id)!.timeout_ms;
  assert.equal(row((await s.assign(a, { bot: "B", timeout_seconds: 99999 })).task_id), 60000);
  assert.equal(row((await s.assign(a, { bot: "C", timeout_seconds: 5 })).task_id), 5000);
  assert.equal(row((await s.assign(a, { bot: "D" })).task_id), 60000);
  assert.equal((await s.t.api("PUT", "/api/settings", { task_timeout_minutes: -1 })).status, 400);
  a.reply("完");
  await s.end();
});

test("retry inside an open round counts against its limits", async () => {
  const s = await setup();
  await s.t.api("PUT", "/api/settings", { max_calls: 3, max_active: 1 });
  await s.say("A");
  const a = await s.waitRt("A");
  const first = await s.assign(a, { bot: "B" });
  (await s.waitRt("B")).emit({ type: "turn_end", status: "failed", error: "炸了" });
  await s.settle(first.task_id, "failed");
  const second = await s.assign(a, { bot: "C" });

  // The slot is taken by C.
  const busy = await s.retry(first.task_id);
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /同时进行/);
  assert.equal((await s.task(first.task_id)).attempt, 1, "a refused retry leaves no trace in the list");

  (await s.waitRt("C")).reply("好");
  await s.settle(second.task_id, "done");
  // Both calls of the round count, so with a limit of two there is no room for a third.
  await s.t.api("PUT", "/api/settings", { max_calls: 2 });
  const spent = await s.retry(first.task_id);
  assert.equal(spent.status, 409);
  assert.match(spent.body.error, /调用次数/);

  await s.t.api("PUT", "/api/settings", { max_calls: 3 });
  const again = await s.retry(first.task_id);
  assert.equal(again.status, 202);
  assert.equal(again.body.attempt, 2);
  const b = await s.waitRt("B", 2);
  assert.match(b.sent[1], /这是一次重试.*炸了/);
  // It is not a new call budget: the round is at its limit again.
  assert.match((await s.bus(a, "assign_task", { bot: "D", task: "做" })).text, /调用次数/);
  // Whoever is asking about the old id gets the current attempt.
  const pending = s.bus(a, "get_task", { task_id: first.task_id, wait_seconds: 30 });
  b.reply("这次好了");
  assert.equal(JSON.parse((await pending).text).answer, "这次好了");
  a.reply("完");
  await s.end();
});

test("retry refuses what a Bot would be refused: pause, permission, loops, depth, a stopped round", async () => {
  const s = await setup();
  const failedTask = async (from: string, to: string) => {
    const convId = await s.say(from);
    const a = await s.waitRt(from);
    const t = await s.assign(a, { bot: to });
    (await s.waitRt(to)).emit({ type: "turn_end", status: "failed", error: "炸了" });
    await s.settle(t.task_id, "failed");
    a.reply("完");
    await s.idle(convId);
    return t.task_id;
  };
  const id = await failedTask("A", "B");
  const refused = async (pattern: RegExp) => {
    const r = await s.retry(id);
    assert.equal(r.status, 409);
    assert.match(r.body.error, pattern);
  };
  s.t.store.updateBot(s.bots.B.id, { paused: 1 });
  await refused(/已被暂停/);
  s.t.store.updateBot(s.bots.B.id, { paused: 0 });

  s.t.store.updateBot(s.bots.A.id, { can_call: JSON.stringify([]) });
  await refused(/没有调用 B 的权限/);
  s.t.store.updateBot(s.bots.A.id, { can_call: null });

  s.t.store.db.prepare("UPDATE calls SET depth=5 WHERE id=?").run(id);
  await refused(/调用深度/);
  s.t.store.db.prepare("UPDATE calls SET depth=1, chain=? WHERE id=?").run(JSON.stringify([s.bots.B.id, s.bots.A.id]), id);
  await refused(/循环调用/);
  s.t.store.db.prepare("UPDATE calls SET chain=NULL WHERE id=?").run(id);
  await refused(/旧版本/);
  assert.equal((await s.task(id)).can_retry, false);
  s.t.store.db.prepare("UPDATE calls SET chain=? WHERE id=?").run(JSON.stringify([s.bots.A.id]), id);

  const stoppedConv = await s.say("C");
  const c = await s.waitRt("C");
  const other = await s.assign(c, { bot: "D" });
  (await s.waitRt("D")).emit({ type: "turn_end", status: "failed", error: "炸了" });
  await s.settle(other.task_id, "failed");
  // An agent slow to stop keeps the round open but stopping.
  c.interrupt = async () => {};
  await s.t.api("POST", `/api/conversations/${stoppedConv}/interrupt`, {});
  const r = await s.retry(other.task_id);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /已被停止/);
  c.reply("完");
  await s.idle(stoppedConv);

  assert.equal((await s.retry("missing")).status, 404);
  // Finished work is not retried, and neither is an attempt that has been replaced.
  const fine = await s.retry(id);
  assert.equal(fine.status, 202);
  assert.match((await s.retry(id)).body.error, /只有失败|已经重试/);
  const b = await s.waitRt("B", 2);
  b.reply("好了");
  await s.settle(fine.body.id, "done");
  assert.match((await s.retry(fine.body.id)).body.error, /只有失败/);
  assert.match((await s.retry(id)).body.error, /已经重试/);
  await s.end();
});

test("retry after the round ended opens a new one with its budget, approvals still apply, and the next turn hears the result", async () => {
  const s = await setup();
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  const first = await s.assign(a, { bot: "B", task: "接着做" });
  const b = await s.waitRt("B");
  a.reply("我先结束了");
  await s.idle(convId);
  await s.settle(first.task_id, "interrupted");
  const roundsBefore = s.t.store.db.prepare("SELECT COUNT(*) n FROM root_turns WHERE conv_id=?").get(convId)!.n as number;

  const r = await s.retry(first.task_id);
  assert.equal(r.status, 202);
  await s.t.waitFor(() => b.sent.length === 2, "same session resumed");
  assert.equal((await s.conv(convId)).status, "running");
  assert.equal((await s.t.api("POST", `/api/bots/${s.bots.A.id}/messages`, { text: "又一条", conversationId: convId })).status, 409, "the round holds the conversation like any other");
  assert.equal(s.t.store.db.prepare("SELECT COUNT(*) n FROM root_turns WHERE conv_id=?").get(convId)!.n, roundsBefore + 1);
  const row = s.t.store.getCall(r.body.id)!;
  assert.equal(row.retry_of, first.task_id);
  assert.equal(row.depth, 1);
  assert.equal(JSON.parse(row.chain as string)[0], s.bots.A.id);

  // The called Bot's approval still reaches the person.
  b.emit({ type: "approval", requestId: "r9", title: "写文件", detail: "", canRemember: false });
  const card = await s.t.waitFor(async () => (await s.items(convId)).find((i) => i.type === "approval" && i.status === "pending"), "approval card") as any;
  assert.equal(card.data.from, "B");
  await s.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" });
  assert.deepEqual(b.answers, [["r9", "allow"]]);

  // Its nested calls keep the original depth and chain.
  assert.match((await s.bus(b, "ask_bot", { bot: "A", question: "循环" })).text, /循环调用/);

  b.reply("做完了");
  await s.idle(convId);
  const tasks = await s.tasks(convId);
  assert.deepEqual(tasks.map((t) => [t.id, t.status, t.attempt]), [[r.body.id, "done", 2]]);
  const notice = (await s.items(convId)).find((i) => i.type === "notice");
  assert.match(notice.data.text, /做完了/);

  // The caller did not hear this while it was idle; it does on its next message, once.
  await s.say("A", "看下结果", convId);
  await s.waitRt("A", 2);
  assert.match(a.sent[1], /平台通知.*做完了[\s\S]*看下结果/);
  a.reply("好");
  await s.idle(convId);
  await s.say("A", "再来", convId);
  await s.waitRt("A", 3);
  assert.equal(a.sent[2], "再来");
  // An earlier round's task can still be read, and the old id leads to the newest attempt.
  assert.equal(JSON.parse((await s.bus(a, "get_task", { task_id: first.task_id })).text).status, "done");
  a.reply("好");
  await s.end();
});

test("a retried task's budget overrun stops it like any other round", async () => {
  const s = await setup({ budget: 1000 });
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  const first = await s.assign(a, { bot: "B" });
  const b = await s.waitRt("B");
  a.reply("结束");
  await s.idle(convId);
  const r = await s.retry(first.task_id);
  await s.t.waitFor(() => b.sent.length === 2, "retried");
  b.emit({ type: "usage_tick", tokens: 5000 });
  await s.settle(r.body.id, "interrupted");
  assert.match((await s.task(r.body.id)).failure_reason, /预算用完/);
  await s.idle(convId);
  assert.equal(s.t.store.latestRootTurn(convId)!.status, "over_budget");
  await s.end();
});

test("a retry needs its dependencies done first, and can queue behind one being retried", async () => {
  const s = await setup();
  await s.say("A");
  const a = await s.waitRt("A");
  const first = await s.assign(a, { bot: "B" });
  const second = await s.assign(a, { bot: "C", depends_on: [first.task_id] });
  (await s.waitRt("B")).emit({ type: "turn_end", status: "failed", error: "炸了" });
  await s.settle(second.task_id, "failed");
  const refused = await s.retry(second.task_id);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /请先重试/);

  const dep = await s.retry(first.task_id);
  assert.equal(dep.status, 202);
  const queued = await s.retry(second.task_id);
  assert.equal(queued.status, 202);
  assert.equal(queued.body.status, "waiting");
  assert.equal(queued.body.depends_on[0].id, dep.body.id, "the dependency is shown as its newest attempt");
  (await s.waitRt("B", 2)).reply("这次好了");
  const c = await s.waitRt("C");
  assert.match(c.sent[0], /这次好了/);
  c.reply("好");
  await s.settle(queued.body.id, "done");
  a.reply("完");
  await s.end();
});

test("after a restart nothing claims to be running: tasks are interrupted, say why, and can be retried", async () => {
  const home = tempHome();
  const s = await setup({ home, names: ["A", "B", "C"] });
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  const running = await s.assign(a, { bot: "B", task: "还在跑" });
  const queued = await s.assign(a, { bot: "C", task: "还在等", depends_on: [running.task_id] });
  const b = await s.waitRt("B");
  b.emit({ type: "session", sessionId: "sess-b" });
  const done = await s.assign(a, { bot: "C", task: "已完成" }).catch(() => null);
  assert.ok(done);
  (await s.waitRt("C")).reply("早就好了");
  await s.settle(done!.task_id, "done");
  s.t.close(); // The daemon goes away mid-round.

  const again = await setup({ home });
  assert.equal((await again.conv(convId)).status, "idle");
  for (const id of [running.task_id, queued.task_id]) {
    const view = await again.task(id);
    assert.equal(view.status, "interrupted");
    assert.equal(view.waiting_reason, null);
    assert.match(view.failure_reason, /守护进程重启/);
    assert.equal(view.can_retry, true);
  }
  assert.equal((await again.task(done!.task_id)).status, "done", "finished work keeps its result");
  assert.equal((await again.task(done!.task_id)).answer, "早就好了");
  const card = (await again.items(convId)).find((i) => i.data.callId === running.task_id);
  assert.equal(card.status, "interrupted");
  assert.match(card.data.answer, /守护进程重启/);

  // A second restart leaves the record alone.
  again.t.close();
  const third = await setup({ home });
  const r = await third.retry(running.task_id);
  assert.equal(r.status, 202);
  const b2 = await third.waitRt("B");
  assert.equal(b2.opts.sessionId, "sess-b", "the agent's session resumes");
  assert.match(b2.sent[0], /这是一次重试.*守护进程重启/);
  b2.reply("接着做完了");
  await third.idle(convId);
  assert.equal((await third.task(r.body.id)).status, "done");
  third.t.close();
});

test("tasks recorded before this version are upgraded and reported truthfully", () => {
  const home = tempHome();
  const first = new Store(home);
  first.close();
  const db = new DatabaseSync(join(home, "platform.db"));
  db.exec("DROP INDEX calls_retry");
  for (const c of ["reason", "chain", "depends_on", "retry_of", "timeout_ms"]) db.exec(`ALTER TABLE calls DROP COLUMN ${c}`);
  db.prepare("INSERT INTO calls (id,root_turn_id,root_conv_id,caller_conv_id,from_bot,to_bot,mode,depth,question,status,created_at) VALUES ('old','r','c','c','A','B','task',1,'q','running',1)").run();
  db.close();
  const store = new Store(home);
  store.recover();
  const row = store.getCall("old")!;
  assert.equal(row.status, "interrupted");
  assert.match(row.reason as string, /守护进程重启/);
  assert.equal(row.chain, null);
  store.close();
});

test("the task page is served under the CSP and uses no inline styles", async () => {
  const s = await setup({ names: [] });
  const res = await fetch(`${s.t.base}/tasks.js`);
  assert.equal(res.status, 200);
  const source = await res.text();
  assert.doesNotMatch(source, /style=|innerHTML/);
  const crossSite = await fetch(`${s.t.base}/api/tasks/x/retry`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(crossSite.status, 403);
  await s.end();
});
