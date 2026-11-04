import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, tempHome } from "../helpers.ts";
import { normalizeCodex, normalizeMagpie, readQuotas } from "../../src/daemon/quota.ts";
import { Memory } from "../../src/daemon/git.ts";
import { ensureSeedBots, Store } from "../../src/daemon/store.ts";
import type { AgentEvent, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

const TRAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake_train.mjs");
const train = (flags = "") => `"${process.execPath}" "${TRAIN}" ${flags}`;

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

async function setup(opts: { enable?: boolean; home?: string; existingBot?: string } = {}) {
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  }, { home: opts.home });
  const cwd = mkdtempSync(join(tmpdir(), "bot-proj-"));
  const bot = opts.existingBot ? (await t.api("GET", "/api/state")).body.bots[0] : (await t.api("POST", "/api/bots", { name: "A", role: "ROLE-A", agent: "codex", model: "gpt-6-luna", cwd })).body;
  const pid = Memory.projectId(bot.cwd);
  if (opts.enable !== false) await t.api("PUT", `/api/projects/${pid}/settings`, { enabled: true });
  const start = async () => {
    const before = made.length;
    const conv = (await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "做" })).body.id as string;
    await t.waitFor(() => made.length > before && made.at(-1)!.sent.length, "agent");
    return { conv, f: made.at(-1)! };
  };
  const bus = (f: Fake, tool: string, args: unknown) =>
    fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()).catch(() => ({ text: "closed", isError: true })) as Promise<{ text: string; isError: boolean }>;
  const items = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];
  const research = async () => (await t.api("GET", `/api/projects/${pid}/research`)).body;
  const experiment = async (id: string) => (await research()).experiments.find((e: any) => e.id === id);
  // Submits, approves, and returns the experiment id.
  const run = async (conv: string, f: Fake, args: unknown) => {
    const p = bus(f, "run_experiment", args);
    const seen = new Set((await items(conv)).filter((i) => i.type === "approval").map((i) => i.id));
    const card: any = await t.waitFor(async () => (await items(conv)).find((i) => i.data.kind === "job_request" && i.status === "pending" && !seen.has(i.id)) ?? (await items(conv)).find((i) => i.data.kind === "job_request" && i.status === "pending"), "job card");
    await t.api("POST", `/api/approvals/${card.id}`, { decision: "allow" });
    const r = await p;
    assert.equal(r.isError, false, r.text);
    return JSON.parse(r.text).experiment_id as string;
  };
  const finished = (id: string) => t.waitFor(async () => {
    const e = await experiment(id);
    return e && e.status !== "running" && e;
  }, "experiment end", 10000) as Promise<any>;
  return { t, made, bot, pid, start, bus, items, research, experiment, run, finished, cwd: bot.cwd };
}

test("the experiment module is off by default: no tools, no extra cost, and the bus refuses", async () => {
  const s = await setup({ enable: false });
  const { f } = await s.start();
  assert.doesNotMatch(f.opts.bus!.env.BUS_TOOLS, /run_experiment|add_idea/);
  assert.match((await s.bus(f, "add_idea", { title: "x" })).text, /没有开启/);
  assert.match((await s.bus(f, "run_experiment", { name: "x", command: "true" })).text, /没有开启/);
  s.t.close();
});

test("turning the module on adds the tools at the next message", async () => {
  const s = await setup({ enable: false });
  const { conv, f } = await s.start();
  f.reply();
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.conversation.status === "idle", "idle");
  await s.t.api("PUT", `/api/projects/${s.pid}/settings`, { enabled: true });
  await s.t.api("POST", `/api/bots/${s.bot.id}/messages`, { text: "再来", conversationId: conv });
  await s.t.waitFor(() => s.made.length === 2, "restart");
  assert.match(s.made[1].opts.bus!.env.BUS_TOOLS, /run_experiment/);
  s.t.close();
});

test("an experiment needs approval, records what it ran, reads metrics from the script, and wakes the conversation", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  const id = await s.run(conv, f, { name: "baseline", command: train(), seed: 3, role: "baseline", config: { shift: 0.1 } });
  f.reply("提交了");
  const e = await s.finished(id);
  assert.equal(e.status, "done");
  assert.equal(e.seed, 3);
  assert.deepEqual(e.config, { shift: 0.1 });
  assert.equal(e.metrics.dice, 0.809, "from the file the script wrote");
  assert.equal(e.metrics.note, undefined, "non-numeric values are dropped");
  assert.match(readFileSync(join(s.t.home, "runs", id, "log.txt"), "utf8"), /seed=3 config=\{"shift":0.1\}/);

  await s.t.waitFor(() => f.sent.length === 2, "wake");
  assert.match(f.sent[1], /平台通知/);
  assert.match(f.sent[1], /"dice":0\.809/);
  const job = (await s.items(conv)).find((i) => i.type === "job");
  assert.equal(job.status, "done");
  s.t.close();
});

