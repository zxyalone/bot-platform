# Bot Platform

一个本地 Bot 工作台。每个 Bot 有自己的名字和职责，底层调用你已登录的官方 agent。

它不限任务类型，可以写代码、调研、写作、分析或别的事。把需求交给主 Bot Chief，它会拆解并派给合适的 Bot。

- **Bot 和群聊：** 私聊或群聊 @，Bot 之间可以互相调用，有调用链和预算控制。底层支持 Claude Code、Codex、Grok Build 和 Antigravity。
- **角色：** 每个 Bot 包括 Chief 的角色都可以自己写，再点“AI 完善”润色，确认后才保存。
- **订阅额度：** 左下角显示各家订阅的剩余额度，查询不消耗 token。
- **设置：** 左下角进入，包括外观（主题、强调色、字号、间距）、新建默认值、运行限制、Agent 与额度、计算目标。改动立即保存。
- **记忆和工作树：** 长期记忆可回滚，写代码的任务可以放进独立的 Git 工作树。
- **实验工作台（可选）：** 给需要跑长任务的项目用，按工作目录开启，默认关闭。

想试界面又不想消耗额度，可以运行 `npm run demo`：它使用脚本 agent 和临时数据目录，不会启动真实 agent。

## 运行

需要 Node.js 24 及以上，以及已登录的 agent 命令（`claude`、`codex`、`grok`、`agy`，用哪个装哪个）。不需要安装其他依赖。

```bash
npm start
```

然后打开 http://127.0.0.1:4317 。可以用 `PORT` 改端口，用 `BOT_PLATFORM_HOME` 改数据目录（默认是项目下的 `.data`）。

## 测试

```bash
npm test
```

```bash
npm run test:live
```

`test:live` 会调用真实的 Claude Code 和 Codex，消耗少量额度。

## 结构

- `src/daemon/adapters/`：把 Claude Code 的 `stream-json` 和 Codex 的 `app-server` 协议统一成同一组事件。Codex 的 `app-server` 目前标记为实验性，升级 Codex 后要重跑 `test:live`。
- `src/daemon/engine.ts`：对话和回合的状态、审批、中断、重启恢复。
- `src/daemon/server.ts`：本机 HTTP 接口和事件流。只监听 127.0.0.1，并拒绝其他网站发来的请求。
- `src/daemon/store.ts`：SQLite 存储。归档只是隐藏，不会删除数据。
- `src/web/`：无构建步骤的前端页面。

## 行为说明

- 一个对话的底层 agent、路由和工作目录在创建时固定。之后改 Bot 的模型、强度或职责，会在下一条消息时生效。
- 权限设为“每次询问”时，Codex 连只读命令也可能要确认。觉得频繁可以改成“自动改文件（工作目录）”。这个模式下，Codex 的沙箱还允许写系统临时目录；写到其他位置会被拦下或询问。
- 群聊必须 @ 成员才会触发回复。一次 @ 多个时依次回复，Bot 的回复里写 @ 不会触发别人，要协作请用总线工具。
- Bot 通过 `list_bots`、`ask_bot`、`assign_task`、`get_task` 互相调用，共用调用方的工作目录。被调用方的审批卡会出现在你正在看的对话里。
- 单轮限制：调用深度 3 层、调用 10 次、同时进行 3 个，不能调用自己或调用链上已有的 Bot。
- 预算按一条用户消息引发的整个调用树计算，只算未缓存的输入和输出。超出后整条链自动暂停，再发一条消息会开始新的一轮。
- Chief 默认用 Opus 5.5，权限为只读。它只能提议新建或修改 Bot，你批准后才生效。觉得贵可以把它改成 Sonnet。群聊里有 Chief 时，没有 @ 任何人的消息会交给它。
- 记忆放在 `.data/memory`，每个 Bot 和每个工作目录各一个 Git 仓库，可以在右侧面板查看、修改和回滚。启动 agent 时每份最多读入最近 3000 字，并标明只是参考资料。
- Bot 用 `isolated` 在工作树里工作，工作树放在 `.data/worktrees`，基于仓库当前分支的最新提交，未提交的改动不会带进去。合并由你在右侧面板操作，原仓库有未提交改动时会拒绝，有冲突时会撤销合并并保留工作树。
- 模型可能谎报完成。工作树任务结束时，平台会用 Git 检查实际改动，并附在回答末尾。
- 额度数据优先来自本机运行的 Magpie（`/v1/magpie/quotas`），能看到它管理的所有订阅。Magpie 没开时只能读到 Codex 的官方额度。
- “AI 完善”用 Sonnet 低强度做一次无工具调用（Claude 不可用时改用 Codex Luna），会消耗少量 token。
- Grok Build 和 Antigravity 走 ACP，权限由平台统一判断：只读模式拒绝一切写入和命令，未知类型的工具按写入处理。它们的角色说明随每次启动后的第一条消息发送。用量要到一轮结束才知道，所以这两家的预算只能在一轮结束后检查，不能中途打断。
- 费用是 agent 上报的估算值。使用订阅时不一定等于实际扣费。

## 实验工作台

在右侧面板开启后，Bot 多出 `add_idea`、`update_idea`、`list_ideas`、`run_experiment`、`list_experiments`、`get_experiment` 这几个工具。关闭时这些工具不会发给 agent。

- **运行：** `run_experiment` 要你批准，然后在后台独立运行，守护进程重启也不受影响。结束后平台用指标唤醒对话（可以在设置里关闭）。默认在本机运行，也可以在设置里添加 SSH 计算目标。
- **记录：** 平台自动记录代码版本、未提交的改动（`code.diff`）、配置和种子。同名实验按种子汇总均值和标准差。
- **想法账本：** Bot 只能建议判定，想法是否成立由你确认。
- **测试集闸门：** 最终评估只能由你在界面上发起，结果不会告诉 Bot，每次都会计数。这是防误用，不是硬隔离：能读文件的 agent 如果自己找到路径，平台拦不住。

训练脚本的约定：

| 环境变量 | 用途 |
|---|---|
| `BOT_METRICS_FILE` | 把指标写成 JSON 数字，例如 `{"dice": 0.81}` |
| `BOT_CONFIG_FILE` | 读取配置 |
| `BOT_SEED` | 随机种子 |
| `BOT_ARTIFACTS_DIR` | 放结果文件 |
| `BOT_TEST_DIR`、`BOT_TRAIN_RUN_DIR` | 仅最终评估时提供 |

要在“结果”页对比分割结果，在 `BOT_ARTIFACTS_DIR` 写一个 `manifest.json`，图片用 PNG、JPG 或 WebP（路径相对于这个目录）：

```json
{"cases": [{"id": "case-1", "image": "cases/1_img.png", "label": "cases/1_gt.png", "pred": "cases/1_pred.png", "metrics": {"dice": 0.72}}]}
```
