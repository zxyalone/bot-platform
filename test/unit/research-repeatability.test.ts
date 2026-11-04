import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../helpers.ts";
import { Memory } from "../../src/daemon/git.ts";
import { summarize } from "../../src/daemon/research.ts";
import type { AgentEvent, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

const TRAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake_train.mjs");
const train = `"${process.execPath}" "${TRAIN}"`;

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

async function setup(cwd = mkdtempSync(join(tmpdir(), "bot-proj-"))) {
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  });
  const bot = (await t.api("POST", "/api/bots", { name: "A", role: "ROLE-A", agent: "codex", model: "gpt-6-luna", cwd })).body;
  const pid = Memory.projectId(cwd);
  await t.api("PUT", `/api/projects/${pid}/settings`, { enabled: true });
  const bus = (f: Fake, tool: string, args: unknown) =>
    fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  const items = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];
  const research = async () => (await t.api("GET", `/api/projects/${pid}/research`)).body;
  const experiment = async (id: string) => (await research()).experiments.find((e: any) => e.id === id);
  const run = async (conv: string, f: Fake, args: unknown) => {
    const p = bus(f, "run_experiment", args);
    const card: any = await t.waitFor(async () => (await items(conv)).find((i) => i.data.kind === "job_request" && i.status === "pending"), "job card");
    await t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" });
    const r = await p;
    assert.equal(r.isError, false, r.text);
    return JSON.parse(r.text).experiment_id as string;
  };
  const finished = (id: string) => t.waitFor(async () => {
    const e = await experiment(id);
    return e && e.status !== "running" && e;
  }, "experiment end", 10000) as Promise<any>;
  const talk = async () => {
    const conv = (await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "做" })).body.id as string;
    await t.waitFor(() => made.at(-1)?.sent.length, "agent");
    return { conv, f: made.at(-1)! };
  };
  return { t, made, bot, pid, cwd, bus, items, research, experiment, run, finished, talk };
}

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "bot-repo-"));
  gitIn(cwd, "init", "-q");
  writeFileSync(join(cwd, "model.py"), "lr = 1\n");
  writeFileSync(join(cwd, ".gitignore"), "data/\n");
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-qm", "first");
  return cwd;
}

// ---------- repeated final evaluation ----------
test("a repeated final evaluation waits for its own process and keeps its own metrics", async () => {
  const s = await setup();
  const flag = join(s.cwd, "evaluated-once");
  const cmd = `if [ -f "${flag}" ]; then sleep 0.5; echo '{"test_dice":0.9}' > "$BOT_METRICS_FILE"; else touch "${flag}"; echo '{"test_dice":0.1}' > "$BOT_METRICS_FILE"; fi`;
  await s.t.api("PUT", `/api/projects/${s.pid}/settings`, { test_dir: "/data/test", final_eval_command: cmd });
  const { conv, f } = await s.talk();
  const id = await s.run(conv, f, { name: "m", command: train });
  await s.finished(id);
  const settled = () => s.t.waitFor(async () => {
    const e = await s.experiment(id);
    return e.final_status !== "running" && e;
  }, "final eval", 5000) as Promise<any>;

  assert.equal((await s.t.api("POST", `/api/experiments/${id}/final-eval`, {})).status, 202);
  assert.equal((await settled()).test_metrics.test_dice, 0.1);

  assert.equal((await s.t.api("POST", `/api/experiments/${id}/final-eval`, {})).status, 202);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await s.experiment(id)).final_status, "running", "the first evaluation's exit file must not end this one");
  const second = await settled();
  assert.equal(second.final_status, "done");
  assert.equal(second.test_metrics.test_dice, 0.9, "the new result, not the old one");

  const dirs = s.t.store.db.prepare("SELECT dir FROM jobs WHERE experiment_id=? AND kind='final'").all(id) as any[];
  assert.equal(new Set(dirs.map((d) => d.dir)).size, 2, "each evaluation has its own record");
  assert.deepEqual(dirs.map((d) => JSON.parse(readFileSync(join(d.dir, "metrics.json"), "utf8")).test_dice).sort(), [0.1, 0.9], "both results are kept");
  assert.equal((await s.research()).finalEvals, 2);
  s.t.close();
});

test("two simultaneous final-evaluation clicks start only one process", async () => {
  const s = await setup();
  await s.t.api("PUT", `/api/projects/${s.pid}/settings`, { test_dir: "/data/test", final_eval_command: `${train} --final` });
  const { conv, f } = await s.talk();
  const id = await s.run(conv, f, { name: "m", command: train });
  await s.finished(id);
  const codes = await Promise.all([1, 2, 3].map(() => s.t.api("POST", `/api/experiments/${id}/final-eval`, {}).then((r) => r.status)));
  assert.deepEqual(codes.sort(), [202, 409, 409]);
  assert.equal((await s.research()).finalEvals, 1);
  s.t.close();
});