test("denying the experiment runs nothing; a wake during a busy turn waits for it to end", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  const p = s.bus(f, "run_experiment", { name: "x", command: `touch "${join(s.cwd, "ran.txt")}"` });
  const card: any = await s.t.waitFor(async () => (await s.items(conv)).find((i) => i.data.kind === "job_request"), "card");
  assert.match(card.data.detail, /touch/);
  await s.t.api("POST", `/api/approvals/${card.id}`, { decision: "deny" });
  assert.match((await p).text, /拒绝/);
  assert.equal(existsSync(join(s.cwd, "ran.txt")), false);
  assert.equal((await s.research()).experiments.length, 0);

  const id = await s.run(conv, f, { name: "fast", command: train() });
  await s.finished(id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(f.sent.length, 1, "no second message while the turn is still open");
  f.reply();
  await s.t.waitFor(() => f.sent.length === 2, "queued wake runs");
  s.t.close();
});

test("a failed run reports its log; a script with no metrics is shown as having none", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  const id = await s.run(conv, f, { name: "oom", command: train("--fail") });
  f.reply();
  assert.equal((await s.finished(id)).status, "failed");
  await s.t.waitFor(() => f.sent.length === 2, "wake");
  assert.match(f.sent[1], /CUDA out of memory/);
  f.reply();
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.conversation.status === "idle", "idle");
  s.t.close();
});

test("cancel stops the process and does not wake anyone", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  const id = await s.run(conv, f, { name: "long", command: train("--sleep 60") });
  f.reply();
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.conversation.status === "idle", "idle");
  assert.equal((await s.t.api("POST", `/api/experiments/${id}/cancel`, {})).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await s.experiment(id)).status, "cancelled");
  assert.equal(f.sent.length, 1);
  assert.equal((await s.t.api("POST", `/api/experiments/${id}/cancel`, {})).status, 409);
  s.t.close();
});

test("a run survives a daemon restart and is picked up afterwards; a vanished one is marked lost", async () => {
  const home = tempHome();
  const a = await setup({ home });
  const { conv, f } = await a.start();
  const id = await a.run(conv, f, { name: "keeps-going", command: train("--sleep 0.5") });
  const gone = await a.run(conv, f, { name: "vanishes", command: "sleep 60" });
  const row = a.t.store.db.prepare("SELECT pid FROM jobs WHERE experiment_id=?").get(gone) as any;
  a.t.close();
  process.kill(-row.pid, "SIGKILL");

  const b = await setup({ home, existingBot: "yes" });
  const e = await b.finished(id);
  assert.equal(e.status, "done");
  assert.ok(e.metrics.dice > 0);
  assert.equal((await b.finished(gone)).status, "lost");
  b.t.close();
});

test("test-set gate: Bots cannot reach it, only the user can run it, and results never reach Bots", async () => {
  const s = await setup();
  await s.t.api("PUT", `/api/projects/${s.pid}/settings`, { test_dir: "/data/test", final_eval_command: train("--final") });
  const { conv, f } = await s.start();
  assert.match((await s.bus(f, "run_experiment", { name: "peek", command: "python eval.py /data/test" })).text, /测试集/);
  assert.match((await s.bus(f, "run_experiment", { name: "peek", command: "python x.py", config: { path: "/data/test/a" } })).text, /测试集/);
  assert.equal((await s.bus(f, "final_eval", {})).isError, true, "no agent tool for it");

  const id = await s.run(conv, f, { name: "m", command: train(), seed: 1 });
  await s.finished(id);
  assert.equal((await s.t.api("POST", `/api/experiments/${id}/final-eval`, {})).status, 202);
  const e: any = await s.t.waitFor(async () => {
    const x = await s.experiment(id);
    return x.final_status === "done" && x;
  }, "final eval");
  assert.equal(e.test_metrics.saw_test_dir, undefined, "only numbers are kept");
  assert.ok(e.test_metrics.test_dice > 0, "the user sees it");
  assert.equal((await s.research()).finalEvals, 1, "each look is counted");

  for (const text of [(await s.bus(f, "get_experiment", { id })).text, (await s.bus(f, "list_experiments", {})).text]) assert.doesNotMatch(text, /test_dice|test_metrics|final_status/);
  assert.equal(f.sent.length, 1, "a final evaluation wakes nobody");
  s.t.close();
});

