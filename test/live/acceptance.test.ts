// Runs every real agent on its cheapest model and uses a little quota. `npm run test:live`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { CHEAPEST } from "./cheap.ts";
import type { AgentKind, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

const TURN_MS = 180000;

// Stands in for the Bot that hands out work, so only the one under test spends anything.
class Caller implements AgentRuntime {
  opts: RuntimeOptions;
  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }
  async start() {}
  async send() {}
  async interrupt() {
    this.opts.onEvent({ type: "turn_end", status: "interrupted" });
  }
  answerApproval(_: string, __: ApprovalDecision) {}
  stop() {}
  finish() {
    this.opts.onEvent({ type: "text_done", key: "end", text: "完" });
    this.opts.onEvent({ type: "turn_end", status: "completed" });
  }
}

async function setup(agent: AgentKind) {
  const cwd = mkdtempSync(join(tmpdir(), `bot-accept-${agent}-`));
  const run = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd });
  run("init", "-q");
  writeFileSync(join(cwd, "README.md"), "x\n");
  run("add", "-A");
  run("commit", "-qm", "first");
  let caller: Caller | undefined;
  const t = await boot((o) => {
    if (o.systemPrompt.startsWith("CALLER")) return (caller = new Caller(o));
    return realFactory(o);
  });
  const worker = (await t.api("POST", "/api/bots", { name: "W", role: "你是测试用的助手。照用户说的做，不要多做别的，回答尽量短。", agent, model: CHEAPEST[agent], effort: "low", permission: "auto_edit", cwd })).body;
  assert.ok(worker.id, JSON.stringify(worker));
  const boss = (await t.api("POST", "/api/bots", { name: "Boss", role: "CALLER", agent: "codex", model: CHEAPEST.codex, cwd })).body;
  const data = async (conv: string) => (await t.api("GET", `/api/conversations/${conv}/items`)).body;
  const approve = async (d: any) => {
    for (const i of d.items) if (i.type === "approval" && i.status === "pending") await t.api("POST", `/api/approvals/${i.id}`, { decision: "allow" });
  };
  const until = (conv: string, check: (d: any) => any, label: string) =>
    t.waitFor(async () => {
      const d = await data(conv);
      await approve(d);
      return check(d) && d;
    }, label, TURN_MS) as Promise<any>;
  const startCaller = async () => {
    const conv = (await t.api("POST", `/api/bots/${boss.id}/messages`, { text: "开始" })).body.id as string;
    await t.waitFor(() => caller, "caller");
    await new Promise((r) => setTimeout(r, 50));
    return conv;
  };
  const bus = (tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${caller!.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  const task = async (id: string) => (await t.api("GET", "/api/tasks")).body.tasks.find((x: any) => x.id === id);
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end", 30000);
    await new Promise((r) => setTimeout(r, 50));
    t.close();
  };
  return { t, cwd, worker, data, until, startCaller, bus, task, end, caller: () => caller! };
}

for (const agent of Object.keys(CHEAPEST) as AgentKind[]) {
  test(`${agent}: two tasks at once take turns on one session`, { timeout: 400000 }, async () => {
    const s = await setup(agent);
    const conv = await s.startCaller();
    const [a, b] = await Promise.all([s.bus("assign_task", { bot: "W", task: "只回复 ONE 这个词。" }), s.bus("assign_task", { bot: "W", task: "只回复 TWO 这个词。" })]);
    const one = JSON.parse(a.text);
    const two = JSON.parse(b.text);
    assert.deepEqual([one.status, two.status].sort(), ["running", "waiting"], a.text + b.text);
    const done = (id: string) => s.t.waitFor(async () => {
      const x = await s.task(id);
      return x.status !== "running" && x.status !== "waiting" && x;
    }, "task", TURN_MS) as Promise<any>;
    const first: any = await done(one.task_id);
    const second: any = await done(two.task_id);
    assert.equal(first.status, "done", JSON.stringify(first));
    assert.equal(second.status, "done", JSON.stringify(second));
    assert.match(first.answer, /ONE/);
    assert.match(second.answer, /TWO/);
    s.caller().finish();
    void conv;
    await s.end();
  });

  test(`${agent}: cancelling a running task stops it, and its Bot still works`, { timeout: 400000 }, async () => {
    const s = await setup(agent);
    await s.startCaller();
    const { task_id } = JSON.parse((await s.bus("assign_task", { bot: "W", task: "用 shell 运行这条命令：sleep 60 && echo late > late.txt 。等它结束后回复 DONE。" })).text);
    // Give it time to begin, whichever step it is on: a stop must work at any of them.
    await new Promise((r) => setTimeout(r, 6000));
    const started = Date.now();
    assert.equal((await s.t.api("POST", `/api/tasks/${task_id}/cancel`, {})).status, 202);
    const x: any = await s.t.waitFor(async () => {
      const v = await s.task(task_id);
      return v.status !== "running" && v;
    }, "cancelled", 20000);
    assert.equal(x.status, "interrupted", JSON.stringify(x));
    assert.match(x.failure_reason, /你取消/);
    assert.ok(Date.now() - started < 20000);
    assert.equal(x.can_retry, true);
    const next = await s.bus("assign_task", { bot: "W", task: "只回复 AGAIN 这个词。" });
    const again = JSON.parse(next.text);
    const y: any = await s.t.waitFor(async () => {
      const v = await s.task(again.task_id);
      return v.status !== "running" && v.status !== "waiting" && v;
    }, "next task", TURN_MS);
    assert.equal(y.status, "done", JSON.stringify(y));
    assert.match(y.answer, /AGAIN/);
    assert.equal(existsSync(join(s.cwd, "late.txt")), false, "the cancelled command did not finish");
    s.caller().finish();
    await s.end();
  });

  test(`${agent}: a queued message follows, and each result keeps what that round did`, { timeout: 500000 }, async () => {
    const s = await setup(agent);
    const conv = (await s.t.api("POST", `/api/bots/${s.worker.id}/messages`, { text: "创建文件 hello.py，内容只有一行：print('round-one')。写完回复 OK，不要做别的。" })).body.id as string;
    const queued = await s.t.api("POST", `/api/conversations/${conv}/followup`, { text: "把 hello.py 的内容改成只有一行：print('round-two')。写完回复 OK，不要做别的。", mode: "queue" });
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    assert.ok(["queued", "sent"].includes(queued.body.delivered), JSON.stringify(queued.body));
    const d = await s.until(conv, (x) => x.items.filter((i: any) => i.type === "result").length >= 2 && x.conversation.status === "idle", "two rounds");
    const errors = d.items.filter((i: any) => i.type === "error").map((i: any) => i.data.message);
    assert.deepEqual(errors, []);
    const [first, second] = d.items.filter((i: any) => i.type === "result");
    assert.equal(first.status, "completed");
    assert.deepEqual(first.data.files, [{ path: "hello.py", change: "新增" }], JSON.stringify(first.data));
    assert.equal(first.data.source, "git");
    const a = (await s.t.api("GET", `/api/items/${first.id}/diff`)).body;
    const b = (await s.t.api("GET", `/api/items/${second.id}/diff`)).body;
    assert.match(a.diff, /\+print\('round-one'\)/, "the new file's content");
    assert.doesNotMatch(a.diff, /round-two/, "still what that round did");
    assert.match(b.diff, /round-two/);
    await s.end();
  });
}
