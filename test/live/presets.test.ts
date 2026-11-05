// Real agents again: the auto-edit preset, its boundary, and the gateway route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { CHEAPEST } from "./cheap.ts";

const TURN_MS = 180000;
const CASES = [
  { agent: "claude", model: CHEAPEST.claude },
  { agent: "codex", model: CHEAPEST.codex },
];

async function run(t: any, botId: string, text: string, decide: (a: any) => string, conversationId?: string) {
  const conv = (await t.api("POST", `/api/bots/${botId}/messages`, { text, conversationId })).body.id;
  const answered = new Set<string>();
  const seen: any[] = [];
  const end = Date.now() + TURN_MS;
  for (;;) {
    const d = (await t.api("GET", `/api/conversations/${conv}/items`)).body;
    for (const i of d.items) {
      if (i.type === "approval" && i.status === "pending" && !answered.has(i.id)) {
        answered.add(i.id);
        seen.push(i);
        await t.api("POST", `/api/approvals/${i.id}`, { decision: decide(i) });
      }
    }
    if (d.conversation.status === "idle") return { conv, d, approvals: seen };
    if (Date.now() > end) throw new Error("turn timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}
const errors = (d: any) => d.items.filter((i: any) => i.type === "error").map((i: any) => i.data.message);

for (const c of CASES) {
  test(`${c.agent}: auto-edit writes inside the workspace but not outside it`, { timeout: 500000 }, async () => {
    const t = await boot(realFactory, { home: tempHome() });
    const cwd = mkdtempSync(join(tmpdir(), `bot-auto-${c.agent}-`));
    // Not under the system temp directory: Codex's sandbox allows writes there by design.
    const outside = mkdtempSync(join(homedir(), `.bot-outside-${c.agent}-`));
    const bot = (await t.api("POST", "/api/bots", { name: "Auto", role: "", agent: c.agent, model: c.model, effort: "low", permission: "auto_edit", cwd })).body;

    const inside = await run(t, bot.id, "在当前工作目录创建文件 inside.txt，内容是 hello。现在就用工具做。", () => "deny");
    assert.deepEqual(errors(inside.d), []);
    assert.equal(existsSync(join(cwd, "inside.txt")), true, "writes inside without being blocked");
    assert.equal(inside.approvals.length, 0, "no approval needed inside the workspace");

    const target = join(outside, "escape.txt");
    const out = await run(t, bot.id, `创建文件 ${target}，内容是 hello。现在就用工具做。`, () => "deny", inside.conv);
    assert.deepEqual(errors(out.d), []);
    const escaped = existsSync(target);
    // rmdir only succeeds on an empty directory, so a stray file is never deleted unseen.
    if (!escaped) rmdirSync(outside);
    assert.equal(escaped, false, `a write outside the workspace is not silent; left at ${target}`);
    t.close();
  });
}

test("codex: the gateway route works when the local gateway is running", { timeout: 300000 }, async (tt) => {
  const up = await fetch("http://127.0.0.1:3425/v1/models").then((r) => r.ok).catch(() => false);
  if (!up) return tt.skip("local gateway is not running");
  const t = await boot(realFactory, { home: tempHome() });
  const bot = (await t.api("POST", "/api/bots", { name: "Gw", role: "", agent: "codex", model: CHEAPEST.codex, effort: "low", route: "gateway", cwd: mkdtempSync(join(tmpdir(), "bot-gw-")) })).body;
  const r = await run(t, bot.id, "回复两个字：收到", () => "deny");
  assert.deepEqual(errors(r.d), []);
  assert.ok(r.d.items.some((i: any) => i.type === "assistant" && i.data.text));
  t.close();
});
