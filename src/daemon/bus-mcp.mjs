#!/usr/bin/env node
// MCP server each agent launches for itself. It holds no logic: every call goes to the daemon,
// which identifies the caller from BUS_TOKEN and applies the limits there.
import http from "node:http";
import { createInterface } from "node:readline";

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const bot = { type: "string", description: "Bot 名称，来自 list_bots" };
const place = {
  isolated: { type: "boolean", description: "在新的 Git 工作树里做，改动互不影响。写代码时使用。回答里会带上路径和分支" },
  workspace: { type: "string", description: "在已有工作树里做（填它的路径），比如审查别人的改动，或接着改" },
};
const spec = {
  name: { type: "string" },
  role: { type: "string", description: "职责，写成对这个 Bot 说的话" },
  agent: { type: "string", enum: ["claude", "codex", "grok", "antigravity"] },
  model: { type: "string", enum: ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna", "grok-4.7", "grok-4.7-build-fast", "grok-4.6", "gemini-4-argon", "gemini-3.8-flash"] },
  effort: { type: "string", enum: ["low", "medium", "high"] },
  permission: { type: "string", enum: ["ask", "auto_edit", "read_only"] },
};
const tools = [
  { name: "list_bots", description: "列出你可以调用的 Bot，以及它们的职责。", inputSchema: { type: "object", properties: {} } },
  {
    name: "ask_bot",
    description: "向另一个 Bot 提问并等待它的回答。对方看不到你的对话，也看不到用户的原话，所以问题里要写清背景和需要的结论；文件请写路径，你们共用同一个工作目录。",
    inputSchema: { type: "object", properties: { bot, question: { type: "string" }, ...place }, required: ["bot", "question"] },
  },
  {
    name: "assign_task",
    description: "把任务交给另一个 Bot 并立刻返回 task_id，可以同时派给多个 Bot。结束本轮前必须用 get_task 取回结果，否则未完成的任务会被取消。用户能在任务中心看到它们。",
    inputSchema: {
      type: "object",
      properties: {
        bot,
        task: { type: "string" },
        depends_on: { type: "array", items: { type: "string" }, description: "要先完成的 task_id。这些任务完成后它才开始，并能看到它们的结论；其中一个没完成，它就不会开始" },
        timeout_seconds: { type: "number", description: "运行超过这么久就停止，等用户审批的时间不算。只能比平台设置的上限短" },
        ...place,
      },
      required: ["bot", "task"],
    },
  },
  {
    name: "remember",
    description: "记下以后还用得上的事。scope 为 bot 时只有你自己能看到，为 project 时这个工作目录的所有 Bot 都能看到。只记结论、偏好和踩过的坑，不要记过程。用户可以查看和回滚。",
    inputSchema: { type: "object", properties: { text: { type: "string" }, scope: { type: "string", enum: ["bot", "project"] } }, required: ["text", "scope"] },
  },
  { name: "recall", description: "读取完整的记忆。开头已经带了最近的内容，通常不需要调用。", inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["bot", "project"] } }, required: ["scope"] } },
  {
    name: "add_idea",
    description: "把新想法记进想法账本，返回 id，以及账本里相似的想法和它们的结论。提新方案前先用 list_ideas 查，不要重复提已经试过的方向。",
    inputSchema: { type: "object", properties: { title: { type: "string" }, hypothesis: { type: "string", description: "假设，以及怎样才算成立" }, source: { type: "string", description: "灵感来源" }, prior_work: { type: "string", description: "查重结果，已有的类似工作" } }, required: ["title"] },
  },
  {
    name: "update_idea",
    description: "更新想法。status 可设为 proposed、testing、rejected、parked。想法是否成立由用户确认，你只能用 suggested_verdict 提出 supported 或 not_supported，并写明 conclusion 和 failure_reason。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" }, suggested_verdict: { type: "string", enum: ["supported", "not_supported"] }, prior_work: { type: "string" }, conclusion: { type: "string" }, failure_reason: { type: "string" } }, required: ["id"] },
  },
  { name: "list_ideas", description: "列出这个项目的想法账本。", inputSchema: { type: "object", properties: {} } },
  {
    name: "run_experiment",
    description: "提交训练或评估。用户批准后在后台运行，平台自动记录代码版本、配置和种子。提交后结束本轮即可，不要等待或轮询：跑完平台会用指标唤醒对话。脚本把指标写成 JSON 数字到 $BOT_METRICS_FILE，配置在 $BOT_CONFIG_FILE，种子在 $BOT_SEED，分割结果放 $BOT_ARTIFACTS_DIR。不要碰测试集。同一方案多个种子时 name 保持相同。",
    inputSchema: { type: "object", properties: { name: { type: "string" }, command: { type: "string" }, idea_id: { type: "string" }, role: { type: "string", enum: ["baseline", "variant", "ablation"] }, seed: { type: "number" }, config: { type: "object" }, target: { type: "string", description: "计算目标，默认 local" } }, required: ["name", "command"] },
  },
  { name: "list_experiments", description: "列出实验和按名称汇总的指标（均值、标准差）。指标由脚本产生，结论要以它为准。", inputSchema: { type: "object", properties: { idea_id: { type: "string" } } } },
  { name: "get_experiment", description: "查看单个实验的状态、指标和日志结尾。", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "create_bot", description: "提议新建 Bot。会等用户批准后才返回。", inputSchema: { type: "object", properties: spec, required: ["name", "role", "agent", "model"] } },
  { name: "update_bot", description: "提议修改某个 Bot，只传要改的字段。会等用户批准后才返回。", inputSchema: { type: "object", properties: { bot, ...spec }, required: ["bot"] } },
  {
    name: "propose_plan",
    description: "把复杂任务的执行计划交给用户确认。步骤有 3 个以上、有依赖，或者会改很多文件时用它；简单任务不要用，直接做。用户可以改负责人、顺序、依赖和验收条件，也可以要求你重写。会等用户决定后才返回。批准后平台按依赖派出任务并返回每步的 task_id，你要用 get_task 取回结果，再逐条核对验收条件。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "这个计划要做成什么，一句话" },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "这一步的简短标识，depends_on 用它" },
              bot: { type: "string", description: "负责这一步的 Bot" },
              task: { type: "string", description: "要做什么。对方看不到用户的原话，要写清背景和要求" },
              acceptance: { type: "string", description: "怎么算做完，要能核对" },
              depends_on: { type: "array", items: { type: "string" }, description: "要先完成的步骤的 id。没有依赖的步骤会同时开始" },
              isolated: { type: "boolean", description: "写代码的步骤传 true，放进独立的 Git 工作树" },
            },
            required: ["id", "bot", "task"],
          },
        },
      },
      required: ["title", "tasks"],
    },
  },
  { name: "pause_bot", description: "暂停某个 Bot，暂停后其他 Bot 不能调用它。只有用户能恢复。", inputSchema: { type: "object", properties: { bot }, required: ["bot"] } },
  {
    name: "get_task",
    description: "查询 assign_task 的结果。wait_seconds 可让它最多等待这么多秒（上限 300）再返回，比反复查询省额度。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, wait_seconds: { type: "number" } }, required: ["task_id"] },
  },
];

function callDaemon(tool, args) {
  const url = new URL(process.env.BUS_URL);
  const body = JSON.stringify({ tool, args });
  return new Promise((resolve) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.BUS_TOKEN}`, "content-length": Buffer.byteLength(body) } },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (out += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve({ text: `总线返回了无法解析的内容（${res.statusCode}）`, isError: true });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ text: `连不上 Bot 总线：${e.message}`, isError: true }));
    req.end(body);
  });
}

const allowed = (process.env.BUS_TOOLS ?? "").split(",");
const visible = tools.filter((t) => allowed.includes(t.name));

createInterface({ input: process.stdin }).on("line", async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "botbus", version: "0.2.0" } } });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: visible } });
  } else if (m.method === "tools/call") {
    const r = await callDaemon(m.params?.name, m.params?.arguments ?? {});
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(r.text) }], isError: Boolean(r.isError) } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
  }
});
