// Runs real agents on their cheapest models and uses a little quota. `npm run test:live`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { ensureSeedBots, Store } from "../../src/daemon/store.ts";
import { CHEAPEST } from "./cheap.ts";

test("a new workspace's real Chief works with its own Engineer, not the default one", { timeout: 300000 }, async () => {
  const home = tempHome();
  const seed = new Store(home);
  ensureSeedBots(seed);
  seed.close();
  const t = await boot(realFactory, { home });
  const cwd = join(mkdtempSync(join(tmpdir(), "bot-live-ws-")), "project");
  const made = await t.api("POST", "/api/workspaces", { name: "实测", cwd, goal: "这个工作空间的代号是 PEACH-1188。", bots: [{ key: "chief", agent: "claude", model: CHEAPEST.claude }, { key: "engineer", agent: "codex", model: CHEAPEST.codex }] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.ok(existsSync(join(cwd, ".git")));
  const chief = made.body.bots[0];
  const conv = (await t.api("POST", `/api/bots/${chief.id}/messages`, { text: "用 ask_bot 问 Engineer：这个工作空间的代号是什么？它应该回答项目说明里的代号。把它的回答告诉我。" })).body.id as string;
  const d: any = await t.waitFor(async () => {
    const x = (await t.api("GET", `/api/conversations/${conv}/items`)).body;
    for (const i of x.items) if (i.type === "approval" && i.status === "pending") await t.api("POST", `/api/approvals/${i.id}`, { decision: "allow" });
    return x.conversation.status === "idle" && x;
  }, "round end", 200000);
  assert.deepEqual(d.items.filter((i: any) => i.type === "error").map((i: any) => i.data.message), []);
  const calls = (await t.api("GET", `/api/conversations/${conv}/trace`)).body.calls;
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((c: any) => c.to === "Engineer" && c.status === "done"), JSON.stringify(calls));
  const child = t.store.db.prepare("SELECT c.cwd FROM calls k JOIN conversations c ON c.id=k.child_conv_id WHERE k.root_conv_id=?").get(conv) as any;
  assert.equal(child.cwd, cwd, "the workspace's Engineer, in the workspace's directory");
  const reply = d.items.filter((i: any) => i.type === "assistant").map((i: any) => i.data.text).join("\n");
  assert.match(reply, /PEACH-1188/);
  t.close();
});
