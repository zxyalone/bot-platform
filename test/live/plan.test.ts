// Runs every real agent on its cheapest model and uses a little quota. `npm run test:live`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { Store } from "../../src/daemon/store.ts";
import { CHEAPEST } from "./cheap.ts";
import type { AgentKind } from "../../src/daemon/types.ts";

for (const agent of Object.keys(CHEAPEST) as AgentKind[]) {
  test(`${agent}: Chief proposes a plan with the real tool, and the person's edit is what runs`, { timeout: 300000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `bot-plan-${agent}-`));
    const home = tempHome();
    const seed = new Store(home);
    const chief = seed.createBot({ name: "Chief", role: "你负责调度，回答尽量短。", agent, model: CHEAPEST[agent], effort: "low", permission: "auto_edit", route: "official", is_chief: 1, cwd, budget_tokens: 500000 });
    seed.createBot({ name: "Worker", role: "照要求做，只回复要求的词。", agent, model: CHEAPEST[agent], effort: "low", permission: "read_only", route: "official", cwd });
    seed.close();
    const t = await boot(realFactory, { home });
    const conv = (await t.api("POST", `/api/bots/${chief.id}/messages`, { text: "现在调用 propose_plan 工具提交计划：标题“测试”，两步。第一步 id 是 a，bot 是 Worker，task 是“只回复 ONE”。第二步 id 是 b，bot 是 Worker，task 是“只回复 TWO”，depends_on 是 a。批准后用 get_task 取回两步的结果，最后把结果告诉我。" })).body.id as string;
    const data = async () => (await t.api("GET", `/api/conversations/${conv}/items`)).body;
    const card: any = await t.waitFor(async () => {
      const d = await data();
      return d.items.find((i: any) => i.data.kind === "plan" && i.status === "pending") ?? (d.conversation.status === "idle" && { missing: true });
    }, "plan card", 120000);
    assert.ok(!card.missing, "Chief did not call the tool");
    assert.deepEqual(card.data.tasks.map((s: any) => s.bot), ["Worker", "Worker"]);
    const tasks = card.data.tasks.map((s: any) => (s.id === "b" ? { ...s, task: "只回复 THREE", acceptance: "" } : s));
    assert.equal((await t.api("POST", `/api/approvals/${card.id}`, { decision: "allow", spec: { tasks } })).status, 200);
    await t.waitFor(async () => (await data()).conversation.status === "idle", "round end", 200000);
    const all = (await t.api("GET", "/api/tasks")).body.tasks;
    assert.equal(all.length, 2, JSON.stringify(all.map((x: any) => x.question)));
    assert.deepEqual(all.map((x: any) => x.status), ["done", "done"], JSON.stringify(all.map((x: any) => x.failure_reason)));
    const answers = all.map((x: any) => x.answer).join(" ");
    assert.match(answers, /ONE/);
    assert.match(answers, /THREE/, "the edit is what ran");
    assert.doesNotMatch(answers, /TWO/);
    t.close();
  });
}
