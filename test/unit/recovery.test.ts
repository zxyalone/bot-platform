import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
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
  fail(error = "磁盘满了") {
    this.emit({ type: "turn_end", status: "failed", error });
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

async function setup(home?: string) {
  const made: Fake[] = [];
  const t = await boot((opts) => {
    const f = new Fake(opts);
    made.push(f);
    return f;
  }, { home });
  const cwd = mkdtempSync(join(tmpdir(), "bot-proj-"));
  const newBot = async (name: string, dir = cwd, extra: object = {}) => (await t.api("POST", "/api/bots", { name, role: "R", agent: "codex", model: "gpt-6-luna", cwd: dir, ...extra })).body;
  const bot = await newBot("A");
  const items = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];
  const conversation = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation;
  const idle = (id: string) => t.waitFor(async () => (await conversation(id)).status === "idle", "idle");
  const next = async (before: number) => {
    await t.waitFor(() => made.length > before && made.at(-1)!.sent.length, "agent");
    return made.at(-1)!;
  };
  // The agent that has just been sent this; sending happens a moment after the API answers.
  const sentTo = async (re: RegExp) => {
    let hit: Fake | undefined;
    await t.waitFor(() => (hit = made.find((m) => re.test(m.sent.at(-1) ?? ""))), `agent told ${re}`);
    return hit!;
  };
  const start = async (text = "做", on = bot) => {
    const before = made.length;
    const conv = (await t.api("POST", `/api/bots/${on.id}/messages`, { text })).body.id as string;
    return { conv, f: await next(before) };
  };
  const errorOf = async (conv: string) => {
    await t.waitFor(async () => (await items(conv)).some((i) => i.type === "error"), "error card");
    return (await items(conv)).findLast((i) => i.type === "error");
  };
  const failed = async (text = "做", on = bot) => {
    const s = await start(text, on);
    s.f.fail();
    await idle(s.conv);
    return { ...s, error: await errorOf(s.conv) };
  };
  const retry = (id: string) => t.api("POST", `/api/items/${id}/retry`, {});
  const handoff = (id: string, botId: string) => t.api("POST", `/api/items/${id}/handoff`, { botId });
  const inbox = async () => (await t.api("GET", "/api/inbox")).body.items as any[];
  return { t, made, cwd, bot, newBot, items, conversation, idle, next, sentTo, start, errorOf, failed, retry, handoff, inbox };
}

// ---------- retrying ----------
test("retrying a failed round sends an ordinary message: same agent session, new round, says what failed", async () => {
  const s = await setup();
  const { conv, error } = await s.failed("写报告");
  const rounds = () => s.t.store.db.prepare("SELECT COUNT(*) n FROM root_turns WHERE conv_id=?").get(conv) as { n: number };
  const before = rounds().n;
  const r = await s.retry(error.id);
  assert.equal(r.status, 202);
  assert.deepEqual(r.body.data.recovery, { action: "retry" });
  assert.equal((await s.conversation(conv)).status, "running");
  assert.equal(rounds().n, before + 1);
  const rt = await s.sentTo(/重试上一步/);
  const sent = rt.sent.at(-1)!;
  assert.match(sent, /磁盘满了/);
  assert.match(sent, /写报告/);
  assert.match(sent, /先确认再继续/);
  assert.equal((await s.items(conv)).filter((i) => i.type === "user").length, 2);
  rt.reply();
  await s.idle(conv);
  s.t.close();
});

test("a retry cannot go around the rules for a message: running, handled twice, or out of date", async () => {
  const s = await setup();
  const { conv, error } = await s.failed();
  const [one, two] = await Promise.all([s.retry(error.id), s.retry(error.id)]);
  assert.deepEqual([one.status, two.status].sort(), [202, 409], "a double click starts it once");
  assert.equal((await s.items(conv)).filter((i) => i.type === "user").length, 2);
  (await s.sentTo(/重试上一步/)).reply();
  await s.idle(conv);
  assert.equal((await s.retry(error.id)).status, 409, "already retried");

  // The person has moved on since this one failed.
  const second = await s.failed("第二个");
  await s.t.api("POST", `/api/bots/${s.bot.id}/messages`, { text: "别管了，做别的", conversationId: second.conv });
  assert.equal((await s.retry(second.error.id)).status, 409, "the new message is still running");
  (await s.sentTo(/别管了/)).reply();
  await s.idle(second.conv);
  assert.match((await s.retry(second.error.id)).body.error, /新消息/);
  s.t.close();
});

