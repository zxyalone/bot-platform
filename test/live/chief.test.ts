// Real agents, cheap models, one pass: a one-line request through Chief, and the read-only boundary on both vendors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, tempHome } from "../helpers.ts";
import { realFactory } from "../../src/daemon/factory.ts";
import { CHIEF_ROLE } from "../../src/daemon/store.ts";

const idle = (t: any, id: string, ms = 240000) =>
  t.waitFor(async () => {
    const x = (await t.api("GET", `/api/conversations/${id}/items`)).body;
    return x.conversation.status === "idle" && x;
  }, "turn to finish", ms);

test("a one-line request goes through Chief into a worktree and can be merged", { timeout: 300000 }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "bot-live-repo-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...a], { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const t = await boot(realFactory, { home: tempHome() });
  const chief = t.store.createBot({ name: "Chief", role: CHIEF_ROLE, agent: "claude", model: "claude-sonnet-5-5", effort: "low", permission: "read_only", route: "official", budget_tokens: 120000, is_chief: 1, cwd: repo });
  await t.api("POST", "/api/bots", { name: "Eng", role: "你是工程师，按要求改文件，做完用一句话说明。", agent: "codex", model: "gpt-6-luna", effort: "low", permission: "auto_edit", can_call: [] });

  const conv = (await t.api("POST", `/api/bots/${chief.id}/messages`, { text: "在仓库里新建 hello.txt，内容是 hello。" })).body.id;
  const d: any = await idle(t, conv);
  const trace = (await t.api("GET", `/api/conversations/${conv}/trace`)).body;
  console.log("chief chain tokens:", trace.budget.spent, trace.calls.map((c: any) => `${c.from}->${c.to}:${c.status}:${c.tokens}`).join(" "));
  assert.deepEqual(d.items.filter((i: any) => i.type === "error").map((i: any) => i.data.message), []);
  assert.deepEqual(trace.calls.map((c: any) => [c.to, c.status]), [["Eng", "done"]]);
  assert.equal(existsSync(join(repo, "hello.txt")), false, "base branch untouched until merge");
  const [wt] = (await t.api("GET", `/api/conversations/${conv}/worktrees`)).body.worktrees;
  assert.ok(wt, "Chief used a worktree");
  assert.match(readFileSync(join(wt.path, "hello.txt"), "utf8"), /hello/);
  assert.equal((await t.api("POST", `/api/worktrees/${wt.id}/merge`, {})).status, 200);
  assert.match(readFileSync(join(repo, "hello.txt"), "utf8"), /hello/);
  t.close();
});

for (const [agent, model] of [["claude", "claude-sonnet-5-5"], ["codex", "gpt-6-luna"]]) {
  test(`${agent}: read-only cannot write, and asks nobody`, { timeout: 200000 }, async () => {
    const t = await boot(realFactory, { home: tempHome() });
    const cwd = mkdtempSync(join(tmpdir(), `bot-ro-${agent}-`));
    const bot = (await t.api("POST", "/api/bots", { name: "RO", role: "", agent, model, effort: "low", permission: "read_only", cwd, can_call: [] })).body;
    const conv = (await t.api("POST", `/api/bots/${bot.id}/messages`, { text: "请在当前工作目录创建文件 ro.txt，内容是 hello。现在就用工具做，失败了就告诉我。" })).body.id;
    const d: any = await idle(t, conv, 150000);
    const spent = (await t.api("GET", `/api/conversations/${conv}/trace`)).body.budget.spent;
    console.log(`${agent} read-only tokens:`, spent);
    assert.equal(existsSync(join(cwd, "ro.txt")), false);
    assert.equal(d.items.some((i: any) => i.type === "approval"), false);
    t.close();
  });
}