test("a final evaluation that cannot start does not stay running", async () => {
  const s = await setup();
  await s.t.api("PUT", `/api/projects/${s.pid}/settings`, { test_dir: "/data/test", final_eval_command: `${train} --final` });
  const { conv, f } = await s.talk();
  const id = await s.run(conv, f, { name: "m", command: train });
  await s.finished(id);
  s.t.store.db.prepare("UPDATE experiments SET target='gone' WHERE id=?").run(id);
  assert.equal((await s.t.api("POST", `/api/experiments/${id}/final-eval`, {})).status, 500);
  assert.equal((await s.experiment(id)).final_status, null);
  s.t.close();
});

// ---------- waking a group ----------
test("a group woken by a finished experiment is told the result, and so is a member who speaks later", async () => {
  const s = await setup();
  const other = (await s.t.api("POST", "/api/bots", { name: "B", role: "ROLE-B", agent: "codex", model: "gpt-6-luna", cwd: s.cwd })).body;
  const g = (await s.t.api("POST", "/api/groups", { name: "g", members: [s.bot.id, other.id], cwd: s.cwd })).body;
  const conv = (await s.t.api("POST", `/api/groups/${g.id}/messages`, { text: "@A 做" })).body.id as string;
  await s.t.waitFor(() => s.made[0]?.sent.length, "A starts");
  const a = s.made[0];
  const id = await s.run(conv, a, { name: "实验甲", command: train, seed: 3 });
  a.reply("提交了");
  await s.finished(id);
  await s.t.waitFor(() => a.sent.length === 2, "wake");
  assert.match(a.sent[1], /实验甲/);
  assert.match(a.sent[1], /"dice":0\.729/);
  assert.match(a.sent[1], /平台通知/);
  assert.match(a.sent[1], /决定下一步/);
  a.reply("看到了");
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.conversation.status === "idle", "idle");
  assert.equal((await s.items(conv)).filter((i) => i.type === "notice").length, 1, "one line in the transcript");

  await s.t.api("POST", `/api/groups/${g.id}/messages`, { text: "@B 怎么看", conversationId: conv });
  await s.t.waitFor(() => s.made[1]?.sent.length, "B starts");
  assert.equal(s.made[1].sent[0].match(/实验甲/g)?.length, 1, "B hears about it once");
  s.t.close();
});

test("a group with waking turned off still hears about the result at its next message", async () => {
  const s = await setup();
  await s.t.api("PUT", `/api/projects/${s.pid}/settings`, { auto_wake: false });
  const other = (await s.t.api("POST", "/api/bots", { name: "B", role: "ROLE-B", agent: "codex", model: "gpt-6-luna", cwd: s.cwd })).body;
  const g = (await s.t.api("POST", "/api/groups", { name: "g", members: [s.bot.id, other.id], cwd: s.cwd })).body;
  const conv = (await s.t.api("POST", `/api/groups/${g.id}/messages`, { text: "@A 做" })).body.id as string;
  await s.t.waitFor(() => s.made[0]?.sent.length, "A starts");
  const a = s.made[0];
  const id = await s.run(conv, a, { name: "实验乙", command: train });
  a.reply("提交了");
  await s.finished(id);
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.conversation.status === "idle", "idle");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(a.sent.length, 1, "nobody was woken");
  await s.t.api("POST", `/api/groups/${g.id}/messages`, { text: "@A 结果呢", conversationId: conv });
  await s.t.waitFor(() => a.sent.length === 2, "next message");
  assert.match(a.sent[1], /实验乙/);
  s.t.close();
});

// ---------- code snapshot ----------
test("the code snapshot includes new files and can rebuild the code that ran", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "model.py"), "lr = 2\n");
  mkdirSync(join(cwd, "sub dir"));
  writeFileSync(join(cwd, "sub dir", "train.py"), "print('new')\n");
  writeFileSync(join(cwd, "weights.bin"), Buffer.from([0, 1, 2, 255]));
  mkdirSync(join(cwd, "data"));
  writeFileSync(join(cwd, "data", "ignored.txt"), "dataset");
  writeFileSync(join(cwd, "huge.bin"), Buffer.alloc(6 * 1024 * 1024, 7));
  const before = gitIn(cwd, "status", "--porcelain");
  const s = await setup(cwd);
  const { conv, f } = await s.talk();
  const id = await s.run(conv, f, { name: "m", command: train });
  const e = await s.finished(id);
  assert.equal(e.dirty, 1);
  assert.equal(gitIn(cwd, "status", "--porcelain"), before, "the user's index is untouched");

  const run = join(s.t.home, "runs", id);
  const copy = mkdtempSync(join(tmpdir(), "bot-copy-"));
  execFileSync("git", ["clone", "-q", cwd, copy]);
  gitIn(copy, "apply", join(run, "code.diff"));
  assert.equal(readFileSync(join(copy, "model.py"), "utf8"), "lr = 2\n");
  assert.equal(readFileSync(join(copy, "sub dir", "train.py"), "utf8"), "print('new')\n");
  assert.deepEqual([...readFileSync(join(copy, "weights.bin"))], [0, 1, 2, 255]);
  assert.equal(existsSync(join(copy, "data", "ignored.txt")), false);
  assert.equal(existsSync(join(copy, "huge.bin")), false, "too big to copy");

  const info = JSON.parse(readFileSync(join(run, "code.json"), "utf8"));
  assert.equal(info.complete, false, "a file was left out, and that is said plainly");
  assert.equal(e.code_complete, 0);
  const huge = info.files.find((x: any) => x.path === "huge.bin");
  assert.deepEqual([huge.included, huge.size], [false, 6 * 1024 * 1024]);
  assert.match(huge.sha256, /^[0-9a-f]{64}$/);
  assert.match(info.files.find((x: any) => x.path === "sub dir/train.py").sha256, /^[0-9a-f]{64}$/);
  s.t.close();
});

