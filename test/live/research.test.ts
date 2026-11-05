// Real agent, cheap model, one pass: role refinement, and an experiment that wakes its conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, tempHome } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { Memory } from "../../src/daemon/git.ts";
import { refineRole } from "../../src/daemon/refine.ts";
import { CHEAPEST } from "./cheap.ts";

const TRAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake_train.mjs");

test("AI refinement returns usable text and follows the draft", { timeout: 120000 }, async () => {
  const role = await refineRole({ name: "Writer", draft: "帮我写周报，语气平实，不要夸张", chief: false });
  console.log("refined:", role.slice(0, 120));
  assert.ok(role.length > 5);
  assert.match(role, /周报/);
});

test("an approved experiment runs in the background and its result wakes the agent", { timeout: 300000 }, async () => {
  const t = await boot(realFactory, { home: tempHome() });
  const cwd = mkdtempSync(join(tmpdir(), "bot-live-rs-"));
  const bot = (await t.api("POST", "/api/bots", { name: "R", role: "你负责跑实验。", agent: "claude", model: CHEAPEST.claude, effort: "low", permission: "read_only", cwd, budget_tokens: 80000, can_call: [] })).body;
  const pid = Memory.projectId(cwd);
  await t.api("PUT", `/api/projects/${pid}/settings`, { enabled: true });
  const command = `"${process.execPath}" "${TRAIN}"`;
  const conv = (await t.api("POST", `/api/bots/${bot.id}/messages`, { text: `用 run_experiment 提交一个实验，name 是 base，seed 是 1，command 是：${command}\n提交后结束本轮。收到平台通知后，只回复 dice 的数值。` })).body.id;

  const seen = new Set<string>();
  let done: any;
  await t.waitFor(async () => {
    const d = (await t.api("GET", `/api/conversations/${conv}/items`)).body;
    for (const i of d.items) {
      if (i.type === "approval" && i.status === "pending" && !seen.has(i.id)) {
        seen.add(i.id);
        await t.api("POST", `/api/approvals/${i.id}`, { decision: "allow" });
      }
    }
    const summaries = d.items.filter((i: any) => i.type === "turn_summary").length;
    if (d.conversation.status === "idle" && summaries >= 2) done = d;
    return done;
  }, "run and wake", 200000);

  const r = (await t.api("GET", `/api/projects/${pid}/research`)).body;
  const trace = (await t.api("GET", `/api/conversations/${conv}/trace`)).body;
  console.log("wake-turn tokens:", trace.budget.spent, "dice:", r.experiments[0]?.metrics?.dice);
  assert.deepEqual(done.items.filter((i: any) => i.type === "error").map((i: any) => i.data.message), []);
  assert.equal(r.experiments[0].status, "done");
  assert.equal(r.experiments[0].metrics.dice, 0.723);
  const last = done.items.filter((i: any) => i.type === "assistant").pop().data.text;
  assert.match(last, /0\.723/, "the woken agent read the script's number");
  t.close();
});
