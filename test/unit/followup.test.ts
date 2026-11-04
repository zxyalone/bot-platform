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
class Steerable extends Fake {
  steered: string[] = [];
  refuse = false;
  async steer(t: string) {
    if (this.refuse) throw new Error("no");
    this.steered.push(t);
  }
}

async function setup(o: { steer?: boolean; cwd?: string; home?: string } = {}) {
  const made: Fake[] = [];
  const t = await boot((opts) => {
    const f = o.steer ? new Steerable(opts) : new Fake(opts);
    made.push(f);
    return f;
  }, { home: o.home });
  const cwd = o.cwd ?? mkdtempSync(join(tmpdir(), "bot-proj-"));
  const bot = (await t.api("POST", "/api/bots", { name: "A", role: "R", agent: "codex", model: "gpt-6-luna", cwd })).body;
  const items = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];
  const status = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation.status;
  const idle = (id: string) => t.waitFor(async () => (await status(id)) === "idle", "idle");
  const start = async (text = "做") => {
    const before = made.length;
    const conv = (await t.api("POST", `/api/bots/${bot.id}/messages`, { text })).body.id as string;
    await t.waitFor(() => made.length > before && made.at(-1)!.sent.length, "agent");
    return { conv, f: made.at(-1)! };
  };
  const follow = (conv: string, text: string, mode = "queue") => t.api("POST", `/api/conversations/${conv}/followup`, { text, mode });
  return { t, made, bot, cwd, items, status, idle, start, follow };
}
const queued = (list: any[]) => list.filter((i) => i.type === "queued");
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "bot-repo-"));
  gitIn(cwd, "init", "-q");
  writeFileSync(join(cwd, "a.py"), "1\n");
  writeFileSync(join(cwd, "dirty.py"), "1\n");
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-qm", "first");
  return cwd;
}

// ---------- queueing ----------
test("messages sent during a turn wait, then go out in order as ordinary messages", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  assert.equal((await s.t.api("POST", `/api/bots/${s.bot.id}/messages`, { text: "x", conversationId: conv })).status, 409, "the plain route still refuses");
  assert.equal((await s.follow(conv, "第二条")).body.delivered, "queued");
  await s.follow(conv, "第三条");
  assert.equal(f.sent.length, 1, "the agent is not disturbed");
  assert.equal((await s.items(conv)).filter((i) => i.type === "user").length, 1, "not in the transcript yet, so it cannot sit above the reply it follows");
  f.reply("第一个回复");
  await s.t.waitFor(() => f.sent.length === 2, "second goes out");
  assert.equal(f.sent[1], "第二条");
  f.reply();
  await s.t.waitFor(() => f.sent.length === 3, "third goes out");
  assert.equal(f.sent[2], "第三条");
  f.reply();
  await s.idle(conv);
  const list = await s.items(conv);
  const order = list.filter((i) => i.type === "user" || i.type === "assistant").map((i) => i.data.text);
  assert.deepEqual(order, ["做", "第一个回复", "第二条", "好", "第三条", "好"]);
  assert.deepEqual(queued(list).map((i) => i.status), ["sent", "sent"]);
  s.t.close();
});

test("a queued message can be withdrawn, and gives its text back", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  const id = (await s.follow(conv, "算了")).body.itemId;
  assert.equal((await s.t.api("POST", `/api/items/${id}/withdraw`, {})).body.text, "算了");
  assert.equal((await s.t.api("POST", `/api/items/${id}/withdraw`, {})).status, 409);
  f.reply();
  await s.idle(conv);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(f.sent.length, 1);
  s.t.close();
});

