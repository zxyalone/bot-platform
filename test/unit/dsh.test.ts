import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acpLaunch, AcpRuntime, dshModelValue, type AcpLaunch } from "../../src/daemon/adapters/acp.ts";
import { templatesFor } from "../../src/daemon/workspaces.ts";
import { boot } from "../helpers.ts";
import { MODELS, validModel, type AgentEvent, type AgentRuntime, type ApprovalDecision, type RuntimeOptions } from "../../src/daemon/types.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake_acp.mjs");

function make(over: Partial<RuntimeOptions> = {}, launch: Partial<AcpLaunch> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "dsh-"));
  const logFile = join(cwd, "..", `${cwd.split("/").pop()}.log`);
  process.env.FAKE_ACP_LOG = logFile;
  const events: AgentEvent[] = [];
  const o: RuntimeOptions = { agent: "dsh", model: "deepseek-account/deepseek-flash", effort: "low", permission: "ask", route: "official", cwd, systemPrompt: "", sessionId: null, onEvent: (e) => events.push(e), ...over };
  const real = acpLaunch(o);
  const rt = new AcpRuntime(o, { command: process.execPath, args: [FAKE], config: real.config, ...launch });
  const wait = async (check: () => unknown) => {
    const end = Date.now() + 4000;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out; events: ${JSON.stringify(events).slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const requests = () => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { rt, events, wait, requests };
}

test("a dsh model names its provider, and the effort maps onto dsh's levels", async () => {
  assert.equal(dshModelValue("deepseek-official/deepseek-v4-pro"), JSON.stringify(["deepseek-official", "deepseek-v4-pro"]));
  assert.equal(dshModelValue("deepseek-flash"), JSON.stringify(["deepseek-account", "deepseek-flash"]), "no provider means the account");
  const s = make({ effort: "high", model: "deepseek-official/deepseek-v4-pro" });
  await s.rt.start();
  const set = s.requests().filter((m) => m.method === "session/set_config_option").map((m) => [m.params.configId, m.params.value]);
  assert.deepEqual(set, [["model", JSON.stringify(["deepseek-official", "deepseek-v4-pro"])], ["reasoning_effort", "max"]]);
  s.rt.stop();
  for (const [permission, mode] of [["read_only", "read-only"], ["ask", "workspace-write"], ["auto_edit", "workspace-write"]]) {
    assert.equal(acpLaunch({ agent: "dsh", model: "x", effort: "low", permission } as RuntimeOptions).env?.DSH_PERMISSION_MODE, mode, "never dsh's default full access");
  }
  for (const [ours, theirs] of [["low", "low"], ["medium", "high"]]) {
    assert.equal(acpLaunch({ agent: "dsh", model: "x", effort: ours } as RuntimeOptions).config?.find((c) => c.configId === "reasoning_effort")?.value, theirs);
  }
});

test("usage is estimated from dsh's context readings when the turn reports none", async () => {
  process.env.FAKE_ACP_NO_USAGE = "1";
  try {
    const s = make();
    await s.rt.start();
    await s.rt.send("CONTEXT");
    await s.wait(() => s.events.some((e) => e.type === "turn_end"));
    const u = s.events.find((e) => e.type === "usage") as any;
    assert.deepEqual({ ...u }, { type: "usage", inputTokens: 3900, cachedTokens: 2400, outputTokens: 0, requests: 3, contextTokens: 1500 });
    s.rt.stop();
  } finally {
    delete process.env.FAKE_ACP_NO_USAGE;
  }
});

test("an agent that can resume but not load picks its session back up, or starts fresh if it is gone", async () => {
  process.env.FAKE_ACP_RESUME = "1";
  try {
    const a = make({ sessionId: "old" });
    await a.rt.start();
    await a.rt.send("hi");
    await a.wait(() => a.events.some((e) => e.type === "turn_end"));
    assert.ok(a.requests().some((m) => m.method === "session/resume" && m.params.sessionId === "old"));
    assert.equal(a.requests().some((m) => m.method === "session/new"), false);
    assert.equal(a.requests().find((m) => m.method === "session/prompt").params.sessionId, "old");
    a.rt.stop();
    const b = make({ sessionId: "missing" });
    await b.rt.start();
    assert.ok(b.requests().some((m) => m.method === "session/new"));
    b.rt.stop();
  } finally {
    delete process.env.FAKE_ACP_RESUME;
  }
});

test("dsh models are accepted, other vendors' are not, and a DeepSeek-only person gets a full team", () => {
  assert.equal(validModel("dsh", "deepseek-official/deepseek-v4-pro"), true);
  assert.equal(validModel("dsh", "claude-sonnet-5-5"), false);
  assert.equal(validModel("claude", "deepseek-account/deepseek-flash"), false);
  const team = templatesFor({ dsh: { installed: true, loggedIn: true, models: MODELS.dsh } });
  assert.ok(team.every((t) => t.agent === "dsh" && t.ready));
  assert.equal(team.find((t) => t.key === "chief")!.model, "deepseek-account/deepseek-v4-pro");
  const apiOnly = templatesFor({ dsh: { installed: true, loggedIn: true, models: ["deepseek-official/deepseek-flash"] } });
  assert.equal(apiOnly.find((t) => t.key === "chief")!.model, "deepseek-official/deepseek-flash", "only what this person's dsh offers");
});

// ---------- tasks for an agent that does not ask before acting ----------
class Fake implements AgentRuntime {
  sent: string[] = [];
  opts: RuntimeOptions;
  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }
  reply(text = "好") {
    this.opts.onEvent({ type: "text_done", key: `k${Math.random()}`, text });
    this.opts.onEvent({ type: "turn_end", status: "completed" });
  }
  async start() {}
  async send(t: string) {
    this.sent.push(t);
  }
  async interrupt() {}
  answerApproval(_: string, __: ApprovalDecision) {}
  stop() {}
}

