import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../helpers.ts";
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
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  });
  const cwd = mkdtempSync(join(tmpdir(), "bot-proj-"));
  const bots: Record<string, any> = {};
  for (const n of ["A", "B", "C"]) bots[n] = (await t.api("POST", "/api/bots", { name: n, role: `ROLE-${n}`, agent: "codex", model: "gpt-6-luna", cwd })).body;
  const rt = (n: string) => made.find((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`));
  const waitRt = async (n: string, sends = 1) => {
    await t.waitFor(() => (rt(n)?.sent.length ?? 0) >= sends, `${n} gets ${sends}`);
    return rt(n)!;
  };
  const bus = (f: Fake, tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  const calls = async (n: string) => (await t.api("GET", `/api/bots/${bots[n].id}/calls`)).body.calls as any[];
  const state = async () => (await t.api("GET", "/api/state")).body;
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end");
    await new Promise((r) => setTimeout(r, 30));
    t.close();
  };
  return { t, bots, rt, waitRt, bus, calls, state, end };
}

test("a Bot's record shows who asked what, the answer and the process, and stays out of its chats", async () => {
  const s = await setup();
  const conv = (await s.t.api("POST", `/api/bots/${s.bots.A.id}/messages`, { text: "安排一下" })).body.id;
  const a = await s.waitRt("A");
  const p = s.bus(a, "ask_bot", { bot: "B", question: "看一下数据\n第二行细节" });
  const b = await s.waitRt("B");
  assert.equal((await s.calls("B"))[0].status, "running", "it shows while it runs");
  assert.ok(s.t.events.some((e: any) => e.type === "bot_calls" && e.botId === s.bots.B.id && e.count === 1), "the page hears the count change");
  b.emit({ type: "tool", key: "t", title: "读取 data.csv", status: "done" });
  b.reply("数据没问题", 300);
  await p;
  const [c] = await s.calls("B");
  assert.deepEqual([c.from, c.mode, c.title, c.status, c.answer, c.tokens], ["A", "ask", "看一下数据", "done", "数据没问题", 300]);
  assert.match(c.question, /第二行细节/);
  assert.equal(c.conv_id, conv);
  assert.equal(c.root_title, "安排一下");
  assert.equal(c.root_open, true);
  const card = (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.items.find((i: any) => i.id === c.item_id);
  assert.equal(card.type, "call", "it leads back to the card");
  const process = (await s.t.api("GET", `/api/conversations/${c.child_conv_id}/items`)).body.items;
  assert.ok(process.some((i: any) => i.type === "tool" && i.data.title === "读取 data.csv"));

  const st = await s.state();
  const bot = st.bots.find((x: any) => x.id === s.bots.B.id);
  assert.equal(bot.call_count, 1);
  assert.equal(bot.conversations.length, 0, "not listed among its chats");
  assert.equal(st.bots.find((x: any) => x.id === s.bots.A.id).call_count, 0, "being called, not calling");
  a.reply();
  await s.end();
});

test("tasks and nested calls are listed under whoever did the work", async () => {
  const s = await setup();
  await s.t.api("POST", `/api/bots/${s.bots.A.id}/messages`, { text: "开始" });
  const a = await s.waitRt("A");
  const t1 = JSON.parse((await s.bus(a, "assign_task", { bot: "B", task: "后台活" })).text);
  const b = await s.waitRt("B");
  const p = s.bus(b, "ask_bot", { bot: "C", question: "帮 B 看看" });
  const c = await s.waitRt("C");
  c.reply("看了");
  await p;
  b.reply("做完了");
  await s.bus(a, "get_task", { task_id: t1.task_id, wait_seconds: 3 });
  const toB = await s.calls("B");
  assert.deepEqual([toB[0].from, toB[0].mode], ["A", "task"]);
  const toC = await s.calls("C");
  assert.deepEqual([toC[0].from, toC[0].question], ["B", "帮 B 看看"]);
  assert.equal(toC[0].item_id, null, "its card is in B's session, not the conversation the person opened");
  assert.equal(toC[0].root_open, true);
  a.reply();
  await s.end();
});

test("newest first; an archived origin says so; a Bot nobody called has an empty record", async () => {
  const s = await setup();
  assert.deepEqual(await s.calls("C"), []);
  const conv = (await s.t.api("POST", `/api/bots/${s.bots.A.id}/messages`, { text: "开始" })).body.id;
  const a = await s.waitRt("A");
  for (const [i, q] of ["第一个", "第二个"].entries()) {
    const p = s.bus(a, "ask_bot", { bot: "B", question: q });
    const b = await s.waitRt("B", i + 1);
    b.reply();
    await p;
  }
  assert.deepEqual((await s.calls("B")).map((c) => c.title), ["第二个", "第一个"]);
  a.reply();
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.conversation.status === "idle", "idle");
  await s.t.api("DELETE", `/api/conversations/${conv}`);
  assert.equal((await s.calls("B"))[0].root_open, false);
  assert.equal((await s.t.api("GET", "/api/bots/nope/calls")).status, 404);
  await s.end();
});

test("the web bundle's page is served", async () => {
  const s = await setup();
  assert.match(await fetch(`${s.t.base}/calls.js`).then((r) => r.text()), /mountCalls/);
  s.t.close();
});

test("every page script parses, since a page only fails when it is opened", () => {
  const web = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "web");
  for (const f of readdirSync(web).filter((n) => n.endsWith(".js"))) execFileSync(process.execPath, ["--check", join(web, f)], { stdio: "pipe" });
});