test("ideas: similar ones are surfaced, Bots can only suggest a verdict, the user decides", async () => {
  const s = await setup();
  const { f } = await s.start();
  const first = JSON.parse((await s.bus(f, "add_idea", { title: "边界感知损失函数", hypothesis: "细小结构 Dice 提升" })).text);
  assert.deepEqual(first.similar, []);
  await s.bus(f, "update_idea", { id: first.id, failure_reason: "类别不平衡时失效" });
  const second = JSON.parse((await s.bus(f, "add_idea", { title: "边界感知的损失函数" })).text);
  assert.equal(second.similar[0].id, first.id);
  assert.equal(second.similar[0].failure_reason, "类别不平衡时失效", "so the same failure is not repeated");

  assert.match((await s.bus(f, "update_idea", { id: first.id, status: "supported" })).text, /用户确认/);
  await s.bus(f, "update_idea", { id: first.id, suggested_verdict: "not_supported", conclusion: "没有提升" });
  let idea = (await s.research()).ideas.find((i: any) => i.id === first.id);
  assert.deepEqual([idea.status, idea.suggested_verdict], ["proposed", "not_supported"]);
  await s.t.api("PATCH", `/api/ideas/${first.id}`, { status: "not_supported" });
  idea = (await s.research()).ideas.find((i: any) => i.id === first.id);
  assert.deepEqual([idea.status, idea.suggested_verdict], ["not_supported", null]);
  s.t.close();
});

test("runs of the same name are summarized across seeds, and starting one marks its idea as testing", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  const idea = JSON.parse((await s.bus(f, "add_idea", { title: "新模块" })).text).id;
  const a = await s.run(conv, f, { name: "m", command: train(), seed: 0, idea_id: idea, config: { shift: 0 } });
  const b = await s.run(conv, f, { name: "m", command: train(), seed: 10, idea_id: idea, config: { shift: 0 } });
  await s.finished(a);
  await s.finished(b);
  const r = await s.research();
  assert.equal(r.ideas[0].status, "testing");
  const m = r.summary[0].metrics.dice;
  assert.equal(m.n, 2);
  assert.ok(Math.abs(m.mean - 0.715) < 1e-9);
  assert.ok(m.std > 0);
  assert.match((await s.bus(f, "run_experiment", { name: "m", command: "x", idea_id: "nope" })).text, /没有想法/);
  assert.match((await s.bus(f, "run_experiment", { name: "m", command: "x", target: "nope" })).text, /没有计算目标/);
  s.t.close();
});

test("result files are served only from that run's artifacts, and only as images", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  const id = await s.run(conv, f, { name: "viz", command: train() });
  await s.finished(id);
  const cases = (await s.t.api("GET", `/api/experiments/${id}/manifest`)).body.cases;
  assert.equal(cases.length, 4);
  const get = (p: string) => fetch(`${s.t.base}/api/experiments/${id}/file?path=${encodeURIComponent(p)}`);
  const ok = await get(cases[0].pred);
  assert.equal(ok.headers.get("content-type"), "image/png");
  await ok.arrayBuffer();
  const art = join(s.t.home, "runs", id, "artifacts");
  writeFileSync(join(s.t.home, "secret.png"), "x");
  symlinkSync(join(s.t.home, "secret.png"), join(art, "link.png"));
  for (const [p, code] of [["../../../secret.png", 403], ["link.png", 403], ["manifest.json", 415], ["missing.png", 404]] as const) {
    const r = await get(p);
    assert.equal(r.status, code, p);
    await r.arrayBuffer();
  }
  assert.equal((await s.t.api("GET", "/api/experiments/..%2f..%2fx/log")).status, 400);
  s.t.close();
});

