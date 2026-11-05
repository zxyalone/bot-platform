import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../helpers.ts";
import { Memory } from "../../src/daemon/git.ts";
import { Store } from "../../src/daemon/store.ts";
import { Artifacts } from "../../src/daemon/artifacts.ts";
import type { AgentEvent, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

class Fake implements AgentRuntime {
  sent: string[] = [];
  steered: string[] = [];
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
  async steer(t: string) {
    this.steered.push(t);
  }
  async interrupt() {
    this.emit({ type: "turn_end", status: "interrupted" });
  }
  answerApproval(_: string, __: ApprovalDecision) {}
  stop() {}
}
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "bot-repo-"));
  gitIn(cwd, "init", "-q");
  writeFileSync(join(cwd, "a.py"), "1\n");
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-qm", "first");
  return cwd;
}
async function setup(cwd = repo()) {
  const made: Fake[] = [];
  const revealed: string[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  }, { reveal: async (p) => void revealed.push(p) });
  const mk = async (name: string) => (await t.api("POST", "/api/bots", { name, role: `ROLE-${name}`, agent: "codex", model: "gpt-6-luna", cwd })).body;
  const bots: Record<string, any> = { A: await mk("A"), B: await mk("B") };
  const rt = (n: string) => made.find((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`));
  const waitRt = async (n: string, sends = 1) => {
    await t.waitFor(() => (rt(n)?.sent.length ?? 0) >= sends, `${n} gets ${sends}`);
    return rt(n)!;
  };
  const upload = async (name: string, body: string | Buffer = "hello") => {
    const r = await fetch(`${t.base}/api/uploads?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const send = (text: string, attachments: string[] = [], n = "A", conversationId?: string) => t.api("POST", `/api/bots/${bots[n].id}/messages`, { text, attachments, conversationId });
  const items = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];
  const list = async (q: Record<string, string> = {}) => (await t.api("GET", `/api/artifacts?${new URLSearchParams({ cwd, ...q })}`)).body;
  const idle = (id: string) => t.waitFor(async () => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation.status === "idle", "idle");
  const end = async () => {
    await t.waitFor(() => !t.store.db.prepare("SELECT 1 FROM conversations WHERE status='running'").get(), "rounds end");
    await new Promise((r) => setTimeout(r, 30));
    t.close();
  };
  return { t, cwd, made, bots, revealed, rt, waitRt, upload, send, items, list, idle, end };
}

test("an attachment reaches the agent as a readable path, and the person sees the file, not the path", async () => {
  const s = await setup();
  const u = await s.upload("数据 表.csv", "a,b\n1,2\n");
  assert.equal(u.status, 201);
  const id = (await s.send("看看", [u.body.id])).body.id;
  const a = await s.waitRt("A");
  const m = a.sent[0].match(/- (\.bot-attachments\/\S+ 表\.csv)/);
  assert.ok(m, a.sent[0]);
  assert.equal(readFileSync(join(s.cwd, m![1]), "utf8"), "a,b\n1,2\n", "the agent can read it from its directory");
  const user = (await s.items(id)).find((i) => i.type === "user");
  assert.deepEqual(user.data.attachments.map((x: any) => x.name), ["数据 表.csv"]);
  a.reply();
  await s.idle(id);
  await s.end();
});

test("an attachment is not counted as something the Bot changed, and never reaches a commit", async () => {
  const s = await setup();
  const u = await s.upload("data.txt");
  const id = (await s.send("看看", [u.body.id])).body.id;
  (await s.waitRt("A")).reply();
  await s.idle(id);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await s.items(id)).filter((i) => i.type === "result").length, 0);
  assert.equal(gitIn(s.cwd, "status", "--porcelain"), "");
  assert.match(readFileSync(join(s.cwd, ".git", "info", "exclude"), "utf8"), /\.bot-attachments\//);
  await s.end();
});

test("attachments work with no text, when queued, and when steering", async () => {
  const s = await setup();
  const first = await s.upload("one.txt");
  const id = (await s.send("", [first.body.id])).body.id;
  const a = await s.waitRt("A");
  assert.match(a.sent[0], /请看附件。/);
  assert.equal((await s.send("")).status, 400, "nothing at all is still refused");

  const steer = await s.upload("two.txt");
  assert.equal((await s.t.api("POST", `/api/conversations/${id}/followup`, { text: "加上这个", mode: "steer", attachments: [steer.body.id] })).body.delivered, "steered");
  assert.match(a.steered[0], /two\.txt/);

  const queue = await s.upload("three.txt");
  await s.t.api("POST", `/api/conversations/${id}/followup`, { text: "下一条", attachments: [queue.body.id] });
  a.reply();
  await s.waitRt("A", 2);
  assert.match(a.sent[1], /three\.txt/);
  assert.equal((await s.items(id)).filter((i) => i.data.attachments).length, 3);
  a.reply();
  await s.end();
});

