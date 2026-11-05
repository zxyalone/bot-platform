// Real Grok Build and Antigravity on their cheapest models, one pass: role, bus, auto-edit, resume and read-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { CHEAPEST } from "./cheap.ts";

const CASES = [
  { agent: "grok", model: CHEAPEST.grok },
  { agent: "antigravity", model: CHEAPEST.antigravity },
];

async function turn(t: any, botId: string, text: string, conversationId?: string) {
  const conv = (await t.api("POST", `/api/bots/${botId}/messages`, { text, conversationId })).body.id;
  const before = conversationId ? (await t.api("GET", `/api/conversations/${conv}/items`)).body.items.length : 0;
  const approvals: string[] = [];
  const seen = new Set<string>();
  const d: any = await t.waitFor(async () => {
    const x = (await t.api("GET", `/api/conversations/${conv}/items`)).body;
    for (const i of x.items) {
      if (i.type === "approval" && i.status === "pending" && !seen.has(i.id)) {
        seen.add(i.id);
        approvals.push(i.data.title);
        await t.api("POST", `/api/approvals/${i.id}`, { decision: "allow" });
      }
    }
    return x.conversation.status === "idle" && x.items.length > before + 1 && x;
  }, "turn", 150000);
  const reply = d.items.filter((i: any) => i.type === "assistant").pop()?.data.text ?? "";
  const errors = d.items.filter((i: any) => i.type === "error").map((i: any) => i.data.message);
  const tools = d.items.filter((i: any) => i.type === "tool").map((i: any) => `${i.status}:${i.data.title}`);
  return { conv, reply, errors, approvals, tools, summary: d.items.filter((i: any) => i.type === "turn_summary").pop() };
}

for (const c of CASES) {
  test(`${c.agent}: role, bus, auto-edit, resume and read-only`, { timeout: 500000 }, async () => {
    const trace = join(tmpdir(), `bot-acp-trace-${c.agent}.jsonl`);
    rmSync(trace, { force: true });
    process.env.BOT_ACP_TRACE = trace;
    const t = await boot(realFactory, { home: tempHome() });
    const cwd = mkdtempSync(join(tmpdir(), `bot-acp-${c.agent}-`));
    const base = { agent: c.agent, model: c.model, effort: "low", cwd };
    await t.api("POST", "/api/bots", { ...base, name: "Colleague", role: "同事。", can_call: [] });
    const bot = (await t.api("POST", "/api/bots", { ...base, name: "Mira", role: "你的名字是 Mira。", permission: "auto_edit" })).body;

    const a = await turn(t, bot.id, "你叫什么？再用 list_bots 工具查一下团队里有谁。回复里写出你的名字和查到的 Bot 名字。");
    console.log(c.agent, "bus turn:", JSON.stringify({ reply: a.reply.slice(0, 100), tools: a.tools, approvals: a.approvals, usage: a.summary.data }));
    assert.deepEqual(a.errors, []);
    assert.match(a.reply, /Mira/);
    assert.match(a.reply, /Colleague/, "the bus tool really ran");
    assert.ok(a.summary.data.inputTokens > 0, "usage is reported");

    const b = await turn(t, bot.id, "在当前工作目录创建文件 hello.txt，内容是 hello。现在就用工具做。", a.conv);
    console.log(c.agent, "write turn:", JSON.stringify({ reply: b.reply.slice(0, 80), tools: b.tools, approvals: b.approvals }));
    assert.deepEqual(b.errors, []);
    assert.match(readFileSync(join(cwd, "hello.txt"), "utf8"), /hello/);

    const ro = (await t.api("POST", "/api/bots", { ...base, name: "Reader", role: "", permission: "read_only", can_call: [] })).body;
    const e = await turn(t, ro.id, "在当前工作目录创建文件 ro.txt，内容是 hello。现在就用工具做，失败了就告诉我。");
    console.log(c.agent, "read-only turn:", JSON.stringify({ reply: e.reply.slice(0, 80), tools: e.tools, approvals: e.approvals }));
    assert.equal(existsSync(join(cwd, "ro.txt")), false, "read-only blocked the write");
    assert.deepEqual(e.approvals, []);
    if (existsSync(trace)) console.log(c.agent, "permission requests:\n" + readFileSync(trace, "utf8").split("\n").map((l) => l.slice(0, 300)).join("\n"));
    delete process.env.BOT_ACP_TRACE;
    t.close();
  });
}