test("stopping a round keeps what was queued out of the agent, and the text is not lost", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  const id = (await s.follow(conv, "下一步")).body.itemId;
  await s.t.api("POST", `/api/conversations/${conv}/interrupt`, {});
  await s.idle(conv);
  const row: any = await s.t.waitFor(async () => queued(await s.items(conv)).find((i) => i.status === "unsent"), "unsent");
  assert.match(row.data.reason, /停止/);
  assert.equal(f.sent.length, 1, "a stop means stop");
  assert.equal((await s.t.api("POST", `/api/items/${id}/withdraw`, {})).body.text, "下一步");
  s.t.close();
});

test("a stopping round refuses more, a finished one just sends, and the queue is capped", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  for (let i = 0; i < 10; i++) assert.equal((await s.follow(conv, `m${i}`)).status, 202);
  assert.equal((await s.follow(conv, "太多了")).status, 409);
  await s.t.api("POST", `/api/conversations/${conv}/interrupt`, {});
  await s.idle(conv);
  assert.equal((await s.follow(conv, "结束后发的")).body.delivered, "sent");
  await s.t.waitFor(() => f.sent.at(-1) === "结束后发的", "sent straight away");
  s.t.close();
});

test("a restart leaves queued messages unsent and says so", async () => {
  const home = tempHome();
  const a = await setup({ home });
  const { conv } = await a.start();
  await a.follow(conv, "还没发");
  a.t.close();
  const b = await setup({ home });
  const row = queued(await b.items(conv))[0];
  assert.equal(row.status, "unsent");
  assert.match(row.data.reason, /重启/);
  b.t.close();
});

test("a group queues too, and a message nobody is mentioned in is refused up front", async () => {
  const s = await setup();
  const other = (await s.t.api("POST", "/api/bots", { name: "B", role: "R", agent: "codex", model: "gpt-6-luna", cwd: s.cwd })).body;
  const g = (await s.t.api("POST", "/api/groups", { name: "g", members: [s.bot.id, other.id], cwd: s.cwd })).body;
  const conv = (await s.t.api("POST", `/api/groups/${g.id}/messages`, { text: "@A 做" })).body.id as string;
  await s.t.waitFor(() => s.made[0]?.sent.length, "A");
  assert.equal((await s.follow(conv, "没有叫人")).status, 400);
  assert.equal((await s.follow(conv, "@B 接着", "steer")).body.delivered, "queued", "a group has no single agent to steer");
  s.made[0].reply();
  await s.t.waitFor(() => s.made[1]?.sent.length, "B");
  assert.match(s.made[1].sent[0], /@B 接着/);
  s.t.close();
});

// ---------- steering ----------
test("steering joins the running turn; it shows in the transcript and starts no new round", async () => {
  const s = await setup({ steer: true });
  const { conv, f } = await s.start();
  assert.equal((await s.follow(conv, "顺便加日志", "steer")).body.delivered, "steered");
  assert.deepEqual((f as Steerable).steered, ["顺便加日志"]);
  assert.equal(f.sent.length, 1);
  assert.deepEqual((await s.items(conv)).filter((i) => i.data.steered).map((i) => i.data.text), ["顺便加日志"]);
  const turns = () => s.t.store.db.prepare("SELECT COUNT(*) n FROM root_turns WHERE conv_id=?").get(conv) as any;
  assert.equal(turns().n, 1);
  f.reply();
  await s.idle(conv);
  s.t.close();
});

test("an agent that cannot or will not steer falls back to the queue, so nothing is lost", async () => {
  const plain = await setup();
  const a = await plain.start();
  assert.equal((await plain.follow(a.conv, "x", "steer")).body.delivered, "queued");
  plain.t.close();
  const s = await setup({ steer: true });
  const b = await s.start();
  (b.f as Steerable).refuse = true;
  assert.equal((await s.follow(b.conv, "y", "steer")).body.delivered, "queued");
  b.f.reply();
  await s.t.waitFor(() => b.f.sent.at(-1) === "y", "sent after the turn");
  s.t.close();
});

