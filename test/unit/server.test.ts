import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, tempHome } from "../helpers.ts";
import type { AgentRuntime } from "../../src/daemon/types.ts";

const noop: AgentRuntime = { start: async () => {}, send: async () => {}, interrupt: async () => {}, answerApproval: () => {}, stop: () => {} };
const json = { "content-type": "application/json" };
const body = JSON.stringify({ name: "X", agent: "claude" });

test("refuses a foreign Host, which blocks DNS rebinding", async () => {
  const t = await boot(() => noop);
  assert.equal(await t.raw("GET", "/api/state", { host: "evil.example" }), 403);
  assert.equal(await t.raw("GET", "/api/state", { host: `127.0.0.1:${t.port}` }), 200);
  t.close();
});

test("refuses another site's Origin on reads and writes", async () => {
  const t = await boot(() => noop);
  const host = `127.0.0.1:${t.port}`;
  assert.equal(await t.raw("GET", "/api/state", { host, origin: "https://evil.example" }), 403);
  assert.equal(await t.raw("POST", "/api/bots", { host, origin: "https://evil.example", ...json }, body), 403);
  assert.equal(await t.raw("POST", "/api/bots", { host, "sec-fetch-site": "cross-site", ...json }, body), 403);
  assert.equal(await t.raw("POST", "/api/bots", { host, origin: `http://${host}`, ...json }, body), 201);
  t.close();
});

test("a form-style POST is refused, since a cross-site form can send one without a preflight", async () => {
  const t = await boot(() => noop);
  const host = `127.0.0.1:${t.port}`;
  assert.equal(await t.raw("POST", "/api/bots", { host, "content-type": "text/plain" }, body), 415);
  assert.equal(await t.raw("POST", "/api/bots", { host, "content-type": "application/x-www-form-urlencoded" }, "name=x"), 415);
  t.close();
});

test("the page is served with a CSP that forbids inline script", async () => {
  const t = await boot(() => noop);
  const res = await fetch(t.base + "/");
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  await res.text();
  t.close();
});

test("only listed static files are served", async () => {
  const t = await boot(() => noop);
  for (const p of ["/app.js", "/markdown.js", "/avatar.js", "/styles.css"]) {
    const r = await fetch(t.base + p);
    assert.equal(r.status, 200, p);
    await r.text();
  }
  assert.equal(await t.raw("GET", "/..%2f..%2fpackage.json", { host: `127.0.0.1:${t.port}` }), 404);
  assert.equal(await t.raw("GET", "/platform.db", { host: `127.0.0.1:${t.port}` }), 404);
  t.close();
});

test("Bot fields are validated", async () => {
  const t = await boot(() => noop);
  const post = (b: unknown) => t.api("POST", "/api/bots", b);
  assert.equal((await post({ agent: "claude" })).status, 400);
  assert.equal((await post({ name: "  ", agent: "claude" })).status, 400);
  assert.equal((await post({ name: "x" })).status, 400);
  assert.equal((await post({ name: "x", agent: "rm" })).status, 400);
  assert.equal((await post({ name: "x", agent: "claude", effort: "turbo" })).status, 400);
  assert.equal((await post({ name: "x", agent: "claude", model: "--dangerously-skip-permissions" })).status, 400, "a model cannot pose as a flag");
  assert.equal((await post({ name: "x", agent: "claude", cwd: "relative/path" })).status, 400);
  assert.equal((await post({ name: "x", agent: "claude", cwd: "/definitely/not/here" })).status, 400);
  assert.equal((await post({ name: "x".repeat(41), agent: "claude" })).status, 400);
  const ok = await post({ name: "x", agent: "claude", cwd: tempHome() });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.permission, "ask", "defaults to asking");
  t.close();
});

