// A daemon with scripted agents, for trying the interface without spending any quota:
// `npm run demo`. Uses a temporary data directory and never starts a real agent.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createApp } from "../src/daemon/server.ts";
import { Store } from "../src/daemon/store.ts";
import type { AgentRuntime, ApprovalDecision, RuntimeOptions } from "../src/daemon/types.ts";

const port = Number(process.env.PORT || 4317);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bus(o: RuntimeOptions, tool: string, args: unknown): Promise<{ text: string }> {
  const body = JSON.stringify({ tool, args });
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/internal/bus", method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.bus!.env.BUS_TOKEN}` } }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d));
      res.on("end", () => resolve(JSON.parse(out)));
    });
    req.end(body);
  });
}

class Scripted implements AgentRuntime {
  readonly o: RuntimeOptions;
  private approve: ((d: ApprovalDecision) => void) | null = null;
  private stopped = false;
  constructor(o: RuntimeOptions) {
    this.o = o;
  }
  async start() {
    this.o.onEvent({ type: "session", sessionId: randomBytes(8).toString("hex") });
  }
  private async stream(text: string) {
    const key = randomBytes(4).toString("hex");
    for (const ch of text.match(/.{1,6}/gsu) ?? []) {
      if (this.stopped) return;
      this.o.onEvent({ type: "text_delta", key, text: ch });
      await wait(35);
    }
    this.o.onEvent({ type: "text_done", key, text });
  }
  async send(prompt: string) {
    this.stopped = false;
    void this.run(prompt);
  }
  private async run(prompt: string) {
    const e = this.o.onEvent;
    e({ type: "usage_tick", tokens: 2500 });
    const name = this.o.systemPrompt.match(/DEMO:(\w+)/)?.[1];
    if (name === "Chief") {
      if (/平台通知/.test(prompt)) {
        const m = prompt.match(/\{.*?\}/)?.[0] ?? "";
        await this.stream("实验结束了，指标是 `" + m + "`。我建议判定为不成立，请你在实验工作台确认。");
      } else if (/实验/.test(prompt)) {
        await this.stream("我先把这个想法记进账本，再跑一个基线和一个方案。");
        const idea = JSON.parse((await bus(this.o, "add_idea", { title: "边界感知损失", hypothesis: "细小结构的 Dice 提升 1 个点以上", source: "用户" })).text);
        const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake_train.mjs");
        await bus(this.o, "run_experiment", { name: "基线", role: "baseline", seed: 1, idea_id: idea.id, config: { shift: 0 }, command: `"${process.execPath}" "${fixture}" --sleep 2` });
        await this.stream("已提交。跑完平台会叫我。");
        await bus(this.o, "update_idea", { id: idea.id, suggested_verdict: "not_supported", conclusion: "脚本指标没有明显提升" });
      } else if (/建/.test(prompt)) {
        await this.stream("现在团队里没有专门读论文的 Bot，我提议新建一个。");
        const r = await bus(this.o, "create_bot", { name: "Scholar", role: "负责读论文和查重，只给有出处的结论。", agent: "claude", model: "claude-sonnet-5-5", effort: "low", permission: "read_only" });
        await this.stream(`结果：${r.text}`);
      } else {
        await this.stream("我把实现交给 Engineer，放在独立工作树里做。");
        const r = await bus(this.o, "ask_bot", { bot: "Engineer", question: "实现边界损失函数，写到 boundary_loss.py。", isolated: true });
        await bus(this.o, "remember", { scope: "project", text: "边界损失放在 boundary_loss.py" });
        await this.stream(`做好了，等你验收。\n\n${r.text}`);
      }
    } else if (name === "Engineer" && /工作树/.test(prompt)) {
      writeFileSync(join(this.o.cwd, "boundary_loss.py"), "def boundary_loss(pred, target):\n    return 0.0\n");
      await this.stream("已写好 `boundary_loss.py`。");
    } else if (name === "Engineer" && /来自同事/.test(prompt) === false && /审查|写/.test(prompt)) {
      await this.stream("我先写好实现，再请 Reviewer 审查。");
      e({ type: "tool", key: "t1", title: "写入 boundary_loss.py", detail: "def boundary_loss(pred, target): ...", status: "running" });
      e({ type: "approval", requestId: "demo-1", title: "写入 boundary_loss.py", detail: "路径：boundary_loss.py\n\ndef boundary_loss(pred, target):\n    ...", canRemember: true });
      const d = await new Promise<ApprovalDecision>((r) => (this.approve = r));
      e({ type: "tool", key: "t1", title: "", output: d === "deny" ? "已拒绝" : "已写入", status: d === "deny" ? "failed" : "done" });
      if (this.stopped) return;
      const review = await bus(this.o, "ask_bot", { bot: "Reviewer", question: "请审查 boundary_loss.py，重点看类别不平衡时的表现。" });
      await this.stream(`Reviewer 的结论：\n\n> ${review.text}\n\n我会按建议修改。`);
    } else if (name === "Reviewer") {
      await wait(500);
      await this.stream("发现一个问题：`pred` 全空时分母为 0，需要加 `eps`。\n\n| 严重度 | 位置 |\n|---|---|\n| 高 | 第 2 行 |");
    } else {
      await this.stream(`我是 ${name ?? "Bot"}。这是脚本回复，用来试界面，没有消耗额度。`);
    }
    if (this.stopped) return;
    e({ type: "usage", inputTokens: 12000, cachedTokens: 8000, outputTokens: 400, costTotalUsd: undefined });
    e({ type: "turn_end", status: "completed" });
  }
  async interrupt() {
    this.stopped = true;
    this.approve?.("deny");
    this.o.onEvent({ type: "turn_end", status: "interrupted" });
  }
  answerApproval(_: string, d: ApprovalDecision) {
    this.approve?.(d);
  }
  stop() {
    this.stopped = true;
  }
}

const store = new Store(mkdtempSync(join(tmpdir(), "bot-demo-")));
const a = store.createBot({ name: "Engineer", role: "写代码。DEMO:Engineer", agent: "codex", model: "gpt-6.1-terra", effort: "medium", permission: "ask", route: "official" });
const b = store.createBot({ name: "Reviewer", role: "审查代码。DEMO:Reviewer", agent: "claude", model: "claude-sonnet-5-5", effort: "medium", permission: "ask", route: "official" });
store.createGroup({ name: "方案评审", members: [a.id, b.id] });
const repo = mkdtempSync(join(tmpdir(), "bot-demo-repo-"));
const run = (...args: string[]) => execFileSync("git", args, { cwd: repo });
run("init", "-q", "-b", "main");
writeFileSync(join(repo, "README.md"), "demo\n");
run("add", "-A");
run("-c", "user.name=demo", "-c", "user.email=demo@localhost", "commit", "-q", "-m", "init");
store.createBot({ name: "Chief", role: "调度。DEMO:Chief", agent: "claude", model: "claude-opus-5-5", effort: "medium", permission: "read_only", route: "official", budget_tokens: 300000, is_chief: 1, cwd: repo });

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = createApp({
  store,
  factory: (o) => new Scripted(o),
  webDir: join(root, "src", "web"),
  port: () => port,
  status: async () => ({ claude: { installed: true, loggedIn: true, models: ["claude-opus-5-5", "claude-sonnet-5-5"] }, codex: { installed: true, loggedIn: true, models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna"] }, grok: { installed: true, loggedIn: true, models: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"] }, antigravity: { installed: true, loggedIn: true, models: ["gemini-4-argon", "gemini-3.8-flash"] } }),
});
app.server.listen(port, "127.0.0.1", () => console.log(`Demo: http://127.0.0.1:${port}`));
