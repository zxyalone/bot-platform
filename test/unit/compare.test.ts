import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../helpers.ts";
import { parseSynthesis } from "../../src/daemon/engine.ts";
import { Memory } from "../../src/daemon/git.ts";
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
  fail(error = "坏了") {
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

async function setup(names = ["A", "B", "C"]) {
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  });
  const cwd = mkdtempSync(join(tmpdir(), "bot-proj-"));
  const bots: Record<string, any> = {};
  for (const n of names) bots[n] = (await t.api("POST", "/api/bots", { name: n, role: `ROLE-${n}`, agent: "codex", model: "gpt-6-luna", cwd, permission: "auto_edit" })).body;
  const g = (await t.api("POST", "/api/groups", { name: "g", members: names.map((n) => bots[n].id), cwd })).body;
  const compare = (text: string, body: object = {}) => t.api("POST", `/api/groups/${g.id}/compare`, { text, ...body });
  const answering = (n: string) => made.filter((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`));
  const waitFor = (n: string, re: RegExp) => t.waitFor(() => answering(n).find((f) => f.sent.some((x) => re.test(x))), `${n} gets ${re}`) as Promise<Fake>;
  const data = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body;
  const card = async (id: string) => (await data(id)).items.find((i: any) => i.type === "comparison");
  const idle = (id: string) => t.waitFor(async () => (await data(id)).conversation.status === "idle", "idle");
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end");
    await new Promise((r) => setTimeout(r, 30));
    t.close();
  };
  return { t, made, cwd, bots, g, compare, answering, waitFor, data, card, idle, end };
}
const SYNTH = /^下面是 \d+ 个 Bot/;
const ASK = /^这是一次独立比较/;

test("each Bot answers in a new session, at the same time, seeing only the question", async () => {
  const s = await setup(["A", "B"]);
  const first = (await s.t.api("POST", `/api/groups/${s.g.id}/messages`, { text: "@A 之前的群聊秘密" })).body.id;
  const old = await s.waitFor("A", /之前的群聊秘密/);
  old.reply("之前的回复秘密");
  await s.idle(first);

  assert.equal((await s.compare("用哪个损失函数", { conversationId: first })).status, 202);
  const a = await s.waitFor("A", ASK);
  const b = await s.waitFor("B", ASK);
  assert.notEqual(a, old, "a new session, not the one with the chat in it");
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1, "both started without waiting for the other");
  for (const f of [a, b]) {
    assert.match(f.sent[0], /用哪个损失函数/);
    assert.doesNotMatch(f.sent[0], /秘密/);
    assert.equal(f.opts.permission, "read_only");
  }
  a.reply("A 说用 Dice");
  await s.t.waitFor(async () => (await s.card(first)).data.answers.find((x: any) => x.bot === "A").status === "done", "A's answer shows");
  assert.doesNotMatch(b.sent.join(""), /A 说用 Dice/, "B never hears it");
  b.reply("B 说用 BCE");
  const sum = await s.waitFor("A", SYNTH);
  sum.reply(JSON.stringify({ consensus: ["都要做"], disagreements: [], gaps: [] }));
  await s.idle(first);
  await s.end();
});

test("a participant cannot ask another for its answer", async () => {
  const s = await setup(["A", "B"]);
  const id = (await s.compare("问题")).body.id;
  const a = await s.waitFor("A", ASK);
  const r = await fetch(`${s.t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${a.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool: "ask_bot", args: { bot: "B", question: "你怎么答的" } }) }).then((x) => x.json()) as any;
  assert.match(r.text, /调用链/);
  a.reply();
  (await s.waitFor("B", ASK)).reply();
  (await s.waitFor("A", SYNTH)).reply("{}");
  await s.idle(id);
  await s.end();
});