test("a worktree with a running experiment cannot be merged or discarded", async () => {
  const s = await setup();
  const { conv, f } = await s.start();
  const id = await s.run(conv, f, { name: "long", command: train("--sleep 60") });
  f.reply();
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${conv}/items`)).body.conversation.status === "idle", "idle");
  s.t.store.addWorktree({ id: "wt1", rootConvId: conv, repoRoot: s.cwd, baseBranch: "main", baseCommit: "0", branch: "b", path: s.cwd, botName: "A" });
  const r = await s.t.api("POST", "/api/worktrees/wt1/discard", {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /实验/);
  await s.t.api("POST", `/api/experiments/${id}/cancel`, {});
  s.t.close();
});

test("SSH target: code goes over, the run happens there, and results come back", async () => {
  const bin = mkdtempSync(join(tmpdir(), "bot-fakebin-"));
  const remote = mkdtempSync(join(tmpdir(), "bot-remote-"));
  // Stand-ins that run "remote" commands locally, so the whole path is exercised without a server.
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nshift\nexec sh -c "$*"\n`);
  writeFileSync(join(bin, "rsync"), `#!/bin/sh\nargs=""\nfor a in "$@"; do a=$(printf '%s' "$a" | sed 's/^gpu1://'); args="$args '$a'"; done\neval exec /usr/bin/rsync $args\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  chmodSync(join(bin, "rsync"), 0o755);
  process.env.BOT_SSH = join(bin, "ssh");
  process.env.BOT_RSYNC = join(bin, "rsync");
  try {
    const s = await setup();
    assert.equal((await s.t.api("POST", "/api/targets", { name: "x", ssh_host: "-oProxyCommand=evil", remote_root: "/tmp/a" })).status, 400, "a host cannot pose as an option");
    assert.equal((await s.t.api("POST", "/api/targets", { name: "x", ssh_host: "h", remote_root: "/tmp/a b;rm" })).status, 400);
    assert.equal((await s.t.api("POST", "/api/targets", { name: "local", ssh_host: "h", remote_root: "/tmp/a" })).status, 400);
    assert.equal((await s.t.api("POST", "/api/targets", { name: "gpu1", ssh_host: "gpu1", remote_root: remote, setup: "export SETUP_RAN=yes" })).status, 201);

    writeFileSync(join(s.cwd, "train.sh"), `echo "setup=$SETUP_RAN"\n${train()}\n`);
    writeFileSync(join(s.cwd, ".gitignore"), "data/\n");
    const { conv, f } = await s.start();
    const id = await s.run(conv, f, { name: "remote", command: "sh train.sh", target: "gpu1", seed: 2 });
    f.reply();
    const e = await s.finished(id);
    assert.equal(e.status, "done", s.t.store.db.prepare("SELECT * FROM jobs").all().length ? "" : "no job");
    assert.equal(e.metrics.dice, 0.726);
    assert.ok(existsSync(join(remote, "runs", id, "code", "train.sh")), "code was copied over");
    assert.equal(existsSync(join(remote, "runs", id, "code", ".git")), false);
    assert.match(readFileSync(join(s.t.home, "runs", id, "log.txt"), "utf8"), /setup=yes/);
    assert.equal((await s.t.api("GET", `/api/experiments/${id}/manifest`)).body.cases.length, 4, "artifacts came back");
    s.t.close();
  } finally {
    delete process.env.BOT_SSH;
    delete process.env.BOT_RSYNC;
  }
});

// ---------- quota ----------
const MAGPIE = [
  { provider: "claude", name: "someone@example.com", kind: "subscription", plan: "pro", user: "someone@example.com", windows: [{ name: "5 小时", used: 10, remaining: 90, resetsAt: "2026-11-05T04:40:00+08:00" }, { name: "每周", used: 13, remaining: 87, resetsAt: "2026-11-08T00:00:00+08:00" }] },
  { provider: "grok", user: "g@example.com", kind: "subscription", windows: [{ name: "w", remaining: 78 }] },
  { provider: "grok", user: "g@example.com", kind: "subscription", windows: [{ name: "w", remaining: 78 }] },
  { provider: "codex", user: "c@example.com", kind: "subscription", plan: "plus", windows: [{ name: "每周", remaining: 95, holds: { cost: 0.4 } }], resets: { each: [{ id: "secret-credit-id" }] } },
  { provider: "antigravity", user: "a@example.com", kind: "subscription", windows: [{ name: "m", remaining: 93, pool: "Argon" }, { name: "m", remaining: 93, pool: "Argon" }, { name: "m", remaining: 99, pool: "Gemini" }] },
  { provider: "deepseek", kind: "key", windows: [{ name: "x", remaining: 1 }] },
  { provider: "broken", kind: "subscription", windows: [] },
];

test("quota data keeps what a person needs and drops identifiers and duplicates", () => {
  const out = normalizeMagpie(MAGPIE);
  assert.deepEqual(out.map((a) => a.provider), ["claude", "grok", "codex", "antigravity"]);
  assert.equal(out[0].account, "som***@example.com");
  assert.equal(out[3].windows.length, 2, "identical windows are merged");
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /secret-credit-id|someone@|holds|cost/);
  assert.deepEqual(normalizeMagpie("nope"), []);
  assert.deepEqual(normalizeMagpie({ data: MAGPIE }), out, "the gateway wraps the same list");
});

test("Codex's official rate limits are understood", () => {
  const [a] = normalizeCodex({ rateLimits: { planType: "plus", primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1793825583 }, secondary: { usedPercent: 5, windowDurationMins: 10080 } } });
  assert.equal(a.plan, "plus");
  assert.deepEqual(a.windows.map((w) => [w.name, w.remaining]), [["5 小时", 90], ["每周", 95]]);
  assert.deepEqual(normalizeCodex({}), []);
});

test("quota falls back from Magpie to Codex to an honest message", async () => {
  const server = http.createServer((_, res) => res.end(JSON.stringify(MAGPIE)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/q`;
  const codex = async () => normalizeCodex({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 } } });
  assert.equal((await readQuotas({ url, codex })).source, "magpie");
  server.close();
  server.closeAllConnections();
  const viaCodex = await readQuotas({ url, codex });
  assert.equal(viaCodex.source, "codex");
  assert.match(viaCodex.note!, /Magpie/);
  const none = await readQuotas({ url, codex: async () => [] });
  assert.deepEqual([none.source, none.accounts.length], ["none", 0]);
});