test("a retry still runs under the per-round budget and still asks for approval", async () => {
  const s = await setup();
  const low = await s.newBot("Low", s.cwd, { budget_tokens: 10000 });
  const { conv, error } = await s.failed("做", low);
  assert.equal((await s.retry(error.id)).status, 202);
  const rt = await s.sentTo(/重试上一步/);
  rt.emit({ type: "approval", requestId: "r1", title: "写文件", detail: "", canRemember: false });
  await s.t.waitFor(async () => (await s.items(conv)).some((i) => i.type === "approval" && i.status === "pending"), "approval");
  assert.equal((await s.inbox())[0].kind, "approval");
  rt.emit({ type: "usage_tick", tokens: 20000 });
  await s.t.waitFor(async () => (await s.items(conv)).some((i) => i.type === "error" && /达到预算/.test(i.data.message)), "budget stop");
  await s.idle(conv);
  s.t.close();
});

test("only the members that failed run again in a group, even when the request names others", async () => {
  const s = await setup();
  const a2 = await s.newBot("B");
  const group = (await s.t.api("POST", "/api/groups", { name: "G", members: [s.bot.id, a2.id], cwd: s.cwd })).body;
  const conv = (await s.t.api("POST", `/api/groups/${group.id}/messages`, { text: "@A @B 都看看" })).body.id as string;
  await s.t.waitFor(() => s.made.length === 1 && s.made[0].sent.length, "A runs");
  s.made[0].fail();
  await s.t.waitFor(() => s.made.length === 2 && s.made[1].sent.length, "B runs");
  s.made[1].reply();
  await s.idle(conv);
  const error = await s.errorOf(conv);
  assert.equal(error.data.bot.name, "A");
  const sentToB = s.made[1].sent.length;
  assert.equal((await s.retry(error.id)).status, 202);
  assert.ok((await s.items(conv)).at(-1).data.text.startsWith("@A 重试上一步"));
  (await s.sentTo(/重试上一步/)).reply();
  await s.idle(conv);
  assert.equal(s.made[1].sent.length, sentToB, "B did nothing");
  s.t.close();
});

