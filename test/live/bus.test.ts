// One real chain, Claude -> Codex -> Claude, proving both adapters attach the bus. Kept to low effort and a hard budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { CHEAPEST } from "./cheap.ts";

test("a real chain across vendors returns the right answer and is traced", { timeout: 300000 }, async () => {
  const t = await boot(realFactory, { home: tempHome() });
  const cwd = mkdtempSync(join(tmpdir(), "bot-chain-"));
  const mk = async (name: string, agent: string, model: string, role: string, can_call: string[] | null) =>
    (await t.api("POST", "/api/bots", { name, role, agent, model, effort: "low", cwd, budget_tokens: 120000, can_call })).body;
  const leaf = await mk("Leaf", "claude", CHEAPEST.claude, "你负责算术，只回答数字。", []);
  const mid = await mk("Mid", "codex", CHEAPEST.codex, "你负责转交算术题，用 ask_bot 问 Leaf，再把结果告诉对方。", [leaf.id]);
  const top = await mk("Top", "claude", CHEAPEST.claude, "你负责协调。", [mid.id]);
  const [a, b] = [100 + Math.floor(Math.random() * 900), 100 + Math.floor(Math.random() * 900)];

  const conv = (await t.api("POST", `/api/bots/${top.id}/messages`, { text: `请用 ask_bot 问 Mid：${a} 乘以 ${b} 等于多少？（Mid 会去问 Leaf。）只把最终数字告诉我。` })).body.id;
  const d: any = await t.waitFor(async () => {
    const x = (await t.api("GET", `/api/conversations/${conv}/items`)).body;
    return x.conversation.status === "idle" && x;
  }, "chain to finish", 240000);

  const trace = (await t.api("GET", `/api/conversations/${conv}/trace`)).body;
  console.log("tokens spent:", trace.budget.spent, "calls:", trace.calls.map((c: any) => `${c.from}->${c.to}:${c.status}:${c.tokens}`).join(" "));
  assert.deepEqual(d.items.filter((i: any) => i.type === "error").map((i: any) => i.data.message), []);
  assert.deepEqual(trace.calls.map((c: any) => [c.from, c.to, c.status]), [["Top", "Mid", "done"], ["Mid", "Leaf", "done"]]);
  const final = d.items.filter((i: any) => i.type === "assistant").pop().data.text.replace(/[,，\s]/g, "");
  assert.ok(final.includes(String(a * b)), final);
  t.close();
});
