// Runs the real agents with a cheap model and uses a little quota. `npm run test:live`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";

const CASES = [
  { agent: "claude", model: "claude-sonnet-5-5" },
  { agent: "codex", model: "gpt-6-luna" },
];

for (const c of CASES) {
  test(`${c.agent}: a steer joins the running turn, and the card reports what really happened`, { timeout: 300000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `bot-steer-${c.agent}-`));
    const run = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd });
    run("init", "-q");
    writeFileSync(join(cwd, "a.txt"), "1\n");
    run("add", "-A");
    run("commit", "-qm", "first");
    const t = await boot(realFactory);
    const bot = (await t.api("POST", "/api/bots", { name: "S", role: "照用户说的做，不要多做别的。", agent: c.agent, model: c.model, effort: "low", permission: "auto_edit", cwd })).body;
    const conv = (await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "用 shell 运行这条命令：sleep 8 && echo hi > steer.txt 。运行完用一句话告诉我。" })).body.id as string;
    const data = async () => (await t.api("GET", `/api/conversations/${conv}/items`)).body;
    const approve = async (d: any) => {
      for (const i of d.items) if (i.type === "approval" && i.status === "pending") await t.api("POST", `/api/approvals/${i.id}`, { decision: "allow" });
    };
    let steered = "";
    await t.waitFor(async () => {
      const d = await data();
      await approve(d);
      if (!steered && d.items.some((i: any) => i.type === "tool" && i.status === "running" && i.data.command)) steered = (await t.api("POST", `/api/conversations/${conv}/followup`, { text: "补充：你最后那句话里请包含 BANANA 这个词。", mode: "steer" })).body.delivered;
      return d.conversation.status === "idle" && d;
    }, "turn end", 200000);
    const d = await data();
    const errors = d.items.filter((i: any) => i.type === "error").map((i: any) => i.data.message);
    assert.deepEqual(errors, []);
    assert.equal(steered, "steered");
    assert.ok(existsSync(join(cwd, "steer.txt")));
    const replies = d.items.filter((i: any) => i.type === "assistant").map((i: any) => i.data.text).join("\n");
    assert.match(replies, /BANANA/, replies);
    assert.equal((t.store.db.prepare("SELECT COUNT(*) n FROM root_turns WHERE conv_id=?").get(conv) as any).n, 1, "no second round");
    const card: any = await t.waitFor(async () => (await data()).items.find((i: any) => i.type === "result"), "card", 5000);
    assert.deepEqual(card.data.files, [{ path: "steer.txt", change: "新增" }]);
    t.close();
  });
}
