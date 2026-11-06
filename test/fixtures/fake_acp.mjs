#!/usr/bin/env node
// A scripted ACP agent, so the adapter can be tested without calling any model.
// The prompt text picks the behaviour; FAKE_ACP_LOG records every request.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const log = (o) => process.env.FAKE_ACP_LOG && appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(o) + "\n");
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const say = (sid, text) => update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

let nextId = 1000;
const waiting = new Map();
const ask = (sessionId, toolCall) =>
  new Promise((res) => {
    const id = nextId++;
    waiting.set(id, res);
    send({ id, method: "session/request_permission", params: { sessionId, toolCall, options: [{ optionId: "a", kind: "allow_once" }, { optionId: "x", kind: "allow_always" }, { optionId: "r", kind: "reject_once" }] } });
  });
const allowed = (r) => r?.outcome?.outcome === "selected" && r.outcome.optionId === "a";
let cancel = null;

async function prompt(m) {
  const { sessionId, prompt: blocks } = m.params;
  const text = blocks[0].text;
  const usage = process.env.FAKE_ACP_NO_USAGE ? undefined : { inputTokens: 100, cachedReadTokens: 40, outputTokens: 7 };
  const done = (stopReason = "end_turn") => send({ id: m.id, result: { stopReason, usage } });
  if (text.includes("CRASH")) process.exit(9);
  if (text.includes("WRITE")) {
    const file = text.includes("OUTSIDE") ? "/tmp/fake-outside.txt" : join(process.cwd(), "out.txt");
    say(sessionId, "我来写文件。");
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: `Write ${file}`, kind: "edit", status: "pending", rawInput: { path: file } });
    const r = await ask(sessionId, { toolCallId: "t1", title: `Write ${file}`, kind: "edit", locations: [{ path: file }], rawInput: { path: file } });
    if (allowed(r) && !text.includes("OUTSIDE")) writeFileSync(file, "hi");
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: allowed(r) ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: "结果" } }] });
    if (!allowed(r) && text.includes("GROKSTYLE")) return done("cancelled");
    say(sessionId, allowed(r) ? "写好了" : "被拒绝了");
    return done();
  }
  if (text.includes("RAWPATH")) {
    const file = text.includes("OUT") ? "/tmp/fake-outside.txt" : join(process.cwd(), "out.txt");
    const r = await ask(sessionId, { toolCallId: "t9", title: "Edit", kind: "edit", rawInput: { file_path: file } });
    say(sessionId, allowed(r) ? "ran" : "denied");
    return done();
  }
  if (text.includes("SHELL")) {
    const r = await ask(sessionId, { toolCallId: "t2", title: "rm -rf build", kind: "execute" });
    say(sessionId, allowed(r) ? "ran" : "denied");
    return done();
  }
  if (text.includes("NOKIND")) {
    const r = await ask(sessionId, { toolCallId: "t3", title: "Mystery" });
    say(sessionId, allowed(r) ? "ran" : "denied");
    return done();
  }
  if (text.includes("READ")) {
    const r = await ask(sessionId, { toolCallId: "t4", title: "Read a.txt", kind: "read" });
    say(sessionId, allowed(r) ? "read ok" : "denied");
    return done();
  }
  if (text.includes("BUS")) {
    const r = await ask(sessionId, { toolCallId: "t5", title: "mcp__botbus__ask_bot", kind: "other" });
    say(sessionId, allowed(r) ? "bus ok" : "denied");
    return done();
  }
  if (text.includes("SLEEP")) {
    say(sessionId, "开始…");
    await new Promise((res) => (cancel = res));
    return done("cancelled");
  }
  if (text.includes("CONTEXT")) {
    // Like dsh: no usage in the result, only how full the context is after each model request.
    for (const used of [1000, 1400, 1500]) update(sessionId, { sessionUpdate: "usage_update", used, size: 1048576 });
    say(sessionId, "ok");
    return send({ id: m.id, result: { stopReason: "end_turn" } });
  }
  if (text.includes("PREFIX")) {
    say(sessionId, "Created At: 2026\nCompleted At: 2026\n结果");
    return done();
  }
  say(sessionId, "你");
  say(sessionId, "好");
  done();
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.id !== undefined && !m.method) {
    waiting.get(m.id)?.(m.result);
    waiting.delete(m.id);
  } else if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: process.env.FAKE_ACP_RESUME ? { sessionCapabilities: { resume: {} } } : { loadSession: true } } });
  else if (m.method === "session/resume") send(m.params.sessionId === "missing" ? { id: m.id, error: { code: -32000, message: "no such session" } } : { id: m.id, result: {} });
  else if (m.method === "session/set_config_option") send({ id: m.id, result: { configOptions: [] } });
  else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "sess-new" } });
  else if (m.method === "session/load") {
    if (m.params.sessionId === "missing") return send({ id: m.id, error: { code: -32000, message: "no such session" } });
    say(m.params.sessionId, "旧回复不该再出现");
    send({ id: m.id, result: {} });
  } else if (m.method === "session/set_model") send({ id: m.id, result: {} });
  else if (m.method === "session/prompt") void prompt(m);
  else if (m.method === "session/cancel") cancel?.();
  else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "no" } });
});