test("the quota route is rate-limited but can be refreshed", async () => {
  let calls = 0;
  const made = { value: 0 };
  const t = await boot(() => ({ start: async () => {}, send: async () => {}, interrupt: async () => {}, answerApproval: () => {}, stop: () => {} }), {
    quota: async () => {
      calls++;
      made.value++;
      return { source: "none", accounts: [], note: "x" };
    },
  });
  await t.api("GET", "/api/quotas");
  await t.api("GET", "/api/quotas");
  await t.api("GET", "/api/quotas?refresh=1");
  assert.equal(calls, 1, "a forced refresh within 10 seconds reuses the last answer");
  t.close();
});

// ---------- roles ----------
test("AI refinement returns text for review and saves nothing", async () => {
  const seen: any[] = [];
  const t = await boot(() => ({ start: async () => {}, send: async () => {}, interrupt: async () => {}, answerApproval: () => {}, stop: () => {} }), {
    refine: async (i) => {
      seen.push(i);
      return "润色后的职责";
    },
  });
  const bot = (await t.api("POST", "/api/bots", { name: "W", role: "原文", agent: "claude" })).body;
  const r = await t.api("POST", "/api/role/refine", { name: "W", draft: "写报告", chief: false });
  assert.equal(r.body.role, "润色后的职责");
  assert.deepEqual(seen[0], { name: "W", draft: "写报告", chief: false });
  assert.equal((await t.api("GET", "/api/state")).body.bots.find((b: any) => b.id === bot.id).role, "原文");
  assert.equal((await t.api("POST", "/api/role/refine", { name: "", draft: " " })).status, 400);
  t.close();
});

test("Chief's role can be rewritten, and the default stays available", async () => {
  const home = tempHome();
  const s = new Store(home);
  ensureSeedBots(s);
  s.close();
  const t = await boot(() => ({ start: async () => {}, send: async () => {}, interrupt: async () => {}, answerApproval: () => {}, stop: () => {} }), { home });
  const state = (await t.api("GET", "/api/state")).body;
  const chief = state.bots[0];
  assert.match(chief.role, /任务不限类型/);
  assert.equal(state.chief_default_role, chief.role);
  assert.equal((await t.api("PATCH", `/api/bots/${chief.id}`, { role: "我自己写的" })).body.role, "我自己写的");
  t.close();
});

test("old seed roles become general unless the user edited them", () => {
  const home = tempHome();
  const s = new Store(home);
  const base = { agent: "codex" as const, model: "m", effort: "low" as const, permission: "ask" as const, route: "official" as const };
  s.createBot({ ...base, name: "Engineer", role: "你是团队的工程师 Engineer，负责实现分割模型相关代码。先读懂现有代码再动手，改动要小，并说明如何验证。" });
  s.createBot({ ...base, name: "Reviewer", role: "我改过的审查规则" });
  ensureSeedBots(s);
  const roles = Object.fromEntries(s.listBots().map((b) => [b.name, b.role]));
  assert.doesNotMatch(roles.Engineer, /分割/);
  assert.equal(roles.Reviewer, "我改过的审查规则");
  s.close();
});
