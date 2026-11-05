// Runs the real Claude Code and Codex with cheap models and uses a little quota. `npm run test:live`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { CHEAPEST } from "./cheap.ts";

const TURN_MS = 180000;
const CASES = [
  { agent: "claude", model: CHEAPEST.claude },
  { agent: "codex", model: CHEAPEST.codex },
];

async function until(t: any, convId: string, check: (d: any) => any, label: string) {
  return t.waitFor(async () => {
    const d = (await t.api("GET", `/api/conversations/${convId}/items`)).body;
    return check(d) && d;
  }, label, TURN_MS);
}
const idle = (d: any) => d.conversation.status === "idle";
const lastText = (d: any) => [...d.items].reverse().find((i: any) => i.type === "assistant")?.data.text ?? "";
const pendingApproval = (d: any) => d.items.find((i: any) => i.type === "approval" && i.status === "pending");
const failures = (d: any) => d.items.filter((i: any) => i.type === "error").map((i: any) => i.data.message);

for (const c of CASES) {
  test(`${c.agent}: chat, persona, approvals, restart and stop`, { timeout: 900000 }, async (tt) => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), `bot-live-${c.agent}-`));
    let t = await boot(realFactory, { home });
    const bot = (await t.api("POST", "/api/bots", { name: "Mira", role: "你的名字是 Mira。别人问你叫什么时，回答 Mira。", agent: c.agent, model: c.model, effort: "low", cwd })).body;
    const send = async (text: string, conversationId?: string) => {
      const r = await t.api("POST", `/api/bots/${bot.id}/messages`, { text, conversationId });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      return r.body.id as string;
    };
    let conv = "";

    await tt.test("streams a reply and reports usage", async () => {
      conv = await send("记住暗号 MAGNOLIA-7。请用五句话介绍一下语义分割，每句一行。");
      const d = await until(t, conv, idle, "first reply");
      assert.deepEqual(failures(d), []);
      assert.ok(lastText(d).length > 10, lastText(d));
      assert.ok(t.events.some((e: any) => e.type === "delta"), "text arrived as a stream");
      const sum = d.items.filter((i: any) => i.type === "turn_summary").pop();
      assert.equal(sum.status, "completed");
      assert.ok(sum.data.inputTokens > 0, "input tokens reported");
      assert.ok(sum.data.outputTokens > 0, "output tokens reported");
    });

    await tt.test("uses the Bot's persona", async () => {
      await send("你叫什么名字？只回答名字。", conv);
      const d = await until(t, conv, idle, "persona");
      assert.match(lastText(d), /Mira/i);
    });

    await tt.test("denied write: no file, and the agent keeps going", async () => {
      const file = join(cwd, "denied.txt");
      await send("请在当前工作目录创建文件 denied.txt，内容是 hello。现在就用工具做。", conv);
      const d = await until(t, conv, (x) => pendingApproval(x) || idle(x), "approval request");
      assert.equal(existsSync(file), false, "nothing is written before approval");
      // A model may occasionally decline without asking. The safety property is the file, checked below.
      const a = pendingApproval(d);
      if (a) await t.api("POST", `/api/approvals/${a.id}`, { decision: "deny" });
      else tt.diagnostic(`no approval requested: ${lastText(d)}`);
      const done = await until(t, conv, (x) => {
        const more = pendingApproval(x);
        // An agent may retry another way; every retry is denied too.
        if (more) void t.api("POST", `/api/approvals/${more.id}`, { decision: "deny" });
        return idle(x);
      }, "after deny");
      assert.equal(existsSync(file), false, "denied write did not happen");
      assert.deepEqual(failures(done), []);
    });

    await tt.test("allowed write: the file exists", async () => {
      const file = join(cwd, "allowed.txt");
      await send("这次允许了。请在当前工作目录创建文件 allowed.txt，内容是 hello。现在就用工具做。", conv);
      await until(t, conv, (x) => {
        const a = pendingApproval(x);
        if (a) void t.api("POST", `/api/approvals/${a.id}`, { decision: "allow" });
        return idle(x);
      }, "after allow");
      assert.equal(existsSync(file), true);
      assert.match(readFileSync(file, "utf8"), /hello/);
    });

    await tt.test("a restarted daemon resumes the session", async () => {
      t.close();
      t = await boot(realFactory, { home });
      await send("我之前让你记住的暗号是什么？只回答暗号。", conv);
      const d = await until(t, conv, idle, "resume");
      assert.deepEqual(failures(d).filter((m: string) => !m.includes("重启")), []);
      assert.match(lastText(d), /MAGNOLIA-7/);
    });

    await tt.test("stop ends a long reply, and the conversation still works", async () => {
      const convStop = await send("请从 1 开始逐行数到 3000，每行一个数字，不要省略，不要使用工具。");
      await t.waitFor(() => t.events.some((e: any) => e.type === "delta" && e.convId === convStop), "stream start", TURN_MS);
      const stopAt = Date.now();
      assert.equal((await t.api("POST", `/api/conversations/${convStop}/interrupt`, {})).status, 202);
      const d = await until(t, convStop, idle, "stopped");
      assert.ok(Date.now() - stopAt < 9500, `stopped in ${Date.now() - stopAt}ms`);
      assert.equal(d.items.filter((i: any) => i.type === "turn_summary").pop().status, "interrupted");
      assert.deepEqual(failures(d), []);
      await send("回复两个字：继续", convStop);
      const after = await until(t, convStop, idle, "after stop");
      assert.deepEqual(failures(after), []);
      assert.ok(lastText(after).length > 0);
    });

    t.close();
  });
}