async function team(cwd: string) {
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  });
  const lead = (await t.api("POST", "/api/bots", { name: "Lead", role: "ROLE-Lead", agent: "codex", model: "gpt-6-luna", cwd })).body;
  await t.api("POST", "/api/bots", { name: "Deep", role: "ROLE-Deep", agent: "dsh", model: "deepseek-account/deepseek-flash", permission: "ask", cwd });
  const conv = (await t.api("POST", `/api/bots/${lead.id}/messages`, { text: "go" })).body.id as string;
  const rt = (n: string) => made.find((f) => f.opts.systemPrompt.startsWith(`ROLE-${n}`));
  await t.waitFor(() => rt("Lead")?.sent.length, "lead starts");
  const bus = (tool: string, args: unknown) => fetch(`${t.base}/internal/bus`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${rt("Lead")!.opts.bus!.env.BUS_TOKEN}` }, body: JSON.stringify({ tool, args }) }).then((r) => r.json()) as Promise<{ text: string; isError: boolean }>;
  return { t, made, conv, rt, bus };
}

test("a task for dsh goes to its own worktree unless asked otherwise, and runs in place outside Git", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "dsh-repo-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd });
  git("init", "-q");
  writeFileSync(join(cwd, "a.py"), "1\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  const s = await team(cwd);
  const r = await s.bus("assign_task", { bot: "Deep", task: "改 a.py" });
  assert.equal(r.isError, false, r.text);
  await s.t.waitFor(() => s.rt("Deep")?.sent.length, "deep starts");
  const deep = s.rt("Deep")!;
  assert.notEqual(realpathSync(deep.opts.cwd), realpathSync(cwd), "not the shared folder");
  assert.ok(existsSync(join(deep.opts.cwd, "a.py")), "a worktree of the same repo");
  assert.equal((await s.t.api("GET", `/api/conversations/${s.conv}/worktrees`)).body.worktrees.length, 1);
  deep.reply();
  s.rt("Lead")!.reply();
  await s.t.waitFor(async () => (await s.t.api("GET", `/api/conversations/${s.conv}/items`)).body.conversation.status === "idle", "idle");
  s.t.close();

  const plain = mkdtempSync(join(tmpdir(), "dsh-plain-"));
  const p = await team(plain);
  const r2 = await p.bus("assign_task", { bot: "Deep", task: "写 notes.md" });
  assert.equal(r2.isError, false, "no Git here, so it runs in place rather than being refused");
  await p.t.waitFor(() => p.rt("Deep")?.sent.length, "deep starts");
  assert.equal(realpathSync(p.rt("Deep")!.opts.cwd), realpathSync(plain));
  p.rt("Deep")!.reply();
  p.rt("Lead")!.reply();
  await p.t.waitFor(async () => (await p.t.api("GET", `/api/conversations/${p.conv}/items`)).body.conversation.status === "idle", "idle");
  const state = (await p.t.api("GET", "/api/state")).body;
  assert.deepEqual(state.ungated, ["dsh"]);
  p.t.close();
});