test("the summary reads every answer, and is shown as structured findings", async () => {
  const s = await setup(["A", "B", "C"]);
  const id = (await s.compare("问题", { bots: [s.bots.A.id, s.bots.B.id], synthesizer: s.bots.C.id })).body.id;
  (await s.waitFor("A", ASK)).reply("A 的看法", 100);
  (await s.waitFor("B", ASK)).reply("B 的看法", 200);
  const c = await s.waitFor("C", SYNTH);
  assert.match(c.sent[0], /A 的看法/);
  assert.match(c.sent[0], /B 的看法/);
  assert.equal(c.opts.permission, "read_only");
  assert.equal(s.answering("C").filter((f) => f.sent.some((x) => ASK.test(x))).length, 0, "C did not take part");
  c.reply(`好的\n${JSON.stringify({ consensus: ["要测"], disagreements: [{ topic: "学习率", positions: [{ bot: "A", view: "0.1", evidence: "论文" }, { bot: "B", view: "0.01" }, { bot: "捏造的", view: "x" }] }], gaps: ["没提数据"] })}`, 50);
  await s.idle(id);
  const k = await s.card(id);
  assert.equal(k.status, "done");
  assert.deepEqual(k.data.answers.map((x: any) => [x.bot, x.status, x.text, x.tokens]), [["A", "done", "A 的看法", 100], ["B", "done", "B 的看法", 200]]);
  assert.deepEqual(k.data.synthesis.consensus, ["要测"]);
  assert.deepEqual(k.data.synthesis.disagreements[0].positions.map((p: any) => p.bot), ["A", "B"], "a Bot that did not answer is dropped");
  assert.equal(k.data.synthesis.disagreements[0].positions[1].evidence, "");
  assert.equal(k.data.summarizer, "C");
  await s.end();
});

test("a summary that is not valid JSON is shown as it came", () => {
  assert.deepEqual(parseSynthesis("不是 JSON", ["A"]), { raw: "不是 JSON" });
  assert.deepEqual(parseSynthesis('{"consensus":"不是列表","disagreements":[{"topic":"","positions":[]}],"gaps":[1,"有"]}', ["A"]), { consensus: [], disagreements: [], gaps: ["有"] });
});

test("one failed answer does not stop the rest; fewer than two means no summary", async () => {
  const s = await setup(["A", "B", "C"]);
  const id = (await s.compare("问题")).body.id;
  (await s.waitFor("A", ASK)).fail("A 坏了");
  (await s.waitFor("B", ASK)).reply("B 的");
  (await s.waitFor("C", ASK)).reply("C 的");
  const sum = await s.waitFor("A", SYNTH).catch(() => null) ?? await s.waitFor("B", SYNTH);
  assert.doesNotMatch(sum.sent.at(-1)!, /A 坏了/);
  sum.reply("{}");
  await s.idle(id);
  const k = await s.card(id);
  assert.equal(k.status, "done");
  const failed = k.data.answers.find((x: any) => x.bot === "A");
  assert.equal(failed.status, "failed");
  assert.match(failed.reason, /A 坏了/);

  const two = await setup(["A", "B"]);
  const conv = (await two.compare("问题")).body.id;
  (await two.waitFor("A", ASK)).fail();
  (await two.waitFor("B", ASK)).reply("只有我");
  await two.idle(conv);
  const k2 = await two.card(conv);
  assert.equal(k2.status, "partial");
  assert.equal(k2.data.synthesis, null);
  assert.match(k2.data.note, /不到 2 个/);
  assert.equal(two.made.filter((f) => f.sent.some((x) => SYNTH.test(x))).length, 0, "no tokens spent on a comparison of one");
  await s.end();
  await two.end();
});

test("a failed summary keeps the answers", async () => {
  const s = await setup(["A", "B"]);
  const id = (await s.compare("问题")).body.id;
  (await s.waitFor("A", ASK)).reply("A 的");
  (await s.waitFor("B", ASK)).reply("B 的");
  (await s.waitFor("A", SYNTH)).fail("归纳坏了");
  await s.idle(id);
  const k = await s.card(id);
  assert.equal(k.status, "partial");
  assert.match(k.data.note, /归纳失败：归纳坏了/);
  assert.equal(k.data.answers.filter((x: any) => x.status === "done").length, 2);
  await s.end();
});

test("stopping ends every answer and skips the summary", async () => {
  const s = await setup(["A", "B"]);
  const id = (await s.compare("问题")).body.id;
  await s.waitFor("A", ASK);
  await s.waitFor("B", ASK);
  await s.t.api("POST", `/api/conversations/${id}/interrupt`, {});
  await s.idle(id);
  const k = await s.card(id);
  assert.equal(k.status, "interrupted");
  assert.deepEqual(k.data.answers.map((x: any) => x.status), ["interrupted", "interrupted"]);
  assert.equal(s.made.filter((f) => f.sent.some((x) => SYNTH.test(x))).length, 0);
  await s.end();
});

