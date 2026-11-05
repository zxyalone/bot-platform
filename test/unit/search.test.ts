import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../helpers.ts";
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
  reply(text = "好") {
    this.emit({ type: "text_done", key: `k${Math.random()}`, text });
    this.emit({ type: "turn_end", status: "completed" });
  }
  fail(error: string) {
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

async function setup(cwd = mkdtempSync(join(tmpdir(), "bot-proj-"))) {
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  });
  const mk = async (name: string, dir = cwd) => (await t.api("POST", "/api/bots", { name, role: `ROLE-${name}`, agent: "codex", model: "gpt-6-luna", cwd: dir })).body;
  const bots: Record<string, any> = { A: await mk("A"), B: await mk("B") };
  const rt = (n: string, i = 0) => made.filter((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`))[i];
  const waitRt = async (n: string, sends = 1, i = 0) => {
    await t.waitFor(() => (rt(n, i)?.sent.length ?? 0) >= sends, `${n} gets ${sends}`);
    return rt(n, i);
  };
  const chat = async (n: string, text: string, reply: string, conversationId?: string, sends = 1) => {
    const id = (await t.api("POST", `/api/bots/${bots[n].id}/messages`, { text, conversationId })).body.id as string;
    (await waitRt(n, sends)).reply(reply);
    await t.waitFor(async () => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation.status === "idle", "idle");
    return id;
  };
  const find = async (q: string, extra: Record<string, string> = {}) => (await t.api("GET", `/api/search?${new URLSearchParams({ q, ...extra })}`)).body;
  const bus = (f: Fake, tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end");
    await new Promise((r) => setTimeout(r, 30));
    t.close();
  };
  return { t, cwd, made, bots, mk, rt, waitRt, chat, find, bus, end };
}

test("finds what was said, in Chinese or English, and says where it is so it can be opened", async () => {
  const s = await setup();
  const id = await s.chat("A", "边界损失怎么实现", "用 Dice 加 boundary 距离");
  const you = await s.find("边界损失");
  assert.equal(you.results.length, 1);
  const r = you.results[0];
  assert.deepEqual([r.kind, r.type, r.conv_id, r.bot_id, r.who], ["message", "user", id, s.bots.A.id, "你"]);
  assert.ok((await s.t.api("GET", `/api/conversations/${id}/items`)).body.items.some((i: any) => i.id === r.id), "the id leads to the message");
  assert.equal((await s.find("BOUNDARY")).results[0].type, "assistant", "case does not matter");
  await s.end();
});

test("every word must appear, and only what a person reads is searched", async () => {
  const s = await setup();
  await s.chat("A", "苹果 和 香蕉", "好");
  await s.chat("B", "只有苹果", "好");
  assert.equal((await s.find("苹果")).results.length, 2);
  assert.equal((await s.find("苹果 香蕉")).results.length, 1);
  assert.equal((await s.find("text")).results.length, 0, "not the JSON around it");
  assert.equal((await s.find("   ")).results.length, 0);
  await s.end();
});

test("special characters are plain text", async () => {
  const s = await setup();
  await s.chat("A", "完成度 100% 了", "好");
  await s.chat("B", "完成度 1000 了", "好");
  assert.equal((await s.find("100%")).results.length, 1);
  assert.equal((await s.find("%")).results.length, 1);
  assert.equal((await s.find("_")).results.length, 0);
  assert.equal((await s.find("' OR 1=1 --")).results.length, 0);
  await s.end();
});

test("a long message is shown around the match, not from the start", async () => {
  const s = await setup();
  await s.chat("A", `${"前".repeat(500)}关键词${"后".repeat(500)}`, "好");
  const { snippet } = (await s.find("关键词")).results[0];
  assert.match(snippet, /^…前+关键词后+…$/);
  assert.ok(snippet.length < 200);
  await s.end();
});

test("tasks and their answers can be found and filtered by the Bot doing them and by status", async () => {
  const s = await setup();
  const conv = (await s.t.api("POST", `/api/bots/${s.bots.A.id}/messages`, { text: "go" })).body.id;
  const a = await s.waitRt("A");
  await s.bus(a, "assign_task", { bot: "B", task: "检查数据泄漏" });
  (await s.waitRt("B")).reply("发现三处泄漏");
  await s.t.waitFor(async () => (await s.find("三处泄漏")).results.some((r: any) => r.kind === "task" && r.status === "done"), "task done");
  const [task] = (await s.find("检查数据泄漏", { kind: "task" })).results;
  assert.deepEqual([task.who, task.conv_id], ["A → B", conv]);
  assert.equal((await s.find("检查数据泄漏", { bot: s.bots.B.id })).results.length, 1, "the Bot it was given to");
  assert.equal((await s.find("检查数据泄漏", { status: "failed" })).results.length, 0);
  a.reply("完");
  await s.end();
});

test("a filter on status leaves out chat, and failed includes errors", async () => {
  const s = await setup();
  const id = (await s.t.api("POST", `/api/bots/${s.bots.A.id}/messages`, { text: "连接失败怎么办" })).body.id;
  const a = await s.waitRt("A");
  a.fail("连接失败：超时");
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${id}/items`)).body.conversation.status === "idle", "idle");
  assert.equal((await s.find("连接失败")).results.length, 2);
  const failed = (await s.find("连接失败", { status: "failed" })).results;
  assert.deepEqual(failed.map((r: any) => r.type), ["error"]);
  assert.equal((await s.find("连接失败", { status: "done" })).results.length, 0);
  await s.end();
});

