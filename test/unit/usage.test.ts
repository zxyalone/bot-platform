import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../helpers.ts";
import { AcpRuntime } from "../../src/daemon/adapters/acp.ts";
import { ClaudeRuntime, claudeArgs } from "../../src/daemon/adapters/claude.ts";
import { agentEnv } from "../../src/daemon/adapters/process.ts";
import type { AgentEvent, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../../src/daemon/types.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake_acp.mjs");
const base: RuntimeOptions = { agent: "claude", model: "claude-haiku-5-5", effort: "low", permission: "ask", route: "official", cwd: "/tmp", systemPrompt: "", sessionId: null, onEvent: () => {} };

class Fake implements AgentRuntime {
  sent: string[] = [];
  opts: RuntimeOptions;
  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }
  reply(contextTokens?: number) {
    this.opts.onEvent({ type: "session", sessionId: `s-${Math.random()}` });
    this.opts.onEvent({ type: "text_done", key: `k${Math.random()}`, text: `回答${this.sent.length}` });
    this.opts.onEvent({ type: "usage", inputTokens: 1000, cachedTokens: 900, outputTokens: 10, requests: 3, contextTokens });
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

async function setup() {
  const made: Fake[] = [];
  const t = await boot((o) => {
    const f = new Fake(o);
    made.push(f);
    return f;
  });
  const cwd = mkdtempSync(join(tmpdir(), "bot-usage-"));
  const bot = (await t.api("POST", "/api/bots", { name: "A", role: "ROLE-A", agent: "claude", model: "claude-haiku-5-5", cwd })).body;
  const turn = async (text: string, contextTokens: number | undefined, conversationId?: string) => {
    const before = made.reduce((n, f) => n + f.sent.length, 0);
    const id = (await t.api("POST", `/api/bots/${bot.id}/messages`, { text, conversationId })).body.id as string;
    await t.waitFor(() => made.reduce((n, f) => n + f.sent.length, 0) > before, "sent");
    made.at(-1)!.reply(contextTokens);
    await t.waitFor(async () => (await t.api("GET", `/api/conversations/${id}/items`)).body.conversation.status === "idle", "idle");
    return id;
  };
  const items = async (id: string) => (await t.api("GET", `/api/conversations/${id}/items`)).body.items as any[];
  return { t, made, bot, turn, items };
}

test("a session past the context limit is retired: the next turn starts fresh with the recent conversation, once", async () => {
  const s = await setup();
  const id = await s.turn("第一个问题", 50_000);
  await s.turn("第二个问题", 200_000, id);
  assert.equal(s.made.length, 1, "one process for both turns while under the limit");
  const notice = (await s.items(id)).find((i) => i.type === "notice");
  assert.match(notice.data.text, /200k/);
  assert.equal(s.t.store.getConversation(id)!.session_id, null);

  await s.turn("第三个问题", 1000, id);
  assert.equal(s.made.length, 2, "a new process");
  const fresh = s.made[1];
  assert.equal(fresh.opts.sessionId, null, "not resumed");
  assert.match(fresh.sent[0], /新会话/);
  assert.match(fresh.sent[0], /第一个问题[\s\S]*回答1[\s\S]*第二个问题/);
  assert.match(fresh.sent[0], /第三个问题$/);

  await s.turn("第四个问题", 1000, id);
  assert.equal(fresh.sent[1].includes("新会话"), false, "the carryover goes once");
  const summary = (await s.items(id)).filter((i) => i.type === "turn_summary").at(-1);
  assert.equal(summary.data.requests, 3);
  const logged = s.t.store.db.prepare("SELECT requests, context_tokens FROM usage_log ORDER BY created_at DESC LIMIT 1").get() as any;
  assert.deepEqual({ ...logged }, { requests: 3, context_tokens: 1000 });
  s.t.close();
});

test("rotation can be switched off, and Claude Bots leave out personal config unless asked", async () => {
  const s = await setup();
  assert.equal(s.made.length, 0);
  await s.t.api("PUT", "/api/settings", { rotate_context_tokens: 0 });
  const id = await s.turn("问题", 900_000);
  assert.equal(s.made[0].opts.lean, true);
  await s.t.api("PUT", "/api/settings", { claude_personal_config: true });
  await s.turn("再问", 900_000, id);
  assert.equal(s.made.length, 2, "changing the setting restarts the agent");
  assert.equal(s.made[1].opts.lean, false);
  assert.ok(s.made[1].opts.sessionId, "resumed, not rotated");
  s.t.close();
});

test("lean Claude flags, and the API key never reaches Claude", () => {
  const lean = claudeArgs({ ...base, lean: true });
  for (const f of ["--setting-sources", "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections"]) assert.ok(lean.includes(f), f);
  assert.equal(lean[lean.indexOf("--setting-sources") + 1], "project,local");
  assert.equal(claudeArgs(base).includes("--setting-sources"), false);
  process.env.ANTHROPIC_API_KEY = "sk-test";
  try {
    assert.equal(agentEnv(["ANTHROPIC_API_KEY"]).ANTHROPIC_API_KEY, undefined);
    assert.equal(agentEnv().ANTHROPIC_API_KEY, "sk-test");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("Claude counts model requests and the last request's context in a turn", async () => {
  const events: AgentEvent[] = [];
  const rt = new ClaudeRuntime({ ...base, onEvent: (e) => events.push(e) }) as any;
  await rt.send("hi");
  rt.onMessage({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 3 }, content: [] } });
  rt.onMessage({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 3 }, content: [] } });
  rt.onMessage({ type: "assistant", message: { id: "m2", usage: { input_tokens: 7, cache_read_input_tokens: 1100, cache_creation_input_tokens: 50, output_tokens: 4 }, content: [] } });
  rt.onMessage({ type: "result", usage: { input_tokens: 12, cache_read_input_tokens: 2100, cache_creation_input_tokens: 150, output_tokens: 7 } });
  const u = events.find((e) => e.type === "usage") as any;
  assert.equal(u.requests, 2);
  assert.equal(u.contextTokens, 1157);
});

test("Antigravity's cache reads are added to its input, Grok's are not", async () => {
  for (const [excludes, want] of [[true, 140], [false, 100]] as const) {
    const cwd = mkdtempSync(join(tmpdir(), "acp-u-"));
    process.env.FAKE_ACP_LOG = join(cwd, "..", `${cwd.split("/").pop()}.log`);
    const events: AgentEvent[] = [];
    const rt = new AcpRuntime({ ...base, agent: "antigravity", cwd, onEvent: (e) => events.push(e) }, { command: process.execPath, args: [FAKE_ACP], modelId: "m-low", inputExcludesCached: excludes });
    await rt.start();
    await rt.send("打招呼");
    const end = Date.now() + 4000;
    while (!events.some((e) => e.type === "usage") && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    assert.equal((events.find((e) => e.type === "usage") as any).inputTokens, want);
    rt.stop();
  }
});