test("a reply to a steer that came too late is still shown", async () => {
  const s = await setup({ steer: true });
  const { conv, f } = await s.start();
  await s.follow(conv, "晚了一点", "steer");
  f.reply("第一段");
  await s.idle(conv);
  f.emit({ type: "text_done", key: "late", text: "对补充的回答" });
  assert.ok((await s.items(conv)).some((i) => i.data.text === "对补充的回答"));
  s.t.close();
});

// ---------- activity ----------
test("the status says what is happening, and an approval comes first", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  const seen = async () => (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.activity;
  assert.equal((await seen()).text, "正在思考");
  f.emit({ type: "tool", key: "c", title: "运行命令：ls", status: "running", command: "ls" });
  assert.equal((await seen()).text, "正在执行：运行命令：ls");
  f.emit({ type: "tool", key: "c", title: "", status: "done" });
  f.emit({ type: "tool", key: "e1", title: "修改 a", status: "running", files: ["a"] });
  f.emit({ type: "tool", key: "e1", title: "", status: "done" });
  f.emit({ type: "tool", key: "e2", title: "修改 b", status: "running", files: ["b", "c"] });
  assert.equal((await seen()).text, "正在修改 3 个文件");
  f.emit({ type: "tool", key: "e2", title: "", status: "done" });
  f.emit({ type: "text_delta", key: "t", text: "写" });
  assert.equal((await seen()).text, "正在回复");
  f.emit({ type: "approval", requestId: "r", title: "写入 a", detail: "", canRemember: false });
  const a = await seen();
  assert.deepEqual([a.kind, a.text], ["approval", "等待你批准：写入 a"]);
  assert.ok(Date.now() - a.at < 2000);
  await s.t.waitFor(() => s.t.events.some((e: any) => e.type === "activity" && e.convId === conv && e.activity?.kind === "approval"), "pushed to the page");
  f.reply();
  await s.idle(conv);
  assert.equal(await seen(), null);
  s.t.close();
});

