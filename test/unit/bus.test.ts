import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, tempHome } from "../helpers.ts";
import { parseMentions } from "../../src/daemon/engine.ts";
import { Store } from "../../src/daemon/store.ts";
import type { AgentEvent, AgentRuntime, ApprovalDecision, Bot, RuntimeOptions } from "../../src/daemon/types.ts";

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

async function setup(names = ["A", "B", "C", "D", "E"], botPatch: Record<string, unknown> = {}) {
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  });
  const bots: Record<string, any> = {};
  for (const n of names) bots[n] = (await t.api("POST", "/api/bots", { name: n, role: `ROLE-${n}`, agent: "codex", model: "gpt-6-luna", ...botPatch })).body;
  const rt = (n: string, index = 0) => made.filter((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`))[index];
  const waitRt = async (n: string, sends = 1, index = 0) => {
    await t.waitFor(() => (rt(n, index)?.sent.length ?? 0) >= sends, `${n} to receive ${sends}`);
    return rt(n, index);
  };
  const bus = (f: Fake, tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()).catch(() => ({ text: "server closed", isError: true })) as Promise<{ text: string; isError: boolean }>;
  const say = async (n: string, text = "go") => (await t.api("POST", `/api/bots/${bots[n].id}/messages`, { text })).body.id as string;
  const items = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];
  const conv = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation;
  return { t, made, bots, rt, waitRt, bus, say, items, conv };
}

test("a bus call without a valid token is refused", async () => {
  const { t } = await setup(["A"]);
  const r = await fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: JSON.stringify({ tool: "list_bots", args: {} }) }).then((x) => x.json());
  assert.equal(r.isError, true);
  t.close();
});

test("ask_bot runs the other Bot in the caller's directory and returns its last message", async () => {
  const s = await setup();
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  const pending = s.bus(a, "ask_bot", { bot: "b", question: "审查 x.py" });
  const b = await s.waitRt("B");
  assert.equal(b.opts.cwd, a.opts.cwd);
  assert.match(b.sent[0], /来自同事 Bot A/);
  assert.match(b.sent[0], /审查 x\.py/);
  b.emit({ type: "text_done", key: "1", text: "我看一下" });
  b.reply("结论：没问题", 500);
  const r = await pending;
  assert.deepEqual([r.text, r.isError], ["结论：没问题", false]);
  const cards = (await s.items(convId)).filter((i) => i.type === "call");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, "done");
  assert.equal(cards[0].data.answer, "结论：没问题");
  assert.equal(cards[0].data.tokens, 500);
  assert.equal((await s.items(convId)).some((i) => i.data.text === "我看一下"), false, "callee chatter stays out of the caller's view");
  a.reply("好了");
  const trace = (await s.t.api("GET", `/api/conversations/${convId}/trace`)).body;
  assert.equal(trace.calls[0].to, "B");
  assert.equal(trace.budget.spent, 500);
  s.t.close();
});

test("asking the same Bot again continues its session instead of starting a new agent", async () => {
  const s = await setup();
  await s.say("A");
  const a = await s.waitRt("A");
  let p = s.bus(a, "ask_bot", { bot: "B", question: "1" });
  const b = await s.waitRt("B");
  b.emit({ type: "session", sessionId: "sess-b" });
  b.reply("一");
  await p;
  p = s.bus(a, "ask_bot", { bot: "B", question: "2" });
  await s.waitRt("B", 2);
  b.reply("二");
  assert.equal((await p).text, "二");
  assert.equal(s.made.filter((f) => f.opts.systemPrompt.startsWith("ROLE-B")).length, 1);
  s.t.close();
});

test("a tool that turns out to be a bus call is hidden, since the call has its own card", async () => {
  const s = await setup(["A"]);
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  a.emit({ type: "tool", key: "t", title: "工具调用", status: "running" });
  a.emit({ type: "tool", key: "t", title: "botbus__ask_bot", status: "done" });
  a.emit({ type: "tool", key: "t", title: "", output: "x", status: "done" });
  assert.deepEqual((await s.items(convId)).filter((i) => i.type === "tool").map((i) => i.status), ["hidden"]);
  s.t.close();
});

test("refuses self-calls, unknown names, empty questions, and calls not on the allow list", async () => {
  const s = await setup(["A", "B", "C"]);
  await s.t.api("PATCH", `/api/bots/${s.bots.A.id}`, { can_call: [s.bots.B.id] });
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  for (const [args, re] of [
    [{ bot: "A", question: "x" }, /自己/],
    [{ bot: "Nobody", question: "x" }, /没有叫/],
    [{ bot: "B", question: " " }, /不能为空/],
    [{ bot: "C", question: "x" }, /权限/],
  ] as const) {
    const r = await s.bus(a, "ask_bot", args);
    assert.equal(r.isError, true);
    assert.match(r.text, re);
  }
  assert.equal(s.made.length, 1, "no agent was started");
  assert.equal((await s.items(convId)).filter((i) => i.type === "call" && i.status === "refused").length, 4, "refusals are visible");
  assert.equal((await s.bus(a, "list_bots", {})).text.includes("C"), false);
  s.t.close();
});

test("a Bot that may call nobody keeps only its memory tools", async () => {
  const s = await setup(["A", "B"], { can_call: [] });
  await s.say("A");
  const a = await s.waitRt("A");
  assert.equal(a.opts.bus!.env.BUS_TOOLS, "remember,recall");
  s.t.close();
});

test("loops and over-deep chains are refused", async () => {
  const s = await setup();
  await s.say("A");
  const a = await s.waitRt("A");
  void s.bus(a, "ask_bot", { bot: "B", question: "x" });
  const b = await s.waitRt("B");
  const loop = await s.bus(b, "ask_bot", { bot: "A", question: "x" });
  assert.match(loop.text, /循环/);
  void s.bus(b, "ask_bot", { bot: "C", question: "x" });
  const c = await s.waitRt("C");
  void s.bus(c, "ask_bot", { bot: "D", question: "x" });
  const d = await s.waitRt("D");
  const deep = await s.bus(d, "ask_bot", { bot: "E", question: "x" });
  assert.match(deep.text, /深度/);
  assert.equal(s.rt("E"), undefined);
  s.t.close();
});

test("call limits follow the settings", async () => {
  const s = await setup();
  await s.t.api("PUT", "/api/settings", { max_depth: 1, max_active: 1 });
  await s.say("A");
  const a = await s.waitRt("A");
  void s.bus(a, "ask_bot", { bot: "B", question: "x" });
  const b = await s.waitRt("B");
  assert.match((await s.bus(b, "ask_bot", { bot: "C", question: "x" })).text, /深度已达上限 1/);
  assert.match((await s.bus(a, "ask_bot", { bot: "C", question: "x" })).text, /同时进行.*上限 1/);
  s.t.close();
});

test("a Bot asked twice at once refuses the second request", async () => {
  const s = await setup();
  await s.say("A");
  const a = await s.waitRt("A");
  void s.bus(a, "ask_bot", { bot: "B", question: "1" });
  await s.waitRt("B");
  const r = await s.bus(a, "ask_bot", { bot: "B", question: "2" });
  assert.match(r.text, /上一个请求/);
  s.t.close();
});

test("an approval from a called Bot appears in the user's conversation and reaches that Bot", async () => {
  const s = await setup();
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  void s.bus(a, "ask_bot", { bot: "B", question: "x" });
  const b = await s.waitRt("B");
  b.emit({ type: "approval", requestId: "req", title: "写文件", detail: "", canRemember: true });
  const card = (await s.items(convId)).find((i) => i.type === "approval");
  assert.equal(card.data.from, "B");
  await s.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" });
  assert.deepEqual(b.answers, [["req", "allow"]]);
  assert.equal(a.answers.length, 0);
  s.t.close();
});

test("running over the project's budget stops the whole chain, reports it, and refuses new calls", async () => {
  const s = await setup(["A", "B"]);
  await s.t.api("PUT", `/api/projects/${s.bots.A.project_memory}/settings`, { budget_total: 1000 });
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  const pending = s.bus(a, "ask_bot", { bot: "B", question: "x" });
  const b = await s.waitRt("B");
  b.emit({ type: "usage_tick", tokens: 600 });
  assert.equal(b.interrupted, 0);
  a.emit({ type: "usage_tick", tokens: 500 });
  assert.equal(a.interrupted, 1);
  assert.equal(b.interrupted, 1);
  assert.equal((await pending).isError, true);
  await s.t.waitFor(async () => (await s.conv(convId)).status === "idle", "idle");
  assert.ok((await s.items(convId)).some((i) => i.type === "error" && /预算/.test(i.data.message)));
  const trace = (await s.t.api("GET", `/api/conversations/${convId}/trace`)).body;
  assert.equal(trace.budget.status, "over_budget");
  assert.equal(trace.budget.spent, 1100);
  s.t.close();
});

test("budget counts uncached tokens, and final usage replaces the running estimate", async () => {
  const s = await setup(["A"]);
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  a.emit({ type: "usage_tick", tokens: 90 });
  a.emit({ type: "usage", inputTokens: 1000, cachedTokens: 900, outputTokens: 20 });
  a.emit({ type: "turn_end", status: "completed" });
  await s.t.waitFor(async () => (await s.conv(convId)).status === "idle", "idle");
  assert.equal((await s.t.api("GET", `/api/conversations/${convId}/trace`)).body.budget.spent, 120);
  s.t.close();
});

test("stopping the conversation also stops the Bots it called", async () => {
  const s = await setup();
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  const pending = s.bus(a, "ask_bot", { bot: "B", question: "x" });
  const b = await s.waitRt("B");
  await s.t.api("POST", `/api/conversations/${convId}/interrupt`, {});
  assert.equal(b.interrupted, 1);
  const r = await pending;
  assert.equal(r.isError, true);
  await s.t.waitFor(async () => (await s.conv(convId)).status === "idle", "idle");
  assert.equal((await s.items(convId)).find((i) => i.type === "call").status, "interrupted");
  s.t.close();
});

test("assign_task runs in parallel, get_task waits, and at most three run at once", async () => {
  const s = await setup();
  await s.say("A");
  const a = await s.waitRt("A");
  const ids: string[] = [];
  for (const n of ["B", "C", "D"]) ids.push(JSON.parse((await s.bus(a, "assign_task", { bot: n, task: "做" })).text).task_id);
  assert.match((await s.bus(a, "assign_task", { bot: "E", task: "做" })).text, /同时进行/);
  const b = await s.waitRt("B");
  assert.equal(JSON.parse((await s.bus(a, "get_task", { task_id: ids[0] })).text).status, "running");
  const waiting = s.bus(a, "get_task", { task_id: ids[0], wait_seconds: 30 });
  b.reply("B 的结果");
  const done = JSON.parse((await waiting).text);
  assert.deepEqual([done.status, done.answer], ["done", "B 的结果"]);
  assert.equal((await s.bus(a, "get_task", { task_id: "missing" })).isError, true);
  s.t.close();
});

test("a task left uncollected is stopped when the turn ends", async () => {
  const s = await setup();
  const convId = await s.say("A");
  const a = await s.waitRt("A");
  await s.bus(a, "assign_task", { bot: "B", task: "做" });
  const b = await s.waitRt("B");
  a.reply("我先结束了");
  await s.t.waitFor(() => b.interrupted === 1, "task stopped");
  await s.t.waitFor(async () => (await s.conv(convId)).status === "idle", "idle");
  s.t.close();
});

test("a group runs mentioned Bots in order, each seeing what came before and not its own words", async () => {
  const s = await setup(["A", "B", "C"]);
  const g = (await s.t.api("POST", "/api/groups", { name: "作战室", members: [s.bots.A.id, s.bots.B.id, s.bots.C.id] })).body;
  const send = (text: string, conversationId?: string) => s.t.api("POST", `/api/groups/${g.id}/messages`, { text, conversationId });
  assert.equal((await send("大家好")).status, 400, "needs a mention");
  const convId = (await send("@B 先说，@A 再补充")).body.id;
  const b = await s.waitRt("B");
  assert.equal(s.rt("A"), undefined, "A waits for B");
  assert.match(b.opts.systemPrompt, /作战室/);
  assert.equal(b.opts.cwd, g.cwd);
  b.reply("B 的观点");
  const a = await s.waitRt("A");
  assert.match(a.sent[0], /\[B\]：B 的观点/);
  a.reply("A 的补充");
  await s.t.waitFor(async () => (await s.conv(convId)).status === "idle", "group idle");
  const list = await s.items(convId);
  assert.deepEqual(list.filter((i) => i.type === "assistant").map((i) => i.data.bot.name), ["B", "A"]);

  await send("@B 再看看", convId);
  await s.waitRt("B", 2);
  assert.match(b.sent[1], /A 的补充/);
  assert.doesNotMatch(b.sent[1], /B 的观点/, "not resent to its author");
  assert.doesNotMatch(b.sent[1], /先说/, "already seen");
  assert.equal(s.made.filter((f) => f.opts.systemPrompt.startsWith("ROLE-B")).length, 1, "same agent session");
  s.t.close();
});

test("stopping a group round skips the Bots still waiting", async () => {
  const s = await setup(["A", "B"]);
  const g = (await s.t.api("POST", "/api/groups", { name: "g", members: [s.bots.A.id, s.bots.B.id] })).body;
  const convId = (await s.t.api("POST", `/api/groups/${g.id}/messages`, { text: "@A @B" })).body.id;
  await s.waitRt("A");
  await s.t.api("POST", `/api/conversations/${convId}/interrupt`, {});
  await s.t.waitFor(async () => (await s.conv(convId)).status === "idle", "idle");
  assert.equal(s.rt("B"), undefined);
  s.t.close();
});

test("groups are validated", async () => {
  const s = await setup(["A", "B"]);
  const post = (b: unknown) => s.t.api("POST", "/api/groups", b);
  assert.equal((await post({ name: "x", members: [s.bots.A.id] })).status, 400);
  assert.equal((await post({ name: "", members: [s.bots.A.id, s.bots.B.id] })).status, 400);
  assert.equal((await post({ name: "x", members: [s.bots.A.id, "nope"] })).status, 400);
  assert.equal((await post({ name: "x", members: [s.bots.A.id, s.bots.B.id], budget_tokens: 5 })).status, 400);
  s.t.close();
});

test("mentions: order, repeats, case, and names that contain other names", () => {
  const mk = (name: string) => ({ id: name, name }) as Bot;
  const m = [mk("Rev"), mk("Reviewer"), mk("工程师")];
  const names = (t: string) => parseMentions(t, m).map((b) => b.name);
  assert.deepEqual(names("@reviewer 然后 @工程师 再 @Reviewer"), ["Reviewer", "工程师"]);
  assert.deepEqual(names("@Rev 和 @Reviewer"), ["Rev", "Reviewer"]);
  assert.deepEqual(names("没有提到"), []);
});

test("an existing stage 1 database is upgraded with its data intact", () => {
  const home = tempHome();
  const old = new DatabaseSync(join(home, "platform.db"));
  old.exec(`CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, permission TEXT NOT NULL, route TEXT NOT NULL, cwd TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), title TEXT NOT NULL, agent TEXT NOT NULL, route TEXT NOT NULL, cwd TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL DEFAULT 'idle', cost_total REAL NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO bots VALUES ('b','老 Bot','r','codex','m','low','ask','official','/tmp',0,1,1);
    INSERT INTO conversations VALUES ('c','b','老对话','codex','official','/tmp','sess','idle',0.5,0,1,1);`);
  old.close();
  const s = new Store(home);
  assert.equal(s.getBot("b")?.budget_tokens, 150000);
  const c = s.listConversations("b")[0];
  assert.deepEqual([c.title, c.session_id, c.kind, c.cost_total], ["老对话", "sess", "direct", 0.5]);
  s.addItem({ convId: "c", turnId: null, type: "user", status: "done", data: {} });
  s.close();
  new Store(home).close();
});

test("the MCP shim lists tools and forwards calls with its token", async () => {
  const s = await setup(["A", "B"]);
  await s.say("A");
  const a = await s.waitRt("A");
  const bus = a.opts.bus!;
  assert.equal(dirname(bus.args[0]), join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "daemon"));
  const child = spawn(bus.command, bus.args, { env: { ...process.env, ...bus.env } });
  const replies: any[] = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      replies.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const w = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
  w({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  w({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  w({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_bots", arguments: {} } });
  await s.t.waitFor(() => replies.length === 3, "shim replies");
  child.kill();
  const names = replies[1].result.tools.map((x: any) => x.name);
  assert.ok(names.includes("ask_bot") && names.includes("remember"));
  assert.equal(names.includes("create_bot"), false, "only Chief sees the management tools");
  assert.match(replies[2].result.content[0].text, /ROLE-B/);
  s.t.close();
});
