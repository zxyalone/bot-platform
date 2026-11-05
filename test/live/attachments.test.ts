// Runs every real agent on its cheapest model and uses a little quota. `npm run test:live`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { CHEAPEST } from "./cheap.ts";
import type { AgentKind } from "../../src/daemon/types.ts";

for (const agent of Object.keys(CHEAPEST) as AgentKind[]) {
  test(`${agent}: can read a file the person attached`, { timeout: 200000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `bot-attach-${agent}-`));
    const t = await boot(realFactory);
    const bot = (await t.api("POST", "/api/bots", { name: "W", role: "回答尽量短。", agent, model: CHEAPEST[agent], effort: "low", permission: "read_only", cwd })).body;
    assert.ok(bot.id, JSON.stringify(bot));
    const up = await fetch(`${t.base}/api/uploads?name=${encodeURIComponent("暗号 记录.txt")}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "暗号是 PINEAPPLE-7341\n" }).then((r) => r.json()) as any;
    const conv = (await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "读取附件，告诉我暗号。只回复暗号本身。", attachments: [up.id] })).body.id as string;
    const data = async () => (await t.api("GET", `/api/conversations/${conv}/items`)).body;
    await t.waitFor(async () => (await data()).conversation.status === "idle", "turn", 150000);
    const d = await data();
    assert.deepEqual(d.items.filter((i: any) => i.type === "error").map((i: any) => i.data.message), []);
    const reply = d.items.filter((i: any) => i.type === "assistant").map((i: any) => i.data.text).join("\n");
    assert.match(reply, /PINEAPPLE-7341/, reply);
    t.close();
  });
}
