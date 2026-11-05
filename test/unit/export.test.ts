import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
  const mk = async (name: string) => (await t.api("POST", "/api/bots", { name, role: `ROLE-${name}`, agent: "codex", model: "gpt-6-luna", cwd })).body;
  const bots: Record<string, any> = { A: await mk("A"), B: await mk("B") };
  const pid = Memory.projectId(cwd);
  const rt = (n: string) => made.find((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`));
  const waitRt = async (n: string, sends = 1) => {
    await t.waitFor(() => (rt(n)?.sent.length ?? 0) >= sends, `${n} gets ${sends}`);
    return rt(n)!;
  };
  const idle = (id: string) => t.waitFor(async () => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation.status === "idle", "idle");
  const chat = async (n: string, text: string, reply: string, conversationId?: string, sends = 1) => {
    const id = (await t.api("POST", `/api/bots/${bots[n].id}/messages`, { text, conversationId })).body.id as string;
    (await waitRt(n, sends)).reply(reply);
    await idle(id);
    return id;
  };
  const bus = (f: Fake, tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  // Downloads a pack and opens it the way the person would.
  const unpack = async (path: string) => {
    const r = await fetch(t.base + path);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(r.headers.get("content-type"), "application/gzip");
    const dir = mkdtempSync(join(tmpdir(), "bot-unpack-"));
    writeFileSync(join(dir, "pack.tgz"), Buffer.from(await r.arrayBuffer()));
    execFileSync("tar", ["-xzf", "pack.tgz"], { cwd: dir });
    const top = readdirSync(dir).find((n) => n !== "pack.tgz")!;
    return { root: join(dir, top), disposition: decodeURIComponent(r.headers.get("content-disposition")!) };
  };
  const runExperiment = async () => {
    await t.api("PUT", `/api/projects/${pid}/settings`, { enabled: true, auto_wake: false });
    const id = (await t.api("POST", `/api/bots/${bots.A.id}/messages`, { text: "跑" })).body.id;
    const a = await waitRt("A");
    const p = bus(a, "run_experiment", { name: "基线/实验", command: `echo 训练日志; echo '{"dice":0.8}' > "$BOT_METRICS_FILE"; echo pic > "$BOT_ARTIFACTS_DIR/out.txt"`, seed: 3, config: { lr: 0.1 } });
    const card: any = await t.waitFor(async () => (await t.api("GET", `/api/conversations/${id}/items`)).body.items.find((i: any) => i.data.kind === "job_request" && i.status === "pending"), "card");
    await t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" });
    const exp = JSON.parse((await p).text).experiment_id as string;
    await t.waitFor(async () => (await t.api("GET", `/api/projects/${pid}/research`)).body.experiments.find((e: any) => e.id === exp)?.status === "done", "done", 8000);
    a.reply("完");
    await idle(id);
    return { id, exp };
  };
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end");
    await new Promise((r) => setTimeout(r, 30));
    t.close();
  };
  return { t, made, cwd, pid, bots, rt, waitRt, idle, chat, bus, unpack, runExperiment, end };
}

test("a conversation exports as readable Markdown", async () => {
  const s = await setup();
  const id = await s.chat("A", "怎么做？", "这样做");
  const a = s.rt("A")!;
  await s.t.api("POST", `/api/bots/${s.bots.A.id}/messages`, { text: "再来", conversationId: id });
  await s.waitRt("A", 2);
  a.emit({ type: "tool", key: "t", title: "运行命令：ls", output: "秘密输出", status: "running" });
  a.emit({ type: "tool", key: "t", title: "", status: "done" });
  a.emit({ type: "turn_end", status: "failed", error: "连接断了" });
  await s.idle(id);
  const r = await fetch(`${s.t.base}/api/conversations/${id}/export`);
  assert.match(r.headers.get("content-type")!, /text\/markdown/);
  assert.match(decodeURIComponent(r.headers.get("content-disposition")!), /怎么做？\.md/);
  const text = await r.text();
  assert.match(text, /^# 怎么做？/);
  assert.match(text, /## 你 · [\s\S]*怎么做？/);
  assert.match(text, /## A · [\s\S]*这样做/);
  assert.match(text, /工具：运行命令：ls（done）/);
  assert.doesNotMatch(text, /秘密输出/, "tool output stays out");
  assert.match(text, /错误：连接断了/);
  assert.equal((await fetch(`${s.t.base}/api/conversations/nope/export`)).status, 404);
  await s.end();
});

test("export covers plans, calls, results and comparisons, and hides attachment paths", async () => {
  const s = await setup();
  const g = (await s.t.api("POST", "/api/groups", { name: "群", members: [s.bots.A.id, s.bots.B.id], cwd: s.cwd })).body;
  const up = await fetch(`${s.t.base}/api/uploads?name=data.txt`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "x" }).then((r) => r.json()) as any;
  const conv = (await s.t.api("POST", `/api/groups/${g.id}/compare`, { text: "选哪个", attachments: [up.id] })).body.id;
  await s.t.waitFor(() => s.made.length >= 2 && s.made.every((f) => f.sent.length), "answers");
  s.made[0].reply("选甲");
  s.made[1].reply("选乙");
  await s.t.waitFor(() => s.made[2]?.sent.length, "summary");
  s.made[2].reply('{"consensus":["要选"],"disagreements":[],"gaps":[]}');
  await s.idle(conv);
  const text = await fetch(`${s.t.base}/api/conversations/${conv}/export`).then((r) => r.text());
  assert.match(text, /群聊：群/);
  assert.match(text, /独立比较（done）：选哪个/);
  assert.match(text, /选甲[\s\S]*选乙/);
  assert.match(text, /模型生成，未经核实/);
  assert.match(text, /附件：data\.txt/);
  assert.doesNotMatch(text.split("独立比较")[0], /\.bot-attachments/);
  await s.end();
});

test("an experiment pack holds what is needed to reproduce it", async () => {
  const s = await setup();
  const { exp } = await s.runExperiment();
  s.t.store.db.prepare("UPDATE experiments SET test_metrics=? WHERE id=?").run('{"test_dice":0.7}', exp);
  const { root, disposition } = await s.unpack(`/api/experiments/${exp}/export`);
  assert.match(disposition, /基线 实验/, "the slash in the name cannot make a path");
  assert.deepEqual(JSON.parse(readFileSync(join(root, "config.json"), "utf8")), { lr: 0.1 });
  assert.match(readFileSync(join(root, "log.txt"), "utf8"), /训练日志/);
  assert.equal(JSON.parse(readFileSync(join(root, "metrics.json"), "utf8")).dice, 0.8);
  assert.equal(readFileSync(join(root, "artifacts", "out.txt"), "utf8"), "pic\n");
  const meta = JSON.parse(readFileSync(join(root, "experiment.json"), "utf8"));
  assert.deepEqual([meta.name, meta.seed, meta.status], ["基线/实验", 3, "done"]);
  assert.equal(meta.test_metrics.test_dice, 0.7);
  assert.match(meta.restore_code, /没有记录代码版本/, "this directory is not a repository");
  assert.match(readFileSync(join(root, "说明.txt"), "utf8"), /测试集/);
  await s.end();
});

test("a link in a run's results is packed as a link, not as what it points to", async () => {
  const s = await setup();
  const { exp } = await s.runExperiment();
  const secret = join(mkdtempSync(join(tmpdir(), "bot-secret-")), "id_rsa");
  writeFileSync(secret, "SECRET");
  symlinkSync(secret, join(s.t.home, "runs", exp, "artifacts", "link.txt"));
  const { root } = await s.unpack(`/api/experiments/${exp}/export`);
  const packed = execFileSync("tar", ["-czf", "-", "-C", root, "artifacts"]).toString("latin1");
  assert.doesNotMatch(packed, /SECRET/);
  assert.equal(execFileSync("readlink", [join(root, "artifacts", "link.txt")], { encoding: "utf8" }).trim(), secret);
  assert.equal((await fetch(`${s.t.base}/api/experiments/nothere1/export`)).status, 404);
  assert.equal((await fetch(`${s.t.base}/api/experiments/..%2f..%2fx/export`)).status, 404, "an id is looked up, never used as a path");
  await s.end();
});

test("a project backup holds its records, says what it leaves out, and contains no other project", async () => {
  const s = await setup();
  await s.t.api("PUT", `/api/projects/${s.pid}/brief`, { name: "项目甲", goal: "目标文字" });
  writeFileSync(join(s.cwd, "code.py"), "这是工作目录里的代码");
  const up = await fetch(`${s.t.base}/api/uploads?name=note.txt`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "附件内容" }).then((r) => r.json()) as any;
  const { id, exp } = await s.runExperiment();
  await s.t.api("POST", `/api/bots/${s.bots.A.id}/messages`, { text: "带附件", conversationId: id, attachments: [up.id] });
  await s.waitRt("A", 2);
  s.rt("A")!.reply();
  await s.idle(id);
  await s.t.api("POST", `/api/bots/${s.bots.B.id}/messages`, { text: "将被归档" });
  (await s.waitRt("B")).reply();
  const archived = (s.t.store.db.prepare("SELECT id FROM conversations WHERE bot_id=? AND kind='direct'").get(s.bots.B.id) as any).id;
  await s.idle(archived);
  await s.t.api("DELETE", `/api/conversations/${archived}`);

  const other = mkdtempSync(join(tmpdir(), "bot-other-"));
  const z = (await s.t.api("POST", "/api/bots", { name: "Z", role: "ROLE-Z", agent: "codex", model: "gpt-6-luna", cwd: other })).body;
  s.bots.Z = z;
  const zc = (await s.t.api("POST", `/api/bots/${z.id}/messages`, { text: "别的项目的话" })).body.id;
  (await s.waitRt("Z")).reply();
  await s.idle(zc);

  const { root, disposition } = await s.unpack(`/api/projects/${s.pid}/backup?cwd=${encodeURIComponent(s.cwd)}`);
  assert.match(disposition, /项目甲-备份/);
  const project = JSON.parse(readFileSync(join(root, "project.json"), "utf8"));
  assert.equal(project.brief.goal, "目标文字");
  assert.deepEqual(project.bots.map((b: any) => b.name).sort(), ["A", "B"]);
  const files = readdirSync(join(root, "conversations"));
  assert.ok(files.some((f) => f.endsWith("-已归档.md")), "archived ones are kept");
  assert.equal(files.filter((f) => f.endsWith(".md")).length, 2);
  assert.ok(files.every((f) => !/别的项目/.test(readFileSync(join(root, "conversations", f), "utf8"))));
  assert.equal(readFileSync(join(root, "attachments", up.id, "note.txt"), "utf8"), "附件内容");
  assert.equal(JSON.parse(readFileSync(join(root, "experiments", exp, "metrics.json"), "utf8")).dice, 0.8);
  assert.ok(Array.isArray(JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))));
  assert.ok(existsSync(join(root, "memory", "项目记忆.md")));
  assert.equal(existsSync(join(root, "code.py")), false);
  assert.match(readFileSync(join(root, "说明.txt"), "utf8"), /没有包含工作目录[\s\S]*不能导入/);
  assert.equal((await fetch(`${s.t.base}/api/projects/${s.pid}/backup?cwd=/elsewhere`)).status, 400);
  await s.end();
});

test("the database download is a working copy, and the temporary files are cleaned up", async () => {
  const s = await setup();
  await s.chat("A", "留下来的话", "好");
  const r = await fetch(`${s.t.base}/api/backup`);
  assert.equal(r.status, 200);
  const dir = mkdtempSync(join(tmpdir(), "bot-db-"));
  writeFileSync(join(dir, "copy.db"), Buffer.from(await r.arrayBuffer()));
  const db = new DatabaseSync(join(dir, "copy.db"));
  const row = db.prepare("SELECT COUNT(*) n FROM items WHERE data LIKE '%留下来的话%'").get() as any;
  db.close();
  assert.equal(row.n, 1);
  await s.end();
});

test("an archived conversation comes back, with everything in it", async () => {
  const s = await setup();
  const id = await s.chat("A", "归档前的话", "好");
  await s.t.api("DELETE", `/api/conversations/${id}`);
  let a = (await s.t.api("GET", "/api/archive")).body;
  assert.deepEqual(a.conversations.map((c: any) => [c.id, c.title, c.bot_name]), [[id, "归档前的话", "A"]]);
  assert.equal((await s.t.api("GET", "/api/state")).body.bots.find((b: any) => b.id === s.bots.A.id).conversations.length, 0);
  assert.equal((await s.t.api("POST", `/api/conversations/${id}/restore`, {})).status, 200);
  a = (await s.t.api("GET", "/api/archive")).body;
  assert.equal(a.conversations.length, 0);
  assert.equal((await s.t.api("GET", "/api/state")).body.bots.find((b: any) => b.id === s.bots.A.id).conversations.length, 1);
  assert.ok(s.t.events.some((e: any) => e.type === "bots_changed"));
  // Archiving closed its agent, so this starts a new one and resumes the session.
  await s.t.api("POST", `/api/bots/${s.bots.A.id}/messages`, { text: "继续聊", conversationId: id });
  await s.t.waitFor(() => s.made.at(-1)!.sent.includes("继续聊"), "continues");
  s.made.at(-1)!.reply();
  await s.idle(id);
  assert.equal((await s.t.api("GET", `/api/search?q=${encodeURIComponent("归档前")}`)).body.results.length, 1);
  await s.end();
});

test("a Bot and a group can be restored, within the rules", async () => {
  const s = await setup();
  const id = await s.chat("B", "B 的话", "好");
  await s.t.api("DELETE", `/api/bots/${s.bots.B.id}`);
  await s.t.api("DELETE", `/api/conversations/${id}`);
  let a = (await s.t.api("GET", "/api/archive")).body;
  assert.deepEqual(a.bots.map((b: any) => b.name), ["B"]);
  assert.equal(a.conversations[0].owner_archived, 1);
  const blocked = await s.t.api("POST", `/api/conversations/${id}/restore`, {});
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /先恢复/);

  const clash = (await s.t.api("POST", "/api/bots", { name: "b", role: "", agent: "codex", model: "gpt-6-luna", cwd: s.cwd })).body;
  const r = await s.t.api("POST", `/api/bots/${s.bots.B.id}/restore`, {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /已经有叫/);
  await s.t.api("DELETE", `/api/bots/${clash.id}`);
  assert.equal((await s.t.api("POST", `/api/bots/${s.bots.B.id}/restore`, {})).status, 200);
  assert.equal((await s.t.api("POST", `/api/bots/${s.bots.B.id}/restore`, {})).status, 404, "already back");
  assert.equal((await s.t.api("POST", `/api/conversations/${id}/restore`, {})).status, 200);

  const g = (await s.t.api("POST", "/api/groups", { name: "群", members: [s.bots.A.id, s.bots.B.id], cwd: s.cwd })).body;
  await s.t.api("DELETE", `/api/groups/${g.id}`);
  assert.deepEqual((await s.t.api("GET", "/api/archive")).body.groups.map((x: any) => x.name), ["群"]);
  assert.equal((await s.t.api("POST", `/api/groups/${g.id}/restore`, {})).status, 200);
  assert.ok((await s.t.api("GET", "/api/state")).body.groups.some((x: any) => x.id === g.id));
  assert.equal((await s.t.api("POST", "/api/bots/nope/restore", {})).status, 404);
  await s.end();
});
