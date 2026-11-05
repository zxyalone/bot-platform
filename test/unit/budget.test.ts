import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
  spend(tokens: number) {
    this.emit({ type: "usage_tick", tokens });
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

async function setup() {
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  });
  const cwd = mkdtempSync(join(tmpdir(), "bot-proj-"));
  const mk = async (name: string, dir = cwd) => (await t.api("POST", "/api/bots", { name, role: `ROLE-${name}`, agent: "codex", model: "gpt-6-luna", cwd: dir, budget_tokens: 10_000_000 })).body;
  const bots: Record<string, any> = { A: await mk("A"), B: await mk("B"), C: await mk("C") };
  const pid = Memory.projectId(cwd);
  const limits = (body: object, id = pid) => t.api("PUT", `/api/projects/${id}/settings`, body);
  const say = (n: string, text = "go", conversationId?: string) => t.api("POST", `/api/bots/${bots[n].id}/messages`, { text, conversationId });
  const rt = (n: string, i = 0) => made.filter((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`))[i];
  const waitRt = async (n: string, sends = 1, i = 0) => {
    await t.waitFor(() => (rt(n, i)?.sent.length ?? 0) >= sends, `${n} gets ${sends}`);
    return rt(n, i);
  };
  const data = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body;
  const idle = (id: string) => t.waitFor(async () => (await data(id)).conversation.status === "idle", "idle");
  const report = async (dir = cwd) => (await t.api("GET", `/api/projects/${Memory.projectId(dir)}/budget?cwd=${encodeURIComponent(dir)}`)).body;
  const bus = (f: Fake, tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  const task = async (id: string) => (await t.api("GET", "/api/tasks")).body.tasks.find((x: any) => x.id === id);
  const notes = (kind?: string) => t.events.filter((e: any) => e.type === "notify" && (!kind || e.kind === kind));
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end");
    await new Promise((r) => setTimeout(r, 30));
    t.close();
  };
  return { t, made, bots, cwd, pid, mk, limits, say, rt, waitRt, data, idle, report, bus, task, notes, end };
}
const run = async (s: Awaited<ReturnType<typeof setup>>, tokens: number, n = "A", conv?: string, sends = 1) => {
  const id = (await s.say(n, "go", conv)).body.id as string;
  const f = await s.waitRt(n, sends);
  f.reply("好", tokens);
  await s.idle(id);
  return { id, f };
};

test("a project's total budget stops a round that crosses it, refuses the next, and can be raised", async () => {
  const s = await setup();
  await s.limits({ budget_total: 1000 });
  const { id, f } = await run(s, 600);
  assert.equal((await s.report()).total.spent, 600);
  assert.equal((await s.say("A", "再来", id)).status, 202);
  await s.waitRt("A", 2);
  f.spend(500);
  const d = await s.t.waitFor(async () => {
    const x = await s.data(id);
    return x.conversation.status === "idle" && x;
  }, "stopped") as any;
  assert.match(d.items.filter((i: any) => i.type === "error").at(-1).data.message, /总预算用完了.*已自动停止/);
  const refused = await s.say("A", "还要", id);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /总预算用完了（1100 \/ 1000/);
  assert.equal((await s.say("B")).status, 409, "the whole project, not one Bot");
  await s.limits({ budget_total: 5000 });
  assert.equal((await s.say("A", "继续", id)).status, 202);
  await s.waitRt("A", 3);
  f.reply();
  await s.end();
});

test("the daily budget only counts today, and another project is untouched", async () => {
  const s = await setup();
  await s.limits({ budget_daily: 1000 });
  const { id } = await run(s, 1500);
  assert.equal((await s.say("A", "再来", id)).status, 409);
  assert.match((await s.say("A", "再来", id)).body.error, /今天的预算用完了/);

  const other = mkdtempSync(join(tmpdir(), "bot-other-"));
  s.bots.Z = await s.mk("Z", other);
  assert.equal((await s.say("Z")).status, 202, "a different directory is a different project");
  (await s.waitRt("Z")).reply();

  s.t.store.db.prepare("UPDATE root_turns SET created_at=created_at-172800000").run();
  const after = await s.report();
  assert.deepEqual([after.today.spent, after.total.spent], [0, 1500]);
  assert.equal((await s.say("A", "新的一天", id)).status, 202);
  (await s.waitRt("A", 2)).reply();
  await s.end();
});

test("spending is saved as it happens, so a crash cannot hide it", async () => {
  const s = await setup();
  const id = (await s.say("A")).body.id as string;
  const f = await s.waitRt("A");
  f.spend(700);
  assert.equal((await s.report()).total.spent, 700);
  f.reply();
  await s.idle(id);
  await s.end();
});

test("near the limit it warns once, and the agent is not told", async () => {
  const s = await setup();
  await s.limits({ budget_total: 1000 });
  const { id } = await run(s, 850);
  const warned = async () => (await s.data(id)).items.filter((i: any) => i.type === "notice");
  assert.match((await warned())[0].data.text, /总预算已用 85%/);
  assert.equal(s.notes("budget").length, 1);
  await run(s, 10, "A", id, 2);
  assert.equal((await warned()).length, 1, "once");
  assert.doesNotMatch(s.rt("A").sent[1], /预算/);
  await s.end();
});

test("queued messages are kept, with the reason, when the budget runs out", async () => {
  const s = await setup();
  await s.limits({ budget_total: 1000 });
  const id = (await s.say("A")).body.id as string;
  const f = await s.waitRt("A");
  await s.t.api("POST", `/api/conversations/${id}/followup`, { text: "下一步" });
  f.spend(1200);
  const row: any = await s.t.waitFor(async () => (await s.data(id)).items.find((i: any) => i.type === "queued" && i.status === "unsent"), "unsent");
  assert.match(row.data.reason, /项目的预算用完了/);
  assert.equal(f.sent.length, 1);
  await s.end();
});

test("a retry and an experiment's wake-up respect a spent budget", async () => {
  const s = await setup();
  const id = (await s.say("A")).body.id as string;
  const a = await s.waitRt("A");
  const { task_id } = JSON.parse((await s.bus(a, "assign_task", { bot: "B", task: "一" })).text);
  const b = await s.waitRt("B");
  b.fail();
  await s.t.waitFor(async () => (await s.task(task_id)).status === "failed", "failed");
  a.reply("完", 2000);
  await s.idle(id);
  await s.limits({ budget_total: 1000 });
  const r = await s.t.api("POST", `/api/tasks/${task_id}/retry`, {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /预算用完了/);
  await s.end();
});

test("budgets are validated", async () => {
  const s = await setup();
  for (const bad of [-1, 1.5, "x", 2_000_000_000]) assert.equal((await s.limits({ budget_total: bad })).status, 400, String(bad));
  assert.equal((await s.limits({ budget_daily: -1 })).status, 400);
  assert.equal((await s.t.api("GET", `/api/projects/${s.pid}/budget?cwd=${encodeURIComponent("/elsewhere")}`)).status, 400);
  assert.equal((await s.t.api("PUT", "/api/settings", { max_global_active: 0 })).status, 400);
  s.t.close();
});

test("the report shows where the tokens went", async () => {
  const s = await setup();
  const id = (await s.say("A", "主要的活")).body.id as string;
  const a = await s.waitRt("A");
  const { task_id } = JSON.parse((await s.bus(a, "assign_task", { bot: "B", task: "很贵的任务" })).text);
  (await s.waitRt("B")).reply("完", 3000);
  await s.t.waitFor(async () => (await s.task(task_id)).status === "done", "done");
  a.reply("好", 100);
  await s.idle(id);
  const r = await s.report();
  assert.equal(r.total.spent, 3100);
  assert.deepEqual(r.by_conversation.map((c: any) => [c.title, c.tokens]), [["主要的活", 3100]]);
  assert.deepEqual(r.by_call.map((c: any) => [c.owner, c.title, c.tokens]), [["B", "很贵的任务", 3000]]);
  await s.end();
});

// ---------- global concurrency ----------
test("the global limit refuses a new round, and a queued message waits for a slot instead of being lost", async () => {
  const s = await setup();
  await s.t.api("PUT", "/api/settings", { max_global_active: 2 });
  const a = (await s.say("A")).body.id as string;
  const fa = await s.waitRt("A");
  const b = (await s.say("B")).body.id as string;
  const fb = await s.waitRt("B");
  const c = await s.say("C");
  assert.equal(c.status, 409);
  assert.match(c.body.error, /全局上限 2/);
  await s.t.api("POST", `/api/conversations/${a}/followup`, { text: "A 的下一条" });
  fa.reply();
  await s.t.waitFor(async () => (await s.data(a)).items.some((i: any) => i.type === "queued" && i.status === "sent"), "goes straight into the freed slot");
  await s.waitRt("A", 2);
  await s.t.api("POST", `/api/conversations/${b}/followup`, { text: "B 的下一条" });
  // Someone else takes the slot B frees, so B's message has to wait its turn.
  fa.reply();
  fb.reply();
  await s.t.waitFor(() => fb.sent.length === 2, "B's next message");
  fb.reply();
  await s.end();
});

test("tasks wait for a slot with the reason, and start when one frees up", async () => {
  const s = await setup();
  await s.t.api("PUT", "/api/settings", { max_global_active: 1 });
  await s.say("A");
  const a = await s.waitRt("A");
  const one = JSON.parse((await s.bus(a, "assign_task", { bot: "B", task: "一" })).text);
  assert.equal(one.status, "running", "a round waiting on its task does not block that task");
  const two = JSON.parse((await s.bus(a, "assign_task", { bot: "C", task: "二" })).text);
  assert.equal(two.status, "waiting");
  assert.match((await s.task(two.task_id)).waiting_reason, /全局并发/);
  const asked = await s.bus(a, "ask_bot", { bot: "C", question: "三" });
  assert.match(asked.text, /全局上限/);
  (await s.waitRt("B")).reply();
  (await s.waitRt("C")).reply();
  await s.t.waitFor(async () => (await s.task(two.task_id)).status === "done", "second task");
  a.reply();
  await s.end();
});

// ---------- notifications ----------
test("a person is told about approvals, finished rounds and failures, with where to go", async () => {
  const s = await setup();
  const id = (await s.say("A")).body.id as string;
  const f = await s.waitRt("A");
  f.emit({ type: "approval", requestId: "r", title: "写入 a.py", detail: "", canRemember: false });
  const ask: any = await s.t.waitFor(() => s.notes("approval")[0], "approval");
  assert.equal(ask.body, "写入 a.py");
  assert.deepEqual([ask.conv_id, ask.bot_id, ask.group_id], [id, s.bots.A.id, null]);
  assert.ok(ask.item_id);
  f.reply("改好了\n第二行");
  const done: any = await s.t.waitFor(() => s.notes("done")[0], "done");
  assert.equal(done.body, "改好了");
  await s.idle(id);
  await s.say("A", "再来", id);
  await s.waitRt("A", 2);
  f.fail();
  await s.t.waitFor(() => s.notes("failed")[0], "failed");
  await s.end();
});

test("a failed task is reported, and a stop you pressed yourself is not", async () => {
  const s = await setup();
  const id = (await s.say("A")).body.id as string;
  const a = await s.waitRt("A");
  const { task_id } = JSON.parse((await s.bus(a, "assign_task", { bot: "B", task: "要失败的" })).text);
  (await s.waitRt("B")).fail();
  const n: any = await s.t.waitFor(() => s.notes("failed")[0], "task failed");
  assert.match(n.body, /B 的任务失败了：要失败的/);
  void task_id;
  await s.t.api("POST", `/api/conversations/${id}/interrupt`, {});
  await s.idle(id);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.notes("done").length, 0);
  assert.equal(s.notes("failed").length, 1);
  await s.end();
});

test("a muted project and the global switch stay quiet, while spending limits still apply", async () => {
  const s = await setup();
  await s.limits({ muted: true, budget_total: 1000 });
  const { id } = await run(s, 900);
  assert.equal(s.notes().length, 0);
  await s.limits({ muted: false });
  await s.t.api("PUT", "/api/settings", { notify_enabled: false });
  await run(s, 10, "A", id, 2);
  assert.equal(s.notes().length, 0);
  await s.end();
});

test("an experiment that ends after the budget ran out wakes nobody, and the next message still hears about it", async () => {
  const s = await setup();
  await s.limits({ enabled: true });
  const id = (await s.say("A")).body.id as string;
  const f = await s.waitRt("A");
  const p = s.bus(f, "run_experiment", { name: "长实验", command: "sleep 0.3" });
  const card: any = await s.t.waitFor(async () => (await s.data(id)).items.find((i: any) => i.data.kind === "job_request" && i.status === "pending"), "card");
  await s.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" });
  await p;
  f.reply("提交了", 100);
  await s.idle(id);
  await s.limits({ budget_total: 50 });
  const note: any = await s.t.waitFor(async () => (await s.data(id)).items.find((i: any) => i.type === "notice" && /长实验/.test(i.data.text)), "notice", 5000);
  assert.match(note.data.text, /没有唤醒/);
  assert.equal(f.sent.length, 1, "nobody was woken");
  assert.equal((await s.notes("done")).filter((n: any) => /长实验/.test(n.body)).length, 1, "the person is still told");
  await s.limits({ budget_total: 0 });
  await s.say("A", "结果呢", id);
  await s.waitRt("A", 2);
  assert.match(f.sent[1], /长实验/);
  f.reply();
  await s.end();
});

test("an experiment that ends when no slot is free wakes the conversation once one is", async () => {
  const s = await setup();
  await s.limits({ enabled: true });
  await s.t.api("PUT", "/api/settings", { max_global_active: 1 });
  const id = (await s.say("A")).body.id as string;
  const f = await s.waitRt("A");
  const p = s.bus(f, "run_experiment", { name: "等空位", command: "sleep 0.4" });
  const card: any = await s.t.waitFor(async () => (await s.data(id)).items.find((i: any) => i.data.kind === "job_request" && i.status === "pending"), "card");
  await s.t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" });
  await p;
  f.reply();
  await s.idle(id);
  assert.equal((await s.say("B")).status, 202, "someone else takes the only slot");
  const b = await s.waitRt("B");
  await s.t.waitFor(async () => s.notes("done").some((n: any) => /等空位/.test(n.body)), "experiment ended", 5000);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(f.sent.length, 1, "no slot yet");
  b.reply();
  await s.t.waitFor(() => f.sent.length === 2, "woken when the slot frees");
  assert.match(f.sent[1], /等空位/);
  f.reply();
  await s.end();
});

test("a stopped turn that reports zero usage keeps what was already spent; a real final figure still settles it", async () => {
  const s = await setup();
  const id = (await s.say("A")).body.id as string;
  const f = await s.waitRt("A");
  f.spend(500);
  f.emit({ type: "usage", inputTokens: 0, cachedTokens: 0, outputTokens: 0, costTotalUsd: 0 });
  f.emit({ type: "turn_end", status: "interrupted" });
  await s.idle(id);
  assert.equal((await s.report()).total.spent, 500);

  await s.say("A", "再来", id);
  await s.waitRt("A", 2);
  f.spend(500);
  f.emit({ type: "usage", inputTokens: 100, cachedTokens: 0, outputTokens: 0 });
  f.emit({ type: "turn_end", status: "completed" });
  await s.idle(id);
  assert.equal((await s.report()).total.spent, 600, "the estimate settles to the exact figure");
  await s.end();
});
