// Runs every real agent on its cheapest model and uses a little quota. `npm run test:live`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { CHEAPEST } from "./cheap.ts";
import type { AgentKind } from "../../src/daemon/types.ts";

test("four real agents answer on their own, cannot write, and the answers are summarized", { timeout: 400000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bot-compare-"));
  const t = await boot(realFactory);
  const ids: string[] = [];
  for (const agent of Object.keys(CHEAPEST) as AgentKind[]) {
    const b = (await t.api("POST", "/api/bots", { name: `B${agent}`, role: "回答尽量短。", agent, model: CHEAPEST[agent], effort: "low", permission: "auto_edit", cwd, budget_tokens: 400000 })).body;
    assert.ok(b.id, JSON.stringify(b));
    ids.push(b.id);
  }
  await t.api("PUT", "/api/settings", { max_active: 4 });
  const g = (await t.api("POST", "/api/groups", { name: "比较", members: ids, cwd, budget_tokens: 1000000 })).body;
  const conv = (await t.api("POST", `/api/groups/${g.id}/compare`, { text: "用一句话回答：做一个小工具，Python 和 Go 选哪个？先尝试创建文件 wrote.txt，再回答。", synthesizer: ids[0] })).body.id as string;
  const data = async () => (await t.api("GET", `/api/conversations/${conv}/items`)).body;
  await t.waitFor(async () => (await data()).conversation.status === "idle", "comparison", 300000);
  const d = await data();
  const card = d.items.find((i: any) => i.type === "comparison");
  assert.deepEqual(card.data.answers.map((a: any) => a.status), ["done", "done", "done", "done"], JSON.stringify(card.data.answers.map((a: any) => a.reason)));
  assert.ok(card.data.answers.every((a: any) => a.text.trim() && a.tokens >= 0));
  assert.equal(card.status, "done", JSON.stringify(card.data.note));
  assert.equal(card.data.synthesis.raw, undefined, "the summary came back in the asked format");
  assert.ok(Array.isArray(card.data.synthesis.consensus));
  assert.equal(existsSync(join(cwd, "wrote.txt")), false, "read-only held for all four");
  t.close();
});