test("project and time filters narrow it down", async () => {
  const s = await setup();
  const other = mkdtempSync(join(tmpdir(), "bot-other-"));
  s.bots.Z = await s.mk("Z", other);
  await s.chat("A", "共同的词", "好");
  await s.chat("Z", "共同的词", "好");
  assert.equal((await s.find("共同的词")).results.length, 2);
  const here = (await s.find("共同的词", { cwd: s.cwd })).results;
  assert.deepEqual(here.map((r: any) => r.bot_id), [s.bots.A.id]);
  assert.equal((await s.find("共同的词", { since: String(Date.now() + 60000) })).results.length, 0);
  assert.equal((await s.find("共同的词", { until: String(Date.now() - 600000) })).results.length, 0);
  await s.end();
});

test("changed files are found by path, and only with the kind asked for", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bot-repo-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd });
  git("init", "-q");
  writeFileSync(join(cwd, "a.txt"), "1\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  const s = await setup(cwd);
  const id = (await s.t.api("POST", `/api/bots/${s.bots.A.id}/messages`, { text: "go" })).body.id;
  const a = await s.waitRt("A");
  writeFileSync(join(cwd, "boundary_loss.py"), "x\n");
  a.reply("写好了");
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${id}/items`)).body.items.some((i: any) => i.type === "result"), "card");
  const hit = (await s.find("boundary_loss")).results;
  assert.deepEqual(hit.map((r: any) => r.kind), ["file"]);
  assert.equal((await s.find("boundary_loss", { kind: "message" })).results.length, 0);
  assert.equal((await s.find("path")).results.length, 0, "not the field names");
  await s.end();
});

test("experiments and ideas are found, and test-set results are not", async () => {
  const s = await setup();
  const pid = Memory.projectId(s.cwd);
  await s.t.api("PUT", `/api/projects/${pid}/settings`, { enabled: true, auto_wake: false });
  const id = (await s.t.api("POST", `/api/bots/${s.bots.A.id}/messages`, { text: "go" })).body.id;
  const a = await s.waitRt("A");
  await s.bus(a, "add_idea", { title: "边界感知损失", hypothesis: "细小结构提升" });
  const p = s.bus(a, "run_experiment", { name: "基线实验", command: "true", config: { lr: 0.01 } });
  const card: any = await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${id}/items`)).body.items.find((i: any) => i.data.kind === "job_request" && i.status === "pending"), "card");
  await s.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" });
  await p;
  s.t.store.db.prepare("UPDATE experiments SET test_metrics=? ").run(JSON.stringify({ secret_score: 0.9 }));
  assert.deepEqual((await s.find("细小结构")).results.map((r: any) => [r.type, r.project_id, r.who]), [["idea", pid, "A"]]);
  const [e] = (await s.find("基线实验", { kind: "experiment" })).results;
  assert.deepEqual([e.type, e.project_id], ["experiment", pid]);
  assert.equal((await s.find("secret_score")).results.length, 0);
  assert.equal((await s.find("基线实验", { cwd: "/elsewhere" })).results.length, 0);
  a.reply("完");
  await s.end();
});

test("archived conversations stay out, results are capped and say so, and the query is bounded", async () => {
  const s = await setup();
  const id = await s.chat("A", "将被归档的话", "好");
  assert.equal((await s.find("将被归档")).results.length, 1);
  await s.t.api("DELETE", `/api/conversations/${id}`);
  assert.equal((await s.find("将被归档")).results.length, 0);

  const conv = await s.chat("B", "第一条", "好");
  for (let i = 0; i < 55; i++) s.t.store.addItem({ convId: conv, turnId: null, type: "user", status: "done", data: { text: `批量 ${i}` } });
  const many = await s.find("批量");
  assert.equal(many.results.length, 50);
  assert.equal(many.more, true);
  assert.match(many.results[0].snippet, /批量 54/, "newest first");
  assert.equal((await s.t.api("GET", `/api/search?q=${"x".repeat(201)}`)).status, 400);
  await s.end();
});

test("the web bundle's search module is served", async () => {
  const s = await setup();
  const r = await fetch(`${s.t.base}/search.js`);
  assert.match(await r.text(), /mountSearch/);
  s.t.close();
});