test("the same uncommitted code has the same version; changing it, or a clean tree, gives another", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "new.py"), "a\n");
  const s = await setup(cwd);
  const { conv, f } = await s.talk();
  const go = async (seed: number) => s.finished(await s.run(conv, f, { name: "m", command: train, seed }));
  const a = await go(1);
  const b = await go(2);
  assert.equal(a.code_complete, 1);
  assert.equal(a.code_hash, b.code_hash);
  writeFileSync(join(cwd, "new.py"), "b\n");
  const c = await go(3);
  assert.notEqual(c.code_hash, a.code_hash, "a new file's content counts");
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-qm", "second");
  const d = await go(4);
  assert.deepEqual([d.dirty, d.code_hash, d.code_complete], [0, d.commit_hash, 1]);
  assert.equal(existsSync(join(s.t.home, "runs", d.id, "code.diff")), false);
  s.t.close();
});

test("the test set is not copied into the snapshot, even when it sits inside the repository", async () => {
  const cwd = repo();
  mkdirSync(join(cwd, "test_set"));
  writeFileSync(join(cwd, "test_set", "answers.txt"), "SECRET-LABELS\n");
  writeFileSync(join(cwd, "new.py"), "a\n");
  const s = await setup(cwd);
  await s.t.api("PUT", `/api/projects/${s.pid}/settings`, { test_dir: join(cwd, "test_set") });
  const { conv, f } = await s.talk();
  const id = await s.run(conv, f, { name: "m", command: train });
  await s.finished(id);
  const diff = readFileSync(join(s.t.home, "runs", id, "code.diff"), "utf8");
  assert.match(diff, /new\.py/);
  assert.doesNotMatch(diff, /SECRET-LABELS|answers/);
  s.t.close();
});

// ---------- summaries ----------
const row = (o: Record<string, unknown>) => ({ id: `r${Math.random()}`, status: "done", name: "m", role: "variant", idea_id: null, command: "train", config: { lr: 1 }, seed: 1, commit_hash: "c1", dirty: 0, code_hash: "c1", code_complete: 1, metrics: { dice: 0.5 }, ...o });

test("runs with a different config, command or code version are not averaged together", () => {
  const groups = summarize([row({ seed: 1 }), row({ seed: 2, metrics: { dice: 0.7 } }), row({ config: { lr: 2 } }), row({ command: "train --lr 9" }), row({ commit_hash: "c2", code_hash: "c2" }), row({ dirty: 1, code_hash: "abc" }), row({ name: "other" })]);
  assert.equal(groups.length, 6);
  assert.equal(groups[0].metrics.dice.n, 2);
  assert.ok(Math.abs(groups[0].metrics.dice.mean - 0.6) < 1e-9);
  assert.deepEqual(groups[1].config, { lr: 2 }, "so the two can be told apart");
  assert.equal(new Set(groups.map((g) => g.group)).size, 6);
});

test("key order in a config does not split a group", () => {
  const groups = summarize([row({ config: { a: 1, b: { c: 2, d: 3 } }, seed: 1 }), row({ config: { b: { d: 3, c: 2 }, a: 1 }, seed: 2 })]);
  assert.equal(groups.length, 1);
});

test("repeating a seed does not add a sample; the repeats are averaged and counted", () => {
  const [g] = summarize([row({ seed: 1, metrics: { dice: 0.4 } }), row({ seed: 1, metrics: { dice: 0.6 } }), row({ seed: 2, metrics: { dice: 0.9 } })]);
  assert.deepEqual([g.runs, g.seeds, g.metrics.dice.n], [3, 2, 2]);
  assert.ok(Math.abs(g.metrics.dice.mean - 0.7) < 1e-9, "mean of 0.5 (seed 1) and 0.9 (seed 2)");
});

test("runs with no seed each count once, and unverifiable uncommitted code is never merged", () => {
  const [g] = summarize([row({ seed: null }), row({ seed: null })]);
  assert.deepEqual([g.seeds, g.metrics.dice.n], [2, 2]);
  const old = summarize([row({ dirty: 1, code_hash: null, seed: 1 }), row({ dirty: 1, code_hash: null, seed: 2 })]);
  assert.equal(old.length, 2, "records from before versions were fingerprinted cannot be shown to match");
  const noGit = summarize([row({ commit_hash: null, code_hash: null, seed: 1 }), row({ commit_hash: null, code_hash: null, seed: 2 })]);
  assert.equal(noGit.length, 1, "a folder without Git has no version to compare");
});
