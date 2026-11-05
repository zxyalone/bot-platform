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
  test(`${agent}: reads the project brief, and picks up an edit in the same conversation`, { timeout: 200000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `bot-brief-${agent}-`));
    const t = await boot(realFactory);
    const bot = (await t.api("POST", "/api/bots", { name: "W", role: "回答尽量短。", agent, model: CHEAPEST[agent], effort: "low", permission: "read_only", cwd })).body;
    assert.ok(bot.id, JSON.stringify(bot));
    const pid = Memory.projectId(cwd);
    await t.api("PUT", `/api/projects/${pid}/brief`, { goal: "这个项目的代号是 MANGO-5521。" });
    const ask = async (conversationId?: string) => (await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "根据项目说明，这个项目的代号是什么？只回复代号。", conversationId })).body.id as string;
    const conv = await ask();
    const data = async () => (await t.api("GET", `/api/conversations/${conv}/items`)).body;
    const reply = async () => {
      await t.waitFor(async () => (await data()).conversation.status === "idle", "turn", 120000);
      const d = await data();
      assert.deepEqual(d.items.filter((i: any) => i.type === "error").map((i: any) => i.data.message), []);
      return d.items.filter((i: any) => i.type === "assistant").at(-1).data.text as string;
    };
    assert.match(await reply(), /MANGO-5521/);
    await t.api("PUT", `/api/projects/${pid}/brief`, { goal: "这个项目的代号改成了 KIWI-8802。" });
    await ask(conv);
    assert.match(await reply(), /KIWI-8802/);
    t.close();
  });
}