test("messages are validated and malformed JSON is a 400", async () => {
  const t = await boot(() => noop);
  const bot = (await t.api("POST", "/api/bots", { name: "x", agent: "codex" })).body;
  const post = (b: unknown) => t.api("POST", `/api/bots/${bot.id}/messages`, b);
  assert.equal((await post({ text: "   " })).status, 400);
  assert.equal((await post({ text: 5 })).status, 400);
  assert.equal((await post({ text: "x".repeat(200_001) })).status, 413);
  assert.equal((await post({ text: "x", conversationId: "missing" })).status, 404);
  assert.equal((await t.api("POST", "/api/bots/missing/messages", { text: "x" })).status, 404);
  const res = await fetch(`${t.base}/api/bots/${bot.id}/messages`, { method: "POST", headers: json, body: "{bad" });
  assert.equal(res.status, 400);
  await res.text();
  t.close();
});

test("settings are validated, persist, and unknown or out-of-range values are refused", async () => {
  const home = tempHome();
  const t = await boot(() => noop, { home });
  const put = (b: unknown) => t.api("PUT", "/api/settings", b);
  assert.equal((await put({ theme: "neon" })).status, 400);
  assert.equal((await put({ nope: 1 })).status, 400);
  assert.equal((await put({ max_depth: 0 })).status, 400);
  assert.equal((await put({ max_depth: 2.5 })).status, 400);
  assert.equal((await put({ details_open: "yes" })).status, 400);
  assert.equal((await put({ theme: "dark", max_depth: 1, details_open: false })).status, 200);
  t.close();
  const again = await boot(() => noop, { home });
  const { settings } = (await again.api("GET", "/api/settings")).body;
  assert.deepEqual([settings.theme, settings.max_depth, settings.details_open, settings.accent], ["dark", 1, false, "indigo"]);
  assert.equal((await again.api("PUT", "/api/settings", { theme: "light" })).body.settings.theme, "light", "dark is only the default");
  assert.equal((await again.api("GET", "/api/state")).body.settings.theme, "light");
  again.close();
});

test("the default theme is dark, and an empty model is refused", async () => {
  const t = await boot(() => noop);
  assert.equal((await t.api("GET", "/api/settings")).body.settings.theme, "dark");
  assert.equal((await t.api("POST", "/api/bots", { name: "x", agent: "codex", model: "" })).status, 400);
  t.close();
});

test("new-Bot defaults come from settings, and explicit values still win", async () => {
  const t = await boot(() => noop);
  await t.api("PUT", "/api/settings", { default_effort: "low", default_permission: "read_only", default_budget_group: 7000 });
  assert.equal((await t.api("PUT", "/api/settings", { default_budget_bot: 5000 })).status, 400, "a Bot no longer has a per-round budget to default");
  const a = (await t.api("POST", "/api/bots", { name: "a", agent: "codex" })).body;
  assert.deepEqual([a.effort, a.permission, a.budget_tokens], ["low", "read_only", 0]);
  const b = (await t.api("POST", "/api/bots", { name: "b", agent: "codex", effort: "high", permission: "ask", budget_tokens: 9000 })).body;
  assert.deepEqual([b.effort, b.permission, b.budget_tokens], ["high", "ask", 0], "and asking for one has no effect");
  assert.equal((await t.api("POST", "/api/groups", { name: "g", members: [a.id, b.id] })).body.budget_tokens, 7000);
  t.close();
});

test("the new page files are served", async () => {
  const t = await boot(() => noop);
  for (const p of ["/icons.js", "/settings.js"]) {
    const r = await fetch(t.base + p);
    assert.equal(r.status, 200, p);
    await r.text();
  }
  assert.deepEqual((await t.api("GET", "/api/targets")).body.targets, []);
  t.close();
});

test("a conversation cannot be continued through a different Bot", async () => {
  const t = await boot(() => noop);
  const a = (await t.api("POST", "/api/bots", { name: "a", agent: "codex" })).body;
  const b = (await t.api("POST", "/api/bots", { name: "b", agent: "codex" })).body;
  const conv = (await t.api("POST", `/api/bots/${a.id}/messages`, { text: "x" })).body;
  assert.equal((await t.api("POST", `/api/bots/${b.id}/messages`, { text: "y", conversationId: conv.id })).status, 404);
  t.close();
});