test("the whole comparison counts against the round's budget and the project's", async () => {
  const s = await setup(["A", "B"]);
  await s.t.api("PATCH", `/api/groups/${s.g.id}`, { budget_tokens: 1000 });
  const id = (await s.compare("问题")).body.id;
  const a = await s.waitFor("A", ASK);
  a.emit({ type: "usage_tick", tokens: 1200 });
  await s.idle(id);
  assert.equal((await s.card(id)).status, "interrupted");

  await s.t.api("PUT", `/api/projects/${Memory.projectId(s.cwd)}/settings`, { budget_total: 100 });
  const refused = await s.compare("再来", { conversationId: id });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /预算用完了/);
  await s.end();
});

test("only what it can run at once starts; the rest wait their turn", async () => {
  const s = await setup(["A", "B", "C"]);
  await s.t.api("PUT", "/api/settings", { max_active: 2 });
  const id = (await s.compare("问题")).body.id;
  await s.waitFor("A", ASK);
  const b = await s.waitFor("B", ASK);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(s.answering("C").length, 0);
  const k = await s.card(id);
  assert.deepEqual(k.data.answers.map((x: any) => x.status), ["running", "running", "waiting"]);
  b.reply("B 的");
  (await s.waitFor("C", ASK)).reply("C 的");
  s.answering("A")[0].reply("A 的");
  (await s.waitFor("A", SYNTH)).reply("{}");
  await s.idle(id);
  await s.end();
});

test("it is checked before anything starts", async () => {
  const s = await setup(["A", "B", "C"]);
  assert.equal((await s.compare("问题", { bots: [s.bots.A.id] })).status, 400);
  assert.equal((await s.compare("问题", { bots: ["nope", s.bots.A.id] })).status, 400);
  assert.equal((await s.compare("问题", { synthesizer: "nope" })).status, 400);
  assert.equal((await s.compare("")).status, 400);
  await s.t.api("PATCH", `/api/bots/${s.bots.A.id}`, { paused: 1 });
  assert.equal(s.made.length, 0);
  const id = (await s.compare("问题", { bots: [s.bots.B.id, s.bots.C.id] })).body.id;
  assert.equal((await s.compare("又一个", { conversationId: id })).status, 409);
  (await s.waitFor("B", ASK)).reply();
  (await s.waitFor("C", ASK)).reply();
  (await s.waitFor("B", SYNTH)).reply("{}");
  await s.end();
});

test("attachments reach every participant, and nothing changed means no result card", async () => {
  const s = await setup(["A", "B"]);
  const up = await fetch(`${s.t.base}/api/uploads?name=data.txt`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "x" }).then((r) => r.json()) as any;
  const id = (await s.compare("看附件", { attachments: [up.id] })).body.id;
  const a = await s.waitFor("A", ASK);
  const b = await s.waitFor("B", ASK);
  assert.match(a.sent[0], /data\.txt/);
  assert.match(b.sent[0], /data\.txt/);
  a.reply();
  b.reply();
  (await s.waitFor("A", SYNTH)).reply("{}");
  await s.idle(id);
  assert.equal((await s.data(id)).items.filter((i: any) => i.type === "result").length, 0);
  await s.end();
});

test("a later message can read what was compared, search finds it, and the task center stays out of it", async () => {
  const s = await setup(["A", "B"]);
  const id = (await s.compare("选哪个优化器")).body.id;
  (await s.waitFor("A", ASK)).reply("A 选 Adam");
  (await s.waitFor("B", ASK)).reply("B 选 SGD");
  (await s.waitFor("A", SYNTH)).reply("{}");
  await s.idle(id);
  assert.equal((await s.t.api("GET", "/api/tasks")).body.tasks.length, 0);
  const hits = (await s.t.api("GET", `/api/search?q=${encodeURIComponent("SGD")}`)).body.results;
  assert.deepEqual(hits.map((r: any) => r.type), ["comparison"]);
  assert.equal(hits[0].conv_id, id);

  await s.t.api("POST", `/api/groups/${s.g.id}/messages`, { text: "@B 为什么选 SGD", conversationId: id });
  const b = await s.t.waitFor(() => s.answering("B").find((f) => f.sent.some((x) => /为什么选 SGD/.test(x))), "follow-up") as Fake;
  assert.match(b.sent.at(-1)!, /A 选 Adam/, "B can now see the other answer");
  assert.match(b.sent.at(-1)!, /选哪个优化器/);
  b.reply();
  await s.end();
});
