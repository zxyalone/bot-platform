import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, tempHome } from "../helpers.ts";
import type { AgentEvent, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

class Fake implements AgentRuntime {
  sent: string[] = [];
  answers: [string, ApprovalDecision][] = [];
  interrupted = 0;
  stopped = 0;
  opts: RuntimeOptions;
  startError: Error | null = null;
  ignoreInterrupt = false;
  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }
  emit(e: AgentEvent) {
    this.opts.onEvent(e);
  }
  async start() {
    if (this.startError) throw this.startError;
  }
  async send(text: string) {
    this.sent.push(text);
  }
  async interrupt() {
    this.interrupted++;
    if (!this.ignoreInterrupt) this.emit({ type: "turn_end", status: "interrupted" });
  }
  answerApproval(id: string, d: ApprovalDecision) {
    this.answers.push([id, d]);
  }
  stop() {
    this.stopped++;
  }
}

function setup(configure?: (f: Fake) => void) {
  const made: Fake[] = [];
  const factory = (o: RuntimeOptions) => {
    const f = new Fake(o);
    configure?.(f);
    made.push(f);
    return f;
  };
  return { made, factory };
}

const botBody = { name: "T", role: "你是 T", agent: "codex", model: "gpt-6-luna" };

async function startTurn(t: Awaited<ReturnType<typeof boot>>, made: Fake[], text = "hi") {
  const bot = (await t.api("POST", "/api/bots", botBody)).body;
  const sent = await t.api("POST", `/api/bots/${bot.id}/messages`, { text });
  assert.equal(sent.status, 202);
  await t.waitFor(() => made[0]?.sent.length, "send");
  return { bot, conv: sent.body, f: made[0] };
}
const items = async (t: Awaited<ReturnType<typeof boot>>, id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];

test("streams a reply, then records it with usage and frees the conversation", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f, bot } = await startTurn(t, made);
  assert.equal(f.opts.systemPrompt, "你是 T");
  assert.equal(f.opts.model, "gpt-6-luna");
  f.emit({ type: "session", sessionId: "s1" });
  f.emit({ type: "text_delta", key: "a", text: "你" });
  f.emit({ type: "text_delta", key: "a", text: "好" });
  await t.waitFor(() => t.events.filter((e) => e.type === "delta").length === 2, "stream events");
  assert.deepEqual(t.events.filter((e) => e.type === "delta").map((e) => e.text), ["你", "好"]);
  f.emit({ type: "text_done", key: "a", text: "你好" });
  f.emit({ type: "usage", inputTokens: 100, cachedTokens: 40, outputTokens: 5 });
  f.emit({ type: "turn_end", status: "completed" });
  const list = await items(t, conv.id);
  assert.deepEqual(list.map((i) => i.type), ["user", "assistant", "turn_summary"]);
  assert.equal(list[1].data.text, "你好");
  assert.equal(list[1].status, "done");
  assert.equal(list[2].data.inputTokens, 100);
  const state = (await t.api("GET", "/api/state")).body;
  const b = state.bots.find((x: any) => x.id === bot.id);
  assert.equal(b.conversations[0].status, "idle");
  assert.equal(b.conversations[0].session_id, "s1");
  assert.equal(b.usage.input_tokens, 100);
  t.close();
});

test("rejects a second message while a turn runs, and accepts one after", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f, bot } = await startTurn(t, made);
  const again = await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "x", conversationId: conv.id });
  assert.equal(again.status, 409);
  f.emit({ type: "turn_end", status: "completed" });
  const ok = await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "y", conversationId: conv.id });
  assert.equal(ok.status, 202);
  await t.waitFor(() => f.sent.length === 2, "second send");
  assert.equal(made.length, 1, "reuses the running agent process");
  t.close();
});

test("approval goes to the agent once; a repeat answer and an unknown id are refused", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f } = await startTurn(t, made);
  f.emit({ type: "approval", requestId: "r1", title: "写文件", detail: "{}", canRemember: true });
  const a = (await items(t, conv.id)).find((i) => i.type === "approval");
  assert.equal(a.status, "pending");
  assert.equal((await t.api("POST", `/api/approvals/${a.id}`, { decision: "maybe" })).status, 400);
  assert.equal((await t.api("POST", `/api/approvals/${a.id}`, { decision: "deny" })).body.status, "denied");
  assert.deepEqual(f.answers, [["r1", "deny"]]);
  assert.equal((await t.api("POST", `/api/approvals/${a.id}`, { decision: "allow" })).status, 409);
  assert.equal(f.answers.length, 1);
  assert.equal((await t.api("POST", "/api/approvals/nope", { decision: "allow" })).status, 404);
  t.close();
});