test("uploads are checked: size, count, name, content type, and a file that is gone", async () => {
  const s = await setup();
  assert.equal((await fetch(`${s.t.base}/api/uploads?name=a`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status, 415);
  const evil = await s.upload("../../../etc/passwd");
  assert.equal(evil.body.name, "passwd");
  const row = s.t.store.db.prepare("SELECT path FROM artifacts WHERE id=?").get(evil.body.id) as any;
  assert.ok(row.path.startsWith(join(s.t.home, "uploads")), row.path);
  const dotted = await s.upload("....hidden");
  assert.equal(dotted.body.name, "hidden");
  const many = await Promise.all(Array.from({ length: 11 }, () => s.upload("x.txt")));
  assert.equal((await s.send("多", many.map((m) => m.body.id))).status, 400);
  assert.equal((await s.send("没有这个", ["nope"])).status, 400);
  assert.equal(s.made.length, 0, "nothing was sent to an agent");
  s.t.close();
});

test("a file nobody sent is cleaned up after a day; one that was sent stays", () => {
  const home = mkdtempSync(join(tmpdir(), "bot-home-"));
  const store = new Store(home);
  const a = new Artifacts(store);
  const old = a.upload("old.txt", Buffer.from("x"));
  const sent = a.upload("sent.txt", Buffer.from("y"));
  const fresh = a.upload("fresh.txt", Buffer.from("z"));
  const cwd = mkdtempSync(join(tmpdir(), "bot-cwd-"));
  const conv = "c1";
  a.attach(cwd, conv, [sent.id]);
  store.db.prepare("UPDATE artifacts SET created_at=created_at-200000000 WHERE id IN (?,?)").run(old.id, sent.id);
  new Artifacts(store);
  const ids = (store.db.prepare("SELECT id FROM artifacts").all() as any[]).map((r) => r.id).sort();
  assert.deepEqual(ids, [sent.id, fresh.id].sort());
  assert.equal(existsSync(join(home, "uploads", old.id)), false);
  store.close();
});

test("a round's changed files are listed with who made them, when a tool said so", async () => {
  const s = await setup();
  const id = (await s.send("改")).body.id;
  const a = await s.waitRt("A");
  a.emit({ type: "tool", key: "e", title: "写入 made.py", status: "running", files: [join(s.cwd, "made.py")] });
  writeFileSync(join(s.cwd, "made.py"), "x\n");
  a.emit({ type: "tool", key: "e", title: "", status: "done" });
  writeFileSync(join(s.cwd, "a.py"), "2\n");
  a.reply();
  await s.t.waitFor(async () => (await s.list()).artifacts.length === 2, "artifacts");
  const rows = (await s.list()).artifacts;
  const made = rows.find((r: any) => r.name === "made.py");
  const quiet = rows.find((r: any) => r.name === "a.py");
  assert.equal(made.origin, "A 改的");
  assert.equal(made.change, "新增");
  assert.match(quiet.origin, /没有工具上报/);
  assert.equal(quiet.change, "修改");
  assert.equal(made.conv_id, id);
  assert.ok((await s.items(id)).some((i) => i.id === made.item_id && i.type === "result"), "it leads back to the result");
  await s.end();
});

test("a task's file names the task, and the same file later points at the latest round", async () => {
  const s = await setup();
  const id = (await s.send("派")).body.id;
  const a = await s.waitRt("A");
  const bus = await fetch(`${s.t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${a.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool: "assign_task", args: { bot: "B", task: "写损失函数\n细节" } }) }).then((r) => r.json()) as any;
  const { task_id } = JSON.parse(bus.text);
  const b = await s.waitRt("B");
  b.emit({ type: "tool", key: "e", title: "写入", status: "running", files: ["loss.py"] });
  writeFileSync(join(s.cwd, "loss.py"), "x\n");
  b.reply("好了");
  await s.t.waitFor(async () => (await s.t.api("GET", "/api/tasks")).body.tasks.find((x: any) => x.id === task_id)?.status === "done", "task done");
  a.reply();
  await s.t.waitFor(async () => (await s.list()).artifacts.length === 1, "artifact");
  await s.idle(id);
  const first = (await s.list()).artifacts[0];
  assert.equal(first.origin, "B 的任务：写损失函数");

  await s.send("再改", [], "A", id);
  await s.waitRt("A", 2);
  writeFileSync(join(s.cwd, "loss.py"), "yy\n");
  a.reply();
  await s.t.waitFor(async () => (await s.list()).artifacts[0].item_id !== first.item_id, "latest round");
  const rows = (await s.list()).artifacts;
  assert.equal(rows.length, 1, "one line per file");
  assert.equal(rows[0].id, first.id, "the id stays, so an open link keeps working");
  await s.end();
});

test("the list says when a file has changed or gone, and can be narrowed", async () => {
  const s = await setup();
  const up = await s.upload("note.txt");
  const id = (await s.send("改", [up.body.id])).body.id;
  const a = await s.waitRt("A");
  writeFileSync(join(s.cwd, "x.py"), "1\n");
  writeFileSync(join(s.cwd, "y.py"), "1\n");
  a.reply();
  await s.t.waitFor(async () => (await s.list({ kind: "file" })).artifacts.length === 2, "artifacts");
  assert.deepEqual((await s.list({ kind: "attachment" })).artifacts.map((r: any) => r.name), ["note.txt"]);
  assert.equal((await s.list({ conv: "other" })).artifacts.length, 0);
  assert.equal((await s.list({ conv: id })).artifacts.length, 3);
  await new Promise((r) => setTimeout(r, 15));
  writeFileSync(join(s.cwd, "x.py"), "changed\n");
  rmSync(join(s.cwd, "y.py"));
  const rows = (await s.list()).artifacts;
  assert.equal(rows.find((r: any) => r.name === "x.py").state, "changed");
  const gone = rows.find((r: any) => r.name === "y.py");
  assert.deepEqual([gone.state, gone.preview], ["gone", "none"]);
  assert.equal((await fetch(`${s.t.base}/api/artifacts/${gone.id}/file`)).status, 404);
  await s.end();
});

test("only images and PDFs show in place; anything that could run is a download", async () => {
  const s = await setup();
  const id = (await s.send("改")).body.id;
  const a = await s.waitRt("A");
  writeFileSync(join(s.cwd, "pic.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(s.cwd, "page.html"), "<script>alert(1)</script>");
  writeFileSync(join(s.cwd, "draw.svg"), "<svg onload='alert(1)'/>");
  writeFileSync(join(s.cwd, "doc.pdf"), "%PDF");
  a.reply();
  await s.t.waitFor(async () => (await s.list()).artifacts.length === 4, "artifacts");
  await s.idle(id);
  const by = Object.fromEntries((await s.list()).artifacts.map((r: any) => [r.name, r]));
  const head = async (name: string, q = "") => {
    const r = await fetch(`${s.t.base}/api/artifacts/${by[name].id}/file${q}`);
    await r.arrayBuffer();
    return [r.headers.get("content-type"), r.headers.get("content-disposition")!.split(";")[0], r.headers.get("x-content-type-options")];
  };
  assert.deepEqual(await head("pic.png"), ["image/png", "inline", "nosniff"]);
  assert.deepEqual(await head("doc.pdf"), ["application/pdf", "inline", "nosniff"]);
  assert.deepEqual(await head("page.html"), ["application/octet-stream", "attachment", "nosniff"]);
  assert.deepEqual(await head("draw.svg"), ["application/octet-stream", "attachment", "nosniff"]);
  assert.deepEqual(await head("pic.png", "?download=1"), ["application/octet-stream", "attachment", "nosniff"]);
  assert.equal(by["page.html"].preview, "text", "shown as text, not as a page");
  assert.match((await s.t.api("GET", `/api/artifacts/${by["page.html"].id}/text`)).body.text, /script/);
  await s.end();
});

test("text preview refuses binary and huge files", async () => {
  const s = await setup();
  const id = (await s.send("改")).body.id;
  const a = await s.waitRt("A");
  writeFileSync(join(s.cwd, "bin.dat"), Buffer.from([1, 0, 2]));
  writeFileSync(join(s.cwd, "big.txt"), Buffer.alloc(2 * 1024 * 1024, 97));
  writeFileSync(join(s.cwd, "note.md"), "# 标题\n");
  a.reply();
  await s.t.waitFor(async () => (await s.list()).artifacts.length === 3, "artifacts");
  await s.idle(id);
  const by = Object.fromEntries((await s.list()).artifacts.map((r: any) => [r.name, r]));
  assert.equal((await s.t.api("GET", `/api/artifacts/${by["bin.dat"].id}/text`)).status, 415);
  assert.equal((await s.t.api("GET", `/api/artifacts/${by["big.txt"].id}/text`)).status, 413);
  assert.equal(by["big.txt"].preview, "none");
  assert.equal((await s.t.api("GET", `/api/artifacts/${by["note.md"].id}/text`)).body.markdown, true);
  await s.end();
});

test("a recorded path swapped for a link outside cannot be read or revealed", async () => {
  const s = await setup();
  const secret = join(mkdtempSync(join(tmpdir(), "bot-secret-")), "id_rsa");
  writeFileSync(secret, "SECRET");
  const id = (await s.send("改")).body.id;
  const a = await s.waitRt("A");
  writeFileSync(join(s.cwd, "out.txt"), "fine\n");
  a.reply();
  await s.t.waitFor(async () => (await s.list()).artifacts.length === 1, "artifact");
  await s.idle(id);
  const row = (await s.list()).artifacts[0];
  rmSync(join(s.cwd, "out.txt"));
  symlinkSync(secret, join(s.cwd, "out.txt"));
  assert.equal((await s.t.api("GET", `/api/artifacts/${row.id}/text`)).status, 403);
  assert.equal((await fetch(`${s.t.base}/api/artifacts/${row.id}/file`)).status, 403);
  assert.equal((await s.t.api("POST", `/api/artifacts/${row.id}/reveal`, {})).status, 403);
  assert.deepEqual(s.revealed, []);
  await s.end();
});

test("revealing takes only a recorded file's id, never a path", async () => {
  const s = await setup();
  const id = (await s.send("改")).body.id;
  const a = await s.waitRt("A");
  writeFileSync(join(s.cwd, "out.txt"), "fine\n");
  a.reply();
  await s.t.waitFor(async () => (await s.list()).artifacts.length === 1, "artifact");
  await s.idle(id);
  const { artifacts: [row], can_reveal } = await s.list();
  assert.equal(can_reveal, true);
  assert.equal((await s.t.api("POST", `/api/artifacts/${row.id}/reveal`, { path: "/etc/passwd" })).status, 200);
  assert.equal(s.revealed.length, 1);
  assert.match(s.revealed[0], /out\.txt$/);
  assert.equal((await s.t.api("POST", "/api/artifacts/nope/reveal", {})).status, 404);
  await s.end();
});

test("a file a tool reports outside the project is not offered, and neither is the test set", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bot-plain-"));
  const s = await setup(cwd);
  const outside = join(mkdtempSync(join(tmpdir(), "bot-out-")), "x.txt");
  writeFileSync(outside, "x");
  writeFileSync(join(cwd, "inside.txt"), "y");
  const id = (await s.send("改")).body.id;
  const a = await s.waitRt("A");
  a.emit({ type: "tool", key: "e", title: "写", status: "running", files: [outside, "inside.txt"] });
  a.emit({ type: "tool", key: "e", title: "", status: "done" });
  a.reply();
  await s.t.waitFor(async () => (await s.list()).artifacts.length > 0, "artifact");
  assert.deepEqual((await s.list()).artifacts.map((r: any) => r.name), ["inside.txt"]);
  await s.idle(id);
  s.t.close();

  const r = repo();
  const t = await setup(r);
  await t.t.api("PUT", `/api/projects/${Memory.projectId(r)}/settings`, { test_dir: join(r, "held") });
  const conv = (await t.send("改")).body.id;
  const f = await t.waitRt("A");
  mkdirSync(join(r, "held"));
  writeFileSync(join(r, "held", "labels.txt"), "S");
  writeFileSync(join(r, "ok.py"), "x");
  f.reply();
  await t.t.waitFor(async () => (await t.list()).artifacts.length > 0, "artifact");
  assert.deepEqual((await t.list()).artifacts.map((x: any) => x.name), ["ok.py"]);
  await t.idle(conv);
  await t.end();
});

test("moving the data folder keeps attachments reachable", () => {
  const base = mkdtempSync(join(tmpdir(), "bot-move-"));
  const oldHome = join(base, "old", ".data");
  mkdirSync(oldHome, { recursive: true });
  const s1 = new Store(oldHome);
  const a1 = new Artifacts(s1);
  const up = a1.upload("keep.txt", Buffer.from("x"));
  s1.close();
  const newHome = join(base, "new", ".data");
  mkdirSync(join(base, "new"), { recursive: true });
  execFileSync("cp", ["-R", oldHome, newHome]);
  const s2 = new Store(newHome);
  const a2 = new Artifacts(s2);
  assert.equal(a2.text(up.id).text, "x");
  assert.ok(statSync((s2.db.prepare("SELECT path FROM artifacts WHERE id=?").get(up.id) as any).path).isFile());
  s2.close();
});
