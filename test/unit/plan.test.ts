import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { ensureSeedBots, Store } from "../../src/daemon/store.ts";
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
  fail() {
    this.emit({ type: "turn_end", status: "failed", error: "坏了" });
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
  const home = tempHome();
  const seed = new Store(home);
  ensureSeedBots(seed);
  seed.close();
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  }, { home });
  const cwd = mkdtempSync(join(tmpdir(), "bot-proj-"));
  const state = (await t.api("GET", "/api/state")).body;
  const chief = state.bots.find((b: any) => b.is_chief);
  for (const n of ["Writer", "Checker", "Third"]) await t.api("POST", "/api/bots", { name: n, role: `ROLE-${n}`, agent: "codex", model: "gpt-6-luna", cwd });
  const rt = (n: string) => made.find((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`));
  const waitRt = async (n: string, sends = 1) => {
    await t.waitFor(() => (rt(n)?.sent.length ?? 0) >= sends, `${n} gets ${sends}`);
    return rt(n)!;
  };
  const conv = (await t.api("POST", `/api/bots/${chief.id}/messages`, { text: "做个大事" })).body.id as string;
  await t.waitFor(() => made[0]?.sent.length, "chief");
  const boss = made[0];
  const bus = (f: Fake, tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  const items = async () => (await t.api("GET", `/api/conversations/${conv}/items`)).body.items as any[];
  const card = () => t.waitFor(async () => (await items()).find((i) => i.data.kind === "plan" && i.status === "pending"), "plan card") as Promise<any>;
  const decide = (id: string, decision: string, spec?: object) => t.api("POST", `/api/approvals/${id}`, { decision, spec });
  const task = async (id: string) => (await t.api("GET", "/api/tasks")).body.tasks.find((x: any) => x.id === id);
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end");
    await new Promise((r) => setTimeout(r, 30));
    t.close();
  };
  return { t, made, chief, conv, boss, rt, waitRt, bus, items, card, decide, task, end, cwd };
}
const PLAN = { title: "做大事", tasks: [{ id: "a", bot: "Writer", task: "写代码", acceptance: "有测试" }, { id: "b", bot: "Checker", task: "审查", depends_on: ["a"] }] };

test("nothing starts until the person decides, and the plan shows up where they will see it", async () => {
  const s = await setup();
  const p = s.bus(s.boss, "propose_plan", PLAN);
  const c = await s.card();
  assert.equal(c.data.title, "执行计划：做大事");
  assert.deepEqual(c.data.tasks.map((t: any) => t.bot), ["Writer", "Checker"]);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.rt("Writer"), undefined);
  assert.equal((await s.t.api("GET", "/api/tasks")).body.tasks.length, 0);
  assert.equal((await s.t.api("GET", "/api/inbox")).body.items[0].title, "Chief：执行计划：做大事");
  assert.match((await s.t.api("GET", `/api/conversations/${s.conv}/items`)).body.activity.text, /等待你批准/);
  assert.ok(s.t.events.some((e: any) => e.type === "notify" && e.kind === "approval"));
  await s.decide(c.id, "deny");
  assert.equal((await p).isError, true);
  s.boss.reply();
  await s.end();
});

test("approving runs the steps by their dependencies, with the acceptance criteria in the task", async () => {
  const s = await setup();
  const p = s.bus(s.boss, "propose_plan", PLAN);
  const c = await s.card();
  assert.equal((await s.decide(c.id, "allow")).status, 200);
  const r = await p;
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text);
  assert.deepEqual(out.tasks.map((t: any) => [t.id, t.bot, t.status]), [["a", "Writer", "running"], ["b", "Checker", "waiting"]]);
  const w = await s.waitRt("Writer");
  assert.match(w.sent[0], /写代码[\s\S]*验收条件（用户确认过）：\s*有测试[\s\S]*逐条/);
  assert.equal(s.rt("Checker"), undefined, "waits for its dependency");
  w.reply("写好了");
  const k = await s.waitRt("Checker");
  assert.match(k.sent[0], /写好了/, "it sees what it depends on");
  k.reply("审完了");
  const done = await s.bus(s.boss, "get_task", { task_id: out.tasks[1].task_id, wait_seconds: 5 });
  assert.match(done.text, /审完了/);
  s.boss.reply();
  await s.end();
});

test("the person's edits are what runs: owner, text, acceptance, order, added and removed steps", async () => {
  const s = await setup();
  const p = s.bus(s.boss, "propose_plan", { title: "x", tasks: [...PLAN.tasks, { id: "c", bot: "Third", task: "不要了" }] });
  const c = await s.card();
  const edited = [
    { id: "new", bot: "Third", task: "我加的一步", acceptance: "我的标准", depends_on: [] },
    { id: "b", bot: "Checker", task: "审查（改过）", depends_on: ["new"] },
    { id: "a", bot: "Checker", task: "换人写", depends_on: ["b"] },
  ];
  assert.equal((await s.decide(c.id, "allow", { tasks: edited })).status, 200);
  const out = JSON.parse((await p).text);
  assert.deepEqual(out.tasks.map((t: any) => [t.id, t.bot]), [["new", "Third"], ["b", "Checker"], ["a", "Checker"]]);
  assert.match(out.note, /用户可能改过/);
  const third = await s.waitRt("Third");
  assert.match(third.sent[0], /我加的一步[\s\S]*我的标准/);
  third.reply();
  const k = await s.waitRt("Checker");
  assert.match(k.sent[0], /审查（改过）/);
  k.reply();
  await s.waitRt("Checker", 2);
  assert.match(k.sent[1], /换人写/, "same session, taking turns");
  k.reply();
  await s.t.waitFor(async () => (await s.task(out.tasks[2].task_id)).status === "done", "last step");
  const final = (await s.items()).find((i) => i.data.kind === "plan");
  assert.equal(final.status, "allowed");
  assert.equal(final.data.tasks.length, 3, "the record shows what was approved");
  s.boss.reply();
  await s.end();
});

test("bad edits stay on the card, which stays open", async () => {
  const s = await setup();
  const p = s.bus(s.boss, "propose_plan", PLAN);
  const c = await s.card();
  const bad: [object[], RegExp][] = [
    [[], /至少/],
    [[{ id: "a", bot: "没这个人", task: "x" }], /不存在/],
    [[{ id: "a", bot: "Writer", task: " " }], /没有写/],
    [[{ id: "a", bot: "Chief", task: "x" }], /不能派给/],
    [[{ id: "a", bot: "Writer", task: "x" }, { id: "a", bot: "Writer", task: "y" }], /不能重复/],
    [[{ id: "a", bot: "Writer", task: "x", depends_on: ["z"] }], /不在计划里/],
    [[{ id: "a", bot: "Writer", task: "x", depends_on: ["b"] }, { id: "b", bot: "Writer", task: "y", depends_on: ["a"] }], /成环/],
  ];
  for (const [tasks, re] of bad) {
    const r = await s.decide(c.id, "allow", { tasks });
    assert.equal(r.status, 400, JSON.stringify(tasks));
    assert.match(r.body.error, re);
  }
  assert.equal((await s.items()).find((i) => i.id === c.id).status, "pending");
  assert.equal((await s.decide(c.id, "allow")).status, 200, "and can still be approved");
  await p;
  (await s.waitRt("Writer")).reply();
  (await s.waitRt("Checker")).reply();
  s.boss.reply();
  await s.end();
});

test("Chief's own draft is checked too, and only Chief can propose", async () => {
  const s = await setup();
  const r = await s.bus(s.boss, "propose_plan", { title: "x", tasks: [{ id: "a", bot: "没这个人", task: "x" }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /不存在/);
  assert.equal((await s.bus(s.boss, "propose_plan", { title: "x", tasks: "不是列表" })).isError, true);
  await s.t.api("PUT", "/api/settings", { max_calls: 1 });
  assert.match((await s.bus(s.boss, "propose_plan", PLAN)).text, /最多还能派 1 个/);
  await s.t.api("PUT", "/api/settings", { max_calls: 10 });
  const ask = s.bus(s.boss, "ask_bot", { bot: "Writer", question: "你试试" });
  const w = await s.waitRt("Writer");
  assert.match((await s.bus(w, "propose_plan", PLAN)).text, /只有 Chief/);
  assert.doesNotMatch(w.opts.bus!.env.BUS_TOOLS, /propose_plan/);
  assert.match(s.boss.opts.bus!.env.BUS_TOOLS, /propose_plan/);
  w.reply();
  await ask;
  s.boss.reply();
  await s.end();
});

test("asking for changes hands the person's words back to Chief, and nothing was started", async () => {
  const s = await setup();
  const p = s.bus(s.boss, "propose_plan", PLAN);
  const c = await s.card();
  await s.decide(c.id, "deny", { feedback: "先审查再写" });
  const r = await p;
  assert.equal(r.isError, true);
  assert.match(r.text, /先审查再写/);
  assert.match(r.text, /propose_plan/);
  const k = (await s.items()).find((i) => i.id === c.id);
  assert.deepEqual([k.status, k.data.feedback], ["denied", "先审查再写"]);
  assert.equal((await s.t.api("GET", "/api/tasks")).body.tasks.length, 0);

  const again = s.bus(s.boss, "propose_plan", { title: "第二版", tasks: [PLAN.tasks[1]].map((t) => ({ ...t, depends_on: [] })) });
  const second = await s.card();
  assert.notEqual(second.id, c.id);
  await s.decide(second.id, "deny");
  assert.match((await again).text, /拒绝/);
  s.boss.reply();
  await s.end();
});

test("a step that cannot start is reported, along with what depends on it", async () => {
  const s = await setup();
  const p = s.bus(s.boss, "propose_plan", { title: "x", tasks: [{ id: "a", bot: "Writer", task: "放工作树", isolated: true }, { id: "b", bot: "Checker", task: "审查", depends_on: ["a"] }, { id: "c", bot: "Third", task: "另一件事" }] });
  const c = await s.card();
  await s.decide(c.id, "allow");
  const out = JSON.parse((await p).text);
  assert.deepEqual(out.tasks.map((t: any) => [t.id, t.status]), [["a", "refused"], ["b", "refused"], ["c", "running"]], "this directory is not a Git repository");
  assert.match(out.tasks[1].reason, /依赖的 a/);
  (await s.waitRt("Third")).reply();
  s.boss.reply();
  await s.end();
});

test("stopping the round while a plan waits expires it, and it can no longer be approved", async () => {
  const s = await setup();
  const p = s.bus(s.boss, "propose_plan", PLAN);
  const c = await s.card();
  await s.t.api("POST", `/api/conversations/${s.conv}/interrupt`, {});
  assert.match((await p).text, /失效/);
  await s.t.waitFor(async () => (await s.items()).find((i) => i.id === c.id).status === "expired", "expired");
  assert.equal((await s.decide(c.id, "allow")).status, 409);
  assert.equal(s.rt("Writer"), undefined);
  await s.end();
});

test("a plan's tasks live in the task center and spend from the round", async () => {
  const s = await setup();
  const p = s.bus(s.boss, "propose_plan", { title: "x", tasks: [{ id: "a", bot: "Writer", task: "写" }] });
  await s.decide((await s.card()).id, "allow");
  const { tasks: [t] } = JSON.parse((await p).text);
  const view = await s.task(t.task_id);
  assert.equal(view.owner, "Writer");
  assert.equal(view.can_cancel, true);
  await s.t.api("POST", `/api/tasks/${t.task_id}/cancel`, {});
  await s.t.waitFor(async () => (await s.task(t.task_id)).status === "interrupted", "cancelled");
  s.boss.reply();
  await s.end();
});