test("an approval that cannot be remembered refuses allow_session", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f } = await startTurn(t, made);
  f.emit({ type: "approval", requestId: "r1", title: "x", detail: "", canRemember: false });
  const a = (await items(t, conv.id)).find((i) => i.type === "approval");
  assert.equal((await t.api("POST", `/api/approvals/${a.id}`, { decision: "allow_session" })).status, 400);
  assert.equal(f.answers.length, 0);
  t.close();
});

test("ending a turn expires its open approvals and running tools", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f } = await startTurn(t, made);
  f.emit({ type: "tool", key: "t1", title: "运行命令", status: "running" });
  f.emit({ type: "approval", requestId: "r1", title: "x", detail: "", canRemember: true });
  f.emit({ type: "turn_end", status: "interrupted" });
  const list = await items(t, conv.id);
  assert.equal(list.find((i) => i.type === "approval").status, "expired");
  assert.equal(list.find((i) => i.type === "tool").status, "interrupted");
  const a = list.find((i) => i.type === "approval");
  assert.equal((await t.api("POST", `/api/approvals/${a.id}`, { decision: "allow" })).status, 409);
  t.close();
});

test("tool updates change one card instead of adding another", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f } = await startTurn(t, made);
  f.emit({ type: "tool", key: "t1", title: "读取 a.py", detail: "d", status: "running" });
  f.emit({ type: "tool", key: "t1", title: "", output: "内容", status: "done" });
  const tools = (await items(t, conv.id)).filter((i) => i.type === "tool");
  assert.equal(tools.length, 1);
  assert.deepEqual([tools[0].status, tools[0].data.title, tools[0].data.detail, tools[0].data.output], ["done", "读取 a.py", "d", "内容"]);
  t.close();
});

test("interrupt ends the turn and keeps the partial text", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f } = await startTurn(t, made);
  f.emit({ type: "text_delta", key: "a", text: "一半" });
  assert.equal((await t.api("POST", `/api/conversations/${conv.id}/interrupt`, {})).status, 202);
  assert.equal(f.interrupted, 1);
  const list = await items(t, conv.id);
  const msg = list.find((i) => i.type === "assistant");
  assert.equal(msg.status, "interrupted");
  assert.equal(msg.data.text, "一半");
  assert.equal(list[list.length - 1].status, "interrupted");
  t.close();
});

test("agent process exit during a turn reports failure and allows a retry that resumes", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f, bot } = await startTurn(t, made);
  f.emit({ type: "session", sessionId: "s9" });
  f.emit({ type: "exit", error: "boom" });
  const list = await items(t, conv.id);
  assert.match(list.find((i) => i.type === "error").data.message, /boom/);
  const ok = await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "再试", conversationId: conv.id });
  assert.equal(ok.status, 202);
  await t.waitFor(() => made[1]?.sent.length, "new process");
  assert.equal(made[1].opts.sessionId, "s9");
  t.close();
});

test("a start failure is shown and does not leave the conversation stuck", async () => {
  const { made, factory } = setup((f) => {
    f.startError = new Error("no binary");
  });
  const t = await boot(factory);
  const bot = (await t.api("POST", "/api/bots", botBody)).body;
  const conv = (await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "hi" })).body;
  await t.waitFor(async () => (await t.api("GET", `/api/conversations/${conv.id}/items`)).body.conversation.status === "idle", "idle");
  const list = await items(t, conv.id);
  assert.match(list.find((i) => i.type === "error").data.message, /no binary/);
  assert.equal(made.length, 1);
  t.close();
});

test("an interrupt the agent ignores is forced", { timeout: 15000 }, async () => {
  const { made, factory } = setup((f) => {
    f.ignoreInterrupt = true;
  });
  const t = await boot(factory);
  const { conv, f } = await startTurn(t, made);
  await t.api("POST", `/api/conversations/${conv.id}/interrupt`, {});
  await t.waitFor(async () => (await t.api("GET", `/api/conversations/${conv.id}/items`)).body.conversation.status === "idle", "forced stop", 10000);
  assert.equal(f.stopped, 1);
  t.close();
});

test("changing the model restarts the agent on the same session; the persona follows", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f, bot } = await startTurn(t, made);
  f.emit({ type: "session", sessionId: "s1" });
  f.emit({ type: "turn_end", status: "completed" });
  await t.api("PATCH", `/api/bots/${bot.id}`, { model: "gpt-6.1-sol", role: "新职责" });
  await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "next", conversationId: conv.id });
  await t.waitFor(() => made[1]?.sent.length, "restart");
  assert.equal(f.stopped, 1);
  assert.deepEqual([made[1].opts.model, made[1].opts.sessionId, made[1].opts.systemPrompt], ["gpt-6.1-sol", "s1", "新职责"]);
  t.close();
});