test("a failed task is retried through retryTask; a failed ask_bot cannot be retried from its card", async () => {
  const s = await setup();
  const b = await s.newBot("B");
  const { conv, f } = await s.start("派活");
  const bus = (tool: string, args: object) => fetch(`${s.t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json() as Promise<{ text: string }>);
  const task = JSON.parse((await bus("assign_task", { bot: "B", task: "查一下" })).text);
  await s.t.waitFor(() => s.made.length === 2 && s.made[1].sent.length, "B runs");
  s.made[1].fail("炸了");
  const childId = s.t.store.getCall(task.task_id)!.child_conv_id as string;
  const error = await s.errorOf(childId);
  assert.equal(error.data.callId, task.task_id);
  assert.equal(error.data.callMode, "task");
  const r = await s.retry(error.id);
  assert.equal(r.status, 202);
  await s.t.waitFor(() => s.t.store.latestAttempt(task.task_id)!.id !== task.task_id, "a new attempt");
  assert.equal(s.t.store.latestAttempt(task.task_id)!.retry_of, task.task_id);
  assert.equal((await s.retry(error.id)).status, 409);
  await s.t.waitFor(() => s.made.at(-1)!.sent.length, "attempt 2 runs");
  s.made.at(-1)!.reply();

  const asked = bus("ask_bot", { bot: "B", question: "再问" });
  await s.t.waitFor(() => /再问/.test(s.made.at(-1)!.sent.at(-1) ?? ""), "ask reaches B");
  s.made.at(-1)!.fail("又炸了");
  await asked;
  const askError = (await s.items(childId)).findLast((i) => i.type === "error");
  assert.equal(askError.data.callMode, "ask");
  assert.match((await s.retry(askError.id)).body.error, /提问/);
  f.reply();
  await s.idle(conv);
  assert.ok(b.id);
  s.t.close();
});

test("notices that are not failures and rounds the person did not start have nothing to rerun", async () => {
  const s = await setup();
  const { conv } = await s.start();
  const paused = s.t.store.addItem({ convId: conv, turnId: null, type: "error", status: "done", data: { message: "Chief 暂停了 B", noRecover: true } });
  assert.match((await s.retry(paused.id)).body.error, /不是失败/);
  assert.match((await s.handoff(paused.id, s.bot.id)).body.error, /不是失败/);
  s.made.at(-1)!.reply();
  await s.idle(conv);
  const noRequest = s.t.store.addItem({ convId: conv, turnId: null, type: "error", status: "done", data: { message: "炸了" } });
  assert.match((await s.retry(noRequest.id)).body.error, /不是由你的消息发起/);
  s.t.close();
});

test("a restart can retry the message it cut off, but not one whose round had already reported back", async () => {
  const home = tempHome();
  const s = await setup(home);
  const { conv, f } = await s.start("长任务");
  assert.ok(f);
  s.t.close();
  const again = await setup(home);
  const error = await again.errorOf(conv);
  assert.ok(error.data.requestItemId);
  const r = await again.retry(error.id);
  assert.equal(r.status, 202);
  await again.t.waitFor(() => again.made.at(-1)?.sent.length, "sent");
  assert.match(again.made.at(-1)!.sent.at(-1)!, /长任务/);
  again.made.at(-1)!.reply();
  await again.idle(conv);

  // The round finished, then the platform woke the Bot and the daemon died during that.
  again.t.store.updateConversation(conv, { status: "running" });
  again.t.close();
  const third = await setup(home);
  const later = await third.errorOf(conv);
  assert.notEqual(later.id, error.id);
  assert.equal(later.data.requestItemId, undefined);
  third.t.close();
});

// ---------- handing off ----------
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "bot-repo-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd });
  git("init", "-q");
  writeFileSync(join(cwd, "a.py"), "1\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return cwd;
}

test("handing off starts the other Bot with the facts, and does not claim the work survived", async () => {
  const s = await setup();
  const cwd = repo();
  const a = await s.newBot("Writer", cwd);
  const b = await s.newBot("Same", cwd);
  const elsewhere = await s.newBot("Far");
  const { conv, f } = await s.start("改 a.py", a);
  f.emit({ type: "text_done", key: "k", text: "我已经全部改好了" });
  writeFileSync(join(cwd, "a.py"), "2\n");
  f.fail("连接断开");
  await s.idle(conv);
  const error = await s.errorOf(conv);
  await s.t.waitFor(async () => (await s.items(conv)).some((i) => i.type === "result"), "result card");

  assert.match((await s.handoff(error.id, a.id)).body.error, /失败的那个/);
  assert.equal((await s.handoff(error.id, "nope")).status, 404);

  const before = s.made.length;
  const r = await s.handoff(error.id, b.id);
  assert.equal(r.status, 202);
  const rt = await s.next(before);
  const text = rt.sent.at(-1)!;
  assert.equal(r.body.conversation.bot_id, b.id);
  assert.notEqual(r.body.conversation.id, conv);
  assert.deepEqual(r.body.item.data.recovery, { action: "handoff", convId: r.body.conversation.id, botId: b.id, bot: "Same" });
  assert.match(r.body.conversation.title, /接手 Writer/);
  assert.match(text, /改 a\.py/);
  assert.match(text, /连接断开/);
  assert.match(text, /上下文没有带过来/);
  assert.match(text, /自述，没有核实[^]*我已经全部改好了/);
  assert.match(text, /a\.py[^]*Git/);
  assert.match(text, /工作目录和 Writer 相同/);
  assert.match(text, /不要假定任何工作已经完成/);
  assert.equal((await s.handoff(error.id, elsewhere.id)).status, 409, "handled already");
  assert.equal((await s.retry(error.id)).status, 409);
  rt.reply();
  await s.idle(r.body.conversation.id);

  const other = await s.failed("再来", a);
  const far = await s.handoff(other.error.id, elsewhere.id);
  const farRt = await s.sentTo(/工作目录不同[^]*看不到/);
  farRt.reply();
  await s.idle(far.body.conversation.id);
  s.t.close();
});

test("a Bot with nothing on record is not credited with any work", async () => {
  const s = await setup();
  const b = await s.newBot("B");
  const { error } = await s.failed();
  const r = await s.handoff(error.id, b.id);
  const rt = await s.sentTo(/接手 A/);
  assert.match(rt.sent.at(-1)!, /失败前没有留下文字/);
  assert.match(rt.sent.at(-1)!, /没有记录到文件改动/);
  rt.reply();
  await s.idle(r.body.conversation.id);
  s.t.close();
});

// ---------- the result card ----------
test("the result card of a failed round says it failed, not that it completed", async () => {
  const s = await setup();
  const cwd = repo();
  const a = await s.newBot("Writer", cwd);
  const card = async (conv: string) => {
    await s.t.waitFor(async () => (await s.items(conv)).some((i) => i.type === "result"), "result card");
    return (await s.items(conv)).findLast((i) => i.type === "result");
  };
  const bad = await s.start("改", a);
  writeFileSync(join(cwd, "a.py"), "2\n");
  bad.f.fail();
  await s.idle(bad.conv);
  assert.equal((await card(bad.conv)).status, "failed");
  assert.equal(s.t.store.latestRootTurn(bad.conv)!.status, "failed");

  const good = await s.start("再改", a);
  writeFileSync(join(cwd, "a.py"), "3\n");
  good.f.reply();
  await s.idle(good.conv);
  assert.equal((await card(good.conv)).status, "completed", "a new round starts clean");
  s.t.close();
});

test("a task failing does not fail a round that went on; a retried task on its own round does", async () => {
  const s = await setup();
  await s.newBot("B");
  const cwd = repo();
  const a = await s.newBot("Writer", cwd);
  const { conv, f } = await s.start("派活", a);
  const task = JSON.parse(((await (await fetch(`${s.t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool: "assign_task", args: { bot: "B", task: "查" } }) })).json()) as { text: string }).text);
  const child = await s.sentTo(/查/);
  child.fail("炸了");
  await s.t.waitFor(() => s.t.store.getCall(task.task_id)!.status === "failed", "task failed");
  writeFileSync(join(cwd, "a.py"), "2\n");
  f.reply();
  await s.idle(conv);
  assert.equal(s.t.store.latestRootTurn(conv)!.status, "completed");

  assert.equal((await s.t.api("POST", `/api/tasks/${task.task_id}/retry`, {})).status, 202);
  await s.t.waitFor(() => child.sent.length === 2, "second attempt");
  child.fail("又炸了");
  await s.idle(conv);
  assert.equal(s.t.store.latestRootTurn(conv)!.status, "failed");
  s.t.close();
});

