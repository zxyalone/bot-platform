import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acpLaunch, AcpRuntime } from "../../src/daemon/adapters/acp.ts";
import type { AgentEvent, RuntimeOptions } from "../../src/daemon/types.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake_acp.mjs");

function make(over: Partial<RuntimeOptions> = {}, usage?: any) {
  const cwd = mkdtempSync(join(tmpdir(), "acp-"));
  const logFile = join(cwd, "..", `${cwd.split("/").pop()}.log`);
  process.env.FAKE_ACP_LOG = logFile;
  const events: AgentEvent[] = [];
  const o: RuntimeOptions = { agent: "grok", model: "m", effort: "low", permission: "ask", route: "official", cwd, systemPrompt: "你是测试员", sessionId: null, onEvent: (e) => events.push(e), ...over };
  const rt = new AcpRuntime(o, { command: process.execPath, args: [FAKE], modelId: over.agent === "antigravity" ? "m-low" : undefined, usage });
  const wait = async (check: () => unknown, ms = 4000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out; events: ${JSON.stringify(events).slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const ended = () => events.find((e) => e.type === "turn_end") as any;
  const texts = () => events.filter((e) => e.type === "text_done").map((e: any) => e.text);
  const requests = () => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { rt, events, cwd, wait, ended, texts, requests };
}

test("streams a reply, reports usage, and sends the role only with the first message", async () => {
  const s = make();
  await s.rt.start();
  await s.rt.send("打招呼");
  await s.wait(s.ended);
  assert.deepEqual(s.events.filter((e) => e.type === "text_delta").map((e: any) => e.text), ["你", "好"]);
  assert.deepEqual(s.texts(), ["你好"]);
  assert.equal(s.ended().status, "completed");
  assert.deepEqual(s.events.find((e) => e.type === "usage"), { type: "usage", inputTokens: 100, cachedTokens: 40, outputTokens: 7 });
  assert.deepEqual(s.events.find((e) => e.type === "session"), { type: "session", sessionId: "sess-new" });
  s.events.length = 0;
  await s.rt.send("再来");
  await s.wait(s.ended);
  const prompts = s.requests().filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text);
  assert.match(prompts[0], /你是测试员/);
  assert.doesNotMatch(prompts[1], /你是测试员/);
  s.rt.stop();
});

test("the bus is injected as an MCP server, and an Antigravity model id carries its effort", async () => {
  const s = make({ agent: "antigravity", bus: { command: "node", args: ["x"], env: { BUS_TOKEN: "t" } } });
  await s.rt.start();
  const reqs = s.requests();
  assert.deepEqual(reqs.find((m) => m.method === "session/new").params.mcpServers, [{ name: "botbus", command: "node", args: ["x"], env: [{ name: "BUS_TOKEN", value: "t" }] }]);
  assert.equal(reqs.find((m) => m.method === "session/set_model").params.modelId, "m-low");
  s.rt.stop();
  assert.deepEqual(acpLaunch({ agent: "antigravity", model: "gemini-4-argon", effort: "high" } as RuntimeOptions).modelId, "gemini-4-argon-high");
  assert.deepEqual(acpLaunch({ agent: "grok", model: "grok-4.7", effort: "low" } as RuntimeOptions).args, ["agent", "-m", "grok-4.7", "--reasoning-effort", "low", "stdio"]);
});

test("resuming does not replay old messages, and a lost session starts fresh instead of failing", async () => {
  const a = make({ sessionId: "old" });
  await a.rt.start();
  assert.equal(a.events.some((e) => e.type === "text_delta"), false);
  await a.rt.send("继续");
  await a.wait(a.ended);
  assert.equal(a.requests().find((m) => m.method === "session/prompt").params.sessionId, "old");
  a.rt.stop();

  const b = make({ sessionId: "missing" });
  await b.rt.start();
  await b.rt.send("继续");
  await b.wait(b.ended);
  assert.equal(b.ended().status, "completed");
  assert.deepEqual(b.events.find((e) => e.type === "session"), { type: "session", sessionId: "sess-new" });
  b.rt.stop();
});

test("ask: nothing is written until approved, and denial is passed back", async () => {
  const s = make();
  await s.rt.start();
  await s.rt.send("WRITE");
  await s.wait(() => s.events.some((e) => e.type === "approval"));
  const a = s.events.find((e) => e.type === "approval") as any;
  assert.equal(existsSync(join(s.cwd, "out.txt")), false);
  s.rt.answerApproval(a.requestId, "deny");
  await s.wait(s.ended);
  assert.equal(existsSync(join(s.cwd, "out.txt")), false);
  assert.deepEqual(s.texts(), ["我来写文件。", "被拒绝了"]);
  assert.equal(s.events.filter((e) => e.type === "tool").at(-1)!.status, "failed");
  s.rt.stop();
});

test("allow once writes; allow for the conversation stops asking but never uses the agent's permanent grant", async () => {
  const s = make();
  await s.rt.start();
  await s.rt.send("WRITE");
  await s.wait(() => s.events.some((e) => e.type === "approval"));
  s.rt.answerApproval((s.events.find((e) => e.type === "approval") as any).requestId, "allow_session");
  await s.wait(s.ended);
  assert.equal(existsSync(join(s.cwd, "out.txt")), true);
  s.events.length = 0;
  await s.rt.send("WRITE");
  await s.wait(s.ended);
  assert.equal(s.events.some((e) => e.type === "approval"), false, "remembered");
  const answers = s.requests().filter((m) => m.result?.outcome?.optionId);
  assert.deepEqual(answers.map((m) => m.result.outcome.optionId), ["a", "a"], "always the once option");
  s.rt.stop();
});

test("a denial the agent reports as cancelled is a finished turn, not a stop", async () => {
  const s = make();
  await s.rt.start();
  await s.rt.send("WRITE GROKSTYLE");
  await s.wait(() => s.events.some((e) => e.type === "approval"));
  s.rt.answerApproval((s.events.find((e) => e.type === "approval") as any).requestId, "deny");
  await s.wait(s.ended);
  assert.equal(s.ended().status, "completed");
  assert.match(s.texts().at(-1), /被拒绝.*没有完成/, "a reader is not left with the promise alone");
  s.rt.stop();
});

test("auto-edit also finds the path where Grok puts it, inside and out", async () => {
  const s = make({ permission: "auto_edit" });
  await s.rt.start();
  await s.rt.send("RAWPATH");
  await s.wait(s.ended);
  assert.equal(s.events.some((e) => e.type === "approval"), false);
  s.rt.stop();
  const o = make({ permission: "auto_edit" });
  await o.rt.start();
  await o.rt.send("RAWPATH OUT");
  await o.wait(() => o.events.some((e) => e.type === "approval"));
  o.rt.stop();
});

test("read-only refuses writes, commands and unknown tools without asking, but allows reads and the bus", async () => {
  for (const [text, want] of [["WRITE", "被拒绝了"], ["SHELL", "denied"], ["NOKIND", "denied"], ["READ", "read ok"], ["BUS", "bus ok"]]) {
    const s = make({ permission: "read_only" });
    await s.rt.start();
    await s.rt.send(text);
    await s.wait(s.ended);
    assert.equal(s.events.some((e) => e.type === "approval"), false, text);
    assert.equal(s.texts().at(-1), want, text);
    assert.equal(existsSync(join(s.cwd, "out.txt")), false, text);
    s.rt.stop();
  }
});

test("auto-edit allows edits inside the directory, and still asks about anything else", async () => {
  const s = make({ permission: "auto_edit" });
  await s.rt.start();
  await s.rt.send("WRITE");
  await s.wait(s.ended);
  assert.equal(existsSync(join(s.cwd, "out.txt")), true);
  assert.equal(s.events.some((e) => e.type === "approval"), false);
  s.rt.stop();
  for (const text of ["WRITE OUTSIDE", "SHELL", "NOKIND"]) {
    const o = make({ permission: "auto_edit" });
    await o.rt.start();
    await o.rt.send(text);
    await o.wait(() => o.events.some((e) => e.type === "approval"));
    o.rt.stop();
  }
});

test("stop ends the turn and closes an open approval", async () => {
  const s = make();
  await s.rt.start();
  await s.rt.send("SLEEP");
  await s.wait(() => s.events.some((e) => e.type === "text_delta"));
  await s.rt.interrupt();
  await s.wait(s.ended);
  assert.equal(s.ended().status, "interrupted");
  assert.deepEqual(s.texts(), ["开始…"], "the partial text is kept");
  s.rt.stop();

  const w = make();
  await w.rt.start();
  await w.rt.send("WRITE");
  await w.wait(() => w.events.some((e) => e.type === "approval"));
  await w.rt.interrupt();
  await w.wait(w.ended);
  assert.equal(w.ended().status, "interrupted");
  assert.equal(existsSync(join(w.cwd, "out.txt")), false);
  w.rt.stop();
});

test("a crash during a turn is reported", async () => {
  const s = make();
  await s.rt.start();
  await s.rt.send("CRASH");
  await s.wait(s.ended);
  assert.equal(s.ended().status, "failed");
  s.rt.stop();
});

test("usage falls back to the agent's own record, and Antigravity's tool prefix is removed", async () => {
  process.env.FAKE_ACP_NO_USAGE = "1";
  try {
    const s = make({}, async () => ({ inputTokens: 5, cachedTokens: 1, outputTokens: 2 }));
    await s.rt.start();
    await s.rt.send("PREFIX");
    await s.wait(s.ended);
    assert.deepEqual(s.events.find((e) => e.type === "usage"), { type: "usage", inputTokens: 5, cachedTokens: 1, outputTokens: 2 });
    assert.deepEqual(s.texts(), ["结果"]);
    s.rt.stop();
  } finally {
    delete process.env.FAKE_ACP_NO_USAGE;
  }
});