test("switching a Bot's agent blocks old conversations but new ones use the new agent", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f, bot } = await startTurn(t, made);
  f.emit({ type: "turn_end", status: "completed" });
  const patched = await t.api("PATCH", `/api/bots/${bot.id}`, { agent: "claude" });
  assert.equal(patched.body.model, "claude-opus-5-5", "picks a model of the new agent");
  assert.equal((await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "x", conversationId: conv.id })).status, 409);
  assert.equal((await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "x" })).status, 202);
  await t.waitFor(() => made[1]?.sent.length, "new conversation");
  assert.equal(made[1].opts.agent, "claude");
  t.close();
});

test("Claude's running cost total becomes a per-turn cost", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f, bot } = await startTurn(t, made);
  f.emit({ type: "usage", inputTokens: 1, cachedTokens: 0, outputTokens: 1, costTotalUsd: 0.04 });
  f.emit({ type: "turn_end", status: "completed" });
  await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "2", conversationId: conv.id });
  await t.waitFor(() => f.sent.length === 2, "second");
  f.emit({ type: "usage", inputTokens: 1, cachedTokens: 0, outputTokens: 1, costTotalUsd: 0.1 });
  f.emit({ type: "turn_end", status: "completed" });
  const sums = (await items(t, conv.id)).filter((i) => i.type === "turn_summary").map((i) => Number(i.data.costUsd.toFixed(3)));
  assert.deepEqual(sums, [0.04, 0.06]);
  t.close();
});

test("restarting the daemon closes in-flight state, keeps history and resumes the session", async () => {
  const home = tempHome();
  const first = setup();
  const a = await boot(first.factory, { home });
  const { conv, f, bot } = await startTurn(a, first.made);
  f.emit({ type: "session", sessionId: "s7" });
  f.emit({ type: "text_delta", key: "x", text: "未完成的回复" });
  f.emit({ type: "tool", key: "t", title: "跑", status: "running" });
  f.emit({ type: "approval", requestId: "r", title: "审批", detail: "", canRemember: true });
  a.close();

  const second = setup();
  const b = await boot(second.factory, { home });
  const data = (await b.api("GET", `/api/conversations/${conv.id}/items`)).body;
  assert.equal(data.conversation.status, "idle");
  const byType = (ty: string) => data.items.find((i: any) => i.type === ty);
  assert.equal(byType("assistant").status, "interrupted");
  assert.equal(byType("assistant").data.text, "未完成的回复", "partial text survives");
  assert.equal(byType("tool").status, "interrupted");
  assert.equal(byType("approval").status, "expired");
  assert.ok(byType("error"), "tells the user what happened");
  assert.equal((await b.api("POST", `/api/approvals/${byType("approval").id}`, { decision: "allow" })).status, 409);
  assert.equal((await b.api("POST", `/api/bots/${bot.id}/messages`, { text: "继续", conversationId: conv.id })).status, 202);
  await b.waitFor(() => second.made[0]?.sent.length, "resume");
  assert.equal(second.made[0].opts.sessionId, "s7");
  b.close();
});

test("idle agents are stopped and running ones are left alone", async () => {
  const { made, factory } = setup();
  const t = await boot(factory, { idleMs: 40 });
  const { f, conv, bot } = await startTurn(t, made);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(f.stopped, 0, "a running turn is not reaped");
  f.emit({ type: "session", sessionId: "s" });
  f.emit({ type: "turn_end", status: "completed" });
  await t.waitFor(() => f.stopped === 1, "reap", 40000);
  await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "again", conversationId: conv.id });
  await t.waitFor(() => made[1]?.sent.length, "restart after reap");
  assert.equal(made[1].opts.sessionId, "s");
  t.close();
});

test("archiving hides a conversation and a Bot, and refuses while running", async () => {
  const { made, factory } = setup();
  const t = await boot(factory);
  const { conv, f, bot } = await startTurn(t, made);
  assert.equal((await t.api("DELETE", `/api/conversations/${conv.id}`)).status, 409);
  assert.equal((await t.api("DELETE", `/api/bots/${bot.id}`)).status, 409);
  f.emit({ type: "turn_end", status: "completed" });
  assert.equal((await t.api("DELETE", `/api/conversations/${conv.id}`)).status, 200);
  assert.equal((await t.api("GET", `/api/conversations/${conv.id}/items`)).status, 404);
  assert.equal((await t.api("DELETE", `/api/bots/${bot.id}`)).status, 200);
  assert.equal((await t.api("GET", "/api/state")).body.bots.some((b: any) => b.id === bot.id), false);
  t.close();
});