// ---------- inbox ----------
test("the inbox lists pending approvals, unsent messages and unaccepted results until each is dealt with", async () => {
  const s = await setup();
  const cwd = repo();
  const a = await s.newBot("Writer", cwd);
  assert.deepEqual(await s.inbox(), []);

  // A result card, across a conversation other than the one on screen.
  const first = await s.start("改", a);
  writeFileSync(join(cwd, "a.py"), "2\n");
  first.f.reply("改好了");
  await s.idle(first.conv);
  await s.t.waitFor(async () => (await s.inbox()).length === 1, "result");
  const [result] = await s.inbox();
  assert.equal(result.kind, "result");
  assert.equal(result.conv_id, first.conv);
  assert.equal(result.bot_id, a.id);
  assert.equal(result.title, "改好了");

  // An approval and a message that did not go out.
  const second = await s.start("再做");
  second.f.emit({ type: "approval", requestId: "r", title: "写文件", detail: "", canRemember: false });
  await s.t.waitFor(async () => (await s.inbox()).some((i) => i.kind === "approval"), "approval");
  await s.t.api("POST", `/api/conversations/${second.conv}/followup`, { text: "排队的话", mode: "queue" });
  assert.equal((await s.inbox()).length, 2, "still queued is not yet a problem");
  const approval = (await s.inbox()).find((i) => i.kind === "approval");
  assert.equal(approval.title, "写文件");
  await s.t.api("POST", `/api/approvals/${approval.id}`, { decision: "deny" });
  assert.ok(!(await s.inbox()).some((i) => i.kind === "approval"));
  await s.t.api("POST", `/api/conversations/${second.conv}/interrupt`, {});
  await s.idle(second.conv);
  await s.t.waitFor(async () => (await s.inbox()).some((i) => i.kind === "unsent"), "unsent");
  const unsent = (await s.inbox()).find((i) => i.kind === "unsent");
  assert.equal(unsent.title, "排队的话");
  assert.match(unsent.detail, /停止/);

  // Nothing about how it got here.
  const text = JSON.stringify(await s.inbox());
  assert.doesNotMatch(text, /token|budget|chain|depth|spent/i);

  await s.t.api("POST", `/api/items/${unsent.id}/withdraw`, {});
  await s.t.api("POST", `/api/items/${result.id}/accept`, {});
  assert.deepEqual(await s.inbox(), []);
  s.t.close();
});

test("the inbox skips conversations that can no longer be opened, including those of an archived Bot", async () => {
  const s = await setup();
  const a = await s.newBot("Gone", repo());
  const put = (conv: string) => s.t.store.addItem({ convId: conv, turnId: null, type: "queued", status: "unsent", data: { text: "x", reason: "r" } });
  const one = await s.failed("1", a);
  const two = await s.failed("2");
  const three = await s.failed("3");
  put(one.conv);
  put(two.conv);
  put(three.conv);
  assert.equal((await s.inbox()).length, 3);
  assert.equal((await s.t.api("DELETE", `/api/conversations/${two.conv}`)).status < 300, true);
  assert.equal((await s.inbox()).length, 2);
  assert.equal((await s.t.api("DELETE", `/api/bots/${a.id}`)).status < 300, true);
  const left = await s.inbox();
  assert.deepEqual(left.map((i) => i.conv_id), [three.conv]);
  s.t.close();
});

test("the web bundle's new module and buttons are served", async () => {
  const s = await setup();
  const res = await fetch(`${s.t.base}/inbox.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /mountInbox/);
  const app = await (await fetch(`${s.t.base}/app.js`)).text();
  for (const label of ["重试这一步", "换 Bot 接手", "补充信息"]) assert.ok(app.includes(label), label);
  s.t.close();
});