test("the status names the Bot being waited on, and what it is doing", async () => {
  const s = await setup();
  await s.t.api("POST", "/api/bots", { name: "B", role: "R", agent: "codex", model: "gpt-6-luna", cwd: s.cwd });
  const { conv, f } = await s.start();
  const p = fetch(`${s.t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool: "ask_bot", args: { bot: "B", question: "看看" } }) }).then((r) => r.json());
  await s.t.waitFor(() => s.made[1]?.sent.length, "B");
  const seen = async () => (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.activity;
  assert.equal((await seen()).text, "等待 B：正在思考");
  s.made[1].emit({ type: "tool", key: "x", title: "读取 a", status: "running" });
  assert.equal((await seen()).text, "等待 B：正在执行：读取 a");
  s.made[1].reply();
  await p;
  f.reply();
  await s.idle(conv);
  s.t.close();
});

// ---------- result card ----------
const card = async (s: Awaited<ReturnType<typeof setup>>, conv: string) => s.t.waitFor(async () => (await s.items(conv)).find((i) => i.type === "result"), "result card") as Promise<any>;

test("a plain answer gets no card", async () => {
  const s = await setup({ cwd: repo() });
  const { conv, f } = await s.start();
  f.reply();
  await s.idle(conv);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await s.items(conv)).filter((i) => i.type === "result").length, 0);
  s.t.close();
});

test("the card reports what Git saw, not what was already dirty, and not what the Bot claims", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "dirty.py"), "already changed\n");
  const s = await setup({ cwd });
  const { conv, f } = await s.start();
  writeFileSync(join(cwd, "a.py"), "2\n");
  writeFileSync(join(cwd, "new file.py"), "x\n");
  f.reply("我改好了十个文件，全部测试通过");
  const c = await card(s, conv);
  assert.equal(c.status, "completed");
  assert.equal(c.data.source, "git");
  assert.deepEqual(c.data.files.map((x: any) => [x.path, x.change]).sort(), [["a.py", "修改"], ["new file.py", "新增"]]);
  assert.match(c.data.summary, /全部测试通过/);
  assert.deepEqual(c.data.checks, [], "a claim is not a check");

  const d = (await s.t.api("GET", `/api/items/${c.id}/diff`)).body;
  assert.match(d.diff, /a\.py/);
  assert.doesNotMatch(d.diff, /dirty\.py/);
  assert.deepEqual(d.untracked, ["new file.py"]);
  s.t.close();
});

test("a commit made during the round is counted, and the file shows as changed", async () => {
  const cwd = repo();
  const s = await setup({ cwd });
  const { conv, f } = await s.start();
  writeFileSync(join(cwd, "a.py"), "2\n");
  gitIn(cwd, "commit", "-qam", "bot");
  f.reply();
  const c = await card(s, conv);
  assert.equal(c.data.commits, 1);
  assert.deepEqual(c.data.files, [{ path: "a.py", change: "修改" }]);
  assert.match((await s.t.api("GET", `/api/items/${c.id}/diff`)).body.diff, /a\.py/);
  s.t.close();
});

test("a stopped round with changes still says what changed", async () => {
  const cwd = repo();
  const s = await setup({ cwd });
  const { conv } = await s.start();
  writeFileSync(join(cwd, "a.py"), "2\n");
  await s.t.api("POST", `/api/conversations/${conv}/interrupt`, {});
  assert.equal((await card(s, conv)).status, "interrupted");
  s.t.close();
});

test("checks are what the platform saw run, with how they exited; other commands do not count", async () => {
  const s = await setup({ cwd: repo() });
  const { conv, f } = await s.start();
  const run = (key: string, command: string, status: "done" | "failed") => {
    f.emit({ type: "tool", key, title: `运行命令：${command}`, status: "running", command });
    f.emit({ type: "tool", key, title: "", status });
  };
  run("1", "npm test", "done");
  run("2", "cd x && python -m pytest -q", "failed");
  run("3", "ls latest-test-results", "done");
  run("4", "echo test", "done");
  f.reply();
  const c = await card(s, conv);
  assert.deepEqual(c.data.checks, [{ command: "npm test", status: "done" }, { command: "cd x && python -m pytest -q", status: "failed" }]);
  assert.equal(c.data.source, "none");
  assert.equal(c.data.repo, null);
  assert.equal((await s.t.api("GET", `/api/items/${c.id}/diff`)).status, 404);
  s.t.close();
});

test("outside Git the card lists what tools reported and says where that came from", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  f.emit({ type: "tool", key: "e", title: "修改 a", status: "running", files: ["/tmp/a.txt"] });
  f.emit({ type: "tool", key: "e", title: "", status: "done" });
  f.reply();
  const c = await card(s, conv);
  assert.equal(c.data.source, "agent");
  assert.deepEqual(c.data.files, [{ path: "/tmp/a.txt", change: "修改" }]);
  s.t.close();
});

test("accepting a result only records that, and the next queued message comes after the card", async () => {
  const cwd = repo();
  const s = await setup({ cwd });
  const { conv, f } = await s.start();
  await s.follow(conv, "下一条");
  writeFileSync(join(cwd, "a.py"), "2\n");
  f.reply();
  await s.t.waitFor(() => f.sent.length === 2, "next");
  const list = await s.items(conv);
  const at = (t: (i: any) => boolean) => list.findIndex(t);
  assert.ok(at((i) => i.type === "result") < at((i) => i.type === "user" && i.data.text === "下一条"), "the card belongs to the round before");
  const c = list.find((i) => i.type === "result");
  const before = gitIn(cwd, "status", "--short");
  assert.equal((await s.t.api("POST", `/api/items/${c.id}/accept`, {})).body.data.accepted, true);
  assert.equal(gitIn(cwd, "status", "--short"), before);
  assert.equal((await s.t.api("POST", "/api/items/nope/accept", {})).status, 404);
  s.t.close();
});
