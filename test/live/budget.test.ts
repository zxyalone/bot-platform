// Runs every real agent on its cheapest model and uses a little quota. `npm run test:live`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { Memory } from "../../src/daemon/git.ts";
import { CHEAPEST } from "./cheap.ts";
import type { AgentKind } from "../../src/daemon/types.ts";

for (const agent of Object.keys(CHEAPEST) as AgentKind[]) {
  test(`${agent}: real usage counts toward the project budget, and a spent budget stops the next message`, { timeout: 200000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `bot-budget-${agent}-`));
    const t = await boot(realFactory);
    const bot = (await t.api("POST", "/api/bots", { name: "W", role: "回答尽量短。", agent, model: CHEAPEST[agent], effort: "low", permission: "read_only", cwd })).body;
    assert.ok(bot.id, JSON.stringify(bot));
    await t.api("PUT", `/api/projects/${Memory.projectId(cwd)}/settings`, { budget_total: 10 });
    const conv = (await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "只回复 OK" })).body.id as string;
    const data = async () => (await t.api("GET", `/api/conversations/${conv}/items`)).body;
    await t.waitFor(async () => (await data()).conversation.status === "idle", "first turn", 150000);
    const report = (await t.api("GET", `/api/projects/${Memory.projectId(cwd)}/budget?cwd=${encodeURIComponent(cwd)}`)).body;
    assert.ok(report.total.spent > 10, `reported ${report.total.spent} tokens`);
    const next = await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "再回复一次", conversationId: conv });
    assert.equal(next.status, 409);
    assert.match(next.body.error, /总预算用完了/);
    t.close();
  });
}
