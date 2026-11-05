// The settings page. Every change saves at once; appearance also applies at once.
import { icon } from "./icons.js";

const ACCENTS = [["indigo", "靛蓝"], ["violet", "紫"], ["teal", "青"], ["green", "绿"], ["amber", "琥珀"], ["rose", "玫红"]];
const TABS = [["appearance", "外观"], ["defaults", "新建默认值"], ["limits", "运行限制"], ["agents", "Agent 与额度"], ["targets", "计算目标"], ["data", "数据"]];
const LOGIN_HINT = { claude: "claude auth login", codex: "codex login", grok: "grok login", antigravity: "agy acp --login" };

export function mountSettings(root, ctx) {
  const { api, h, onBack, applyAppearance, agentLabel, permissionLabel, getAgents, getQuota, refreshQuota, resetLabel } = ctx;
  const ui = { tab: "appearance", data: null, targets: [], error: null, saved: false };
  let savedTimer = 0;

  async function load() {
    try {
      const [data, targets] = await Promise.all([api("/api/settings"), api("/api/targets")]);
      ui.data = data;
      ui.targets = targets.targets;
    } catch (e) {
      ui.error = e.message;
    }
    draw();
  }

  async function save(patch) {
    try {
      ui.error = null;
      ui.data.settings = (await api("/api/settings", { method: "PUT", body: patch })).settings;
      applyAppearance(ui.data.settings);
      ui.saved = true;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => {
        ui.saved = false;
        drawStatus();
      }, 1800);
    } catch (e) {
      ui.error = e.message;
    }
    draw();
  }

  const s = () => ui.data.settings;

  const row = (label, hint, control) => h("div", { class: "set-row" }, h("div", { class: "set-label" }, h("span", {}, label), hint ? h("span", { class: "set-hint" }, hint) : null), h("div", { class: "set-control" }, control));

  const segmented = (key, options, label) =>
    h(
      "div",
      { class: "segmented", role: "radiogroup", "aria-label": label },
      options.map(([v, t]) => h("button", { type: "button", role: "radio", "aria-checked": s()[key] === v ? "true" : "false", class: s()[key] === v ? "on" : "", onclick: () => save({ [key]: v }) }, t)),
    );

  const select = (key, options, label) => {
    const el = h("select", { "aria-label": label, onchange: (e) => save({ [key]: e.target.value }) }, options.map(([v, t]) => h("option", { value: v }, t)));
    el.value = s()[key];
    return el;
  };

  // Saves when the field is left, not on every keystroke.
  const number = (key, label, min, max, step = 1) => h("input", { type: "number", class: "num", "aria-label": label, min, max, step, value: String(s()[key]), onchange: (e) => save({ [key]: Number(e.target.value) }) });

  const toggle = (key, label) => h("button", { type: "button", role: "switch", "aria-checked": s()[key] ? "true" : "false", "aria-label": label, class: `switch${s()[key] ? " on" : ""}`, onclick: () => save({ [key]: !s()[key] }) }, h("span", {}));

  const group = (title, ...rows) => h("section", { class: "set-group" }, title ? h("h2", {}, title) : null, h("div", { class: "set-card" }, rows.flat().filter(Boolean)));

  function appearance() {
    return [
      group(
        "主题",
        row("外观模式", null, segmented("theme", [["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]], "外观模式")),
        row(
          "强调色",
          null,
          h(
            "div",
            { class: "swatches", role: "radiogroup", "aria-label": "强调色" },
            ACCENTS.map(([v, t]) => h("button", { type: "button", role: "radio", "aria-checked": s().accent === v ? "true" : "false", "aria-label": t, title: t, class: `swatch accent-${v}${s().accent === v ? " on" : ""}`, onclick: () => save({ accent: v }) }, s().accent === v ? icon("check", 14) : null)),
          ),
        ),
      ),
      group(
        "布局",
        row("字号", null, segmented("font", [["small", "小"], ["medium", "标准"], ["large", "大"]], "字号")),
        row("间距", null, segmented("density", [["comfortable", "舒适"], ["compact", "紧凑"]], "间距")),
        row("消息宽度", null, segmented("width", [["normal", "标准"], ["wide", "宽"]], "消息宽度")),
        row("右侧信息栏", "窄屏下始终隐藏", toggle("details_open", "显示右侧信息栏")),
      ),
    ];
  }

  function defaults() {
    const agents = Object.keys(getAgents());
    return [
      group(
        "新建 Bot 时预填",
        row("底层 agent", null, select("default_agent", agents.map((a) => [a, agentLabel[a]]), "默认底层 agent")),
        row("强度", null, segmented("default_effort", [["low", "低"], ["medium", "中"], ["high", "高"]], "默认强度")),
        row("权限", "Chief 提议新 Bot 时，也按这里补全没写的项", select("default_permission", Object.entries(permissionLabel), "默认权限")),
      ),
      group("新建群聊时预填", row("每轮预算", "tokens，不含缓存", number("default_budget_group", "群聊每轮预算", 1000, 50000000, 1000))),
    ];
  }

  function limits() {
    return [
      group(
        "Bot 互相调用",
        row("调用深度", "A 调 B、B 再调 C，算 2 层", number("max_depth", "调用深度", 1, 10)),
        row("单轮调用次数", "一条消息最多引发多少次调用", number("max_calls", "单轮调用次数", 1, 100)),
        row("同时进行", "超过时新的调用会被拒绝", number("max_active", "同时进行的调用", 1, 10)),
        row("任务超时", "分钟。后台任务运行超过这么久就停止，Bot 只能设得更短，等你审批的时间不算。0 表示不限", number("task_timeout_minutes", "任务超时分钟数", 0, 1440)),
      ),
      group("全局", row("同时运行的 agent", "所有对话加起来。满了之后新消息会被拒绝，排队的消息和后台任务继续等。主 Bot 等后台任务时不占调用名额，所以峰值可能略高", number("max_global_active", "同时运行的 agent", 1, 50))),
      group(
        "通知",
        row("完成与待处理通知", "窗口不在前台时提醒：任务完成、失败、等你批准、预算快用完。页面关掉就收不到。可以在每个项目的预算设置里静音", toggle("notify_enabled", "完成与待处理通知")),
        row(
          "浏览器权限",
          !("Notification" in window) ? "这个浏览器不支持系统通知" : Notification.permission === "granted" ? "已允许" : Notification.permission === "denied" ? "已被拒绝，需要在浏览器的网站设置里打开" : "还没有允许",
          "Notification" in window && Notification.permission === "default" ? h("button", { type: "button", onclick: () => Notification.requestPermission().then(draw) }, "允许通知") : null,
        ),
      ),
      group("进程", row("空闲回收", "分钟。agent 进程空闲这么久后关闭，下次发消息时自动恢复会话", number("idle_minutes", "空闲回收分钟数", 1, 1440))),
      h("p", { class: "set-note" }, "调高这些限制会让一条消息可能花掉更多额度。预算在“新建默认值”和每个 Bot 的设置里调整。"),
    ];
  }

  function agentsTab() {
    const quota = getQuota();
    const installed = getAgents();
    const accounts = quota?.accounts ?? [];
    const cards = Object.entries(installed).map(([key, a]) => {
      const mine = accounts.filter((x) => x.provider === key);
      const state = !a.installed ? ["未安装", "bad"] : !a.loggedIn ? ["未登录", "warn"] : ["可用", "ok"];
      return h(
        "div",
        { class: "agent-card" },
        h("div", { class: "agent-head" }, h("strong", {}, agentLabel[key] ?? key), h("span", { class: `pill ${state[1]}` }, state[0]), a.version ? h("span", { class: "set-hint" }, `版本 ${a.version}`) : null),
        a.installed && !a.loggedIn ? h("p", { class: "set-hint" }, "在终端登录：", h("code", {}, LOGIN_HINT[key] ?? "")) : null,
        h("p", { class: "set-hint" }, `模型：${(a.models ?? []).join("、")}`),
        mine.flatMap((acc) =>
          acc.windows.slice(0, 6).map((w) => {
            const pct = Math.round(w.remaining);
            const fill = h("div", { class: `bar-fill${pct <= s().low_quota ? " low" : ""}` });
            fill.style.width = `${pct}%`;
            return h("div", { class: "agent-quota" }, h("span", { class: "agent-quota-name" }, w.name), h("div", { class: "bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": w.name }, fill), h("span", { class: "set-hint" }, `${pct}%  ${resetLabel(w.resetsAt)}`));
          }),
        ),
        !mine.length && a.installed ? h("p", { class: "set-hint" }, "没有读到这个 agent 的额度。") : null,
      );
    });
    return [
      group(
        "额度",
        row("低额度提醒", "剩余百分比低于这个值时显示为红色", number("low_quota", "低额度提醒百分比", 1, 90)),
        row("自动刷新", "分钟。查询不消耗 token", number("quota_refresh_minutes", "额度刷新分钟数", 1, 120)),
        row("手动刷新", quota?.note ?? (quota?.source === "magpie" ? "数据来自 Magpie" : null), h("button", { type: "button", onclick: async () => { await refreshQuota(); draw(); } }, icon("refresh", 15), "刷新")),
      ),
      h("section", { class: "set-group" }, h("h2", {}, "已安装的 agent"), h("div", { class: "agent-grid" }, cards)),
    ];
  }

  function targetsTab() {
    const f = { name: h("input", { placeholder: "gpu1", "aria-label": "名称" }), ssh_host: h("input", { placeholder: "~/.ssh/config 里的主机名", "aria-label": "SSH 主机" }), remote_root: h("input", { placeholder: "/home/me/bot-runs", "aria-label": "远程目录" }), setup: h("input", { placeholder: "conda activate seg（可选）", "aria-label": "启动前命令" }) };
    const act = async (fn) => {
      try {
        ui.error = null;
        await fn();
        ui.targets = (await api("/api/targets")).targets;
      } catch (e) {
        ui.error = e.message;
      }
      draw();
    };
    return [
      group(
        "实验工作台使用的计算目标",
        ui.targets.length
          ? ui.targets.map((t) => row(t.name, `${t.ssh_host}:${t.remote_root}${t.setup ? ` · ${t.setup}` : ""}`, h("button", { type: "button", class: "danger", onclick: () => confirm(`删除计算目标 ${t.name}？`) && act(() => api(`/api/targets/${t.name}`, { method: "DELETE" })) }, "删除")))
          : h("p", { class: "set-empty" }, "还没有。默认在本机运行。"),
      ),
      group("添加 SSH 主机", h("div", { class: "set-form" }, Object.values(f), h("button", { type: "button", class: "primary", onclick: () => act(() => api("/api/targets", { method: "POST", body: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value])) })) }, "添加"))),
      h("p", { class: "set-note" }, "代码会同步到远程并在后台运行（遵守 .gitignore），指标和结果跑完后取回。这条路径还没有在真实服务器上测试过。"),
    ];
  }

  function archived() {
    if (!ui.archive) {
      if (!ui.archiveLoading) {
        ui.archiveLoading = true;
        api("/api/archive").then((a) => {
          ui.archive = a;
          ui.archiveLoading = false;
          draw();
        }, (e) => {
          ui.archiveLoading = false;
          ui.error = e.message;
          draw();
        });
      }
      return group("已归档", row("读取中…", null, null));
    }
    const restore = async (path) => {
      try {
        ui.error = null;
        await api(path, { method: "POST", body: {} });
        ui.archive = null;
      } catch (e) {
        ui.error = e.message;
      }
      draw();
    };
    const line = (label, hint, path, blocked) => row(label, hint, blocked ? h("span", { class: "muted small" }, "先恢复它所属的 Bot 或群聊") : h("button", { type: "button", onclick: () => restore(path) }, "恢复"));
    const { bots, groups, conversations } = ui.archive;
    const rows = [
      ...bots.map((b) => line(b.name, `Bot · ${b.cwd}`, `/api/bots/${b.id}/restore`)),
      ...groups.map((g) => line(g.name, `群聊 · ${g.cwd}`, `/api/groups/${g.id}/restore`)),
      ...conversations.map((c) => line(c.title, `对话 · ${c.bot_name ?? c.group_name ?? ""}`, `/api/conversations/${c.id}/restore`, Boolean(c.owner_archived))),
    ];
    return group("已归档", rows.length ? rows : row("没有归档的内容", null, null));
  }

  function dataTab() {
    return [
      group(
        "存放位置",
        row("数据目录", "数据库、记忆、工作树和实验结果都在这里", h("code", { class: "path-code" }, ui.data.home)),
      ),
      group(
        "备份",
        row("下载数据库", "所有 Bot、对话、任务和设置。恢复方法：停止服务，用它替换数据目录里的 platform.db，再启动。不含记忆、实验文件和工作树", h("a", { class: "button", href: "/api/backup", download: "" }, "下载")),
      ),
      archived(),
      h("p", { class: "set-note" }, "归档只是隐藏，不会删除数据。单个项目的备份和对话导出在右侧面板。"),
    ];
  }

  const VIEWS = { appearance, defaults, limits, agents: agentsTab, targets: targetsTab, data: dataTab };

  function drawStatus() {
    const el = root.querySelector(".set-status");
    if (el) el.textContent = ui.saved ? "已保存" : "";
  }

  function draw() {
    root.replaceChildren(
      ...[
        h("header", { class: "chat-head" }, h("button", { class: "icon-text", type: "button", onclick: onBack }, icon("back", 16), "返回"), h("div", { class: "chat-head-text" }, h("h1", {}, "设置")), h("span", { class: "set-status", role: "status" }, ui.saved ? "已保存" : "")),
        ui.error ? h("div", { class: "banner danger", role: "alert" }, ui.error) : null,
        h(
          "div",
          { class: "set-layout" },
          h("nav", { class: "set-nav", "aria-label": "设置分类" }, TABS.map(([k, t]) => h("button", { type: "button", class: ui.tab === k ? "on" : "", "aria-current": ui.tab === k ? "page" : null, onclick: () => { ui.tab = k; draw(); } }, t))),
          h("div", { class: "set-body" }, ui.data ? VIEWS[ui.tab]() : h("p", { class: "muted" }, "读取中…")),
        ),
      ].filter(Boolean),
    );
  }

  draw();
  void load();
  return { refresh: draw };
}
