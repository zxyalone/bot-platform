// Search across chats, tasks, changed files and experiments. Results open where they happened.
import { icon } from "./icons.js";

const KINDS = [["", "全部"], ["message", "聊天"], ["task", "任务"], ["file", "结果和文件"], ["experiment", "实验"]];
const STATUSES = [["", "任意状态"], ["running", "进行中"], ["done", "完成"], ["failed", "失败"], ["stopped", "已停止"]];
const TIMES = [["", "全部时间"], ["1", "今天"], ["7", "最近 7 天"], ["30", "最近 30 天"]];
const KIND_LABEL = { user: "你的消息", assistant: "回复", notice: "通知", error: "错误", call: "调用", result: "结果", experiment: "实验", idea: "想法" };
const DEBOUNCE_MS = 250;

export function mountSearch(root, ctx) {
  const { api, h, onBack, onOpen, projects, bots, ui } = ctx;
  let timer = 0;
  let asked = 0;

  const since = () => {
    if (!ui.time) return null;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() - (Number(ui.time) - 1) * 86400000;
  };

  async function run() {
    const q = ui.q.trim();
    const mine = ++asked;
    if (!q) {
      ui.results = null;
      ui.error = null;
      drawResults();
      return;
    }
    const params = new URLSearchParams({ q });
    if (ui.kind) params.set("kind", ui.kind);
    if (ui.cwd) params.set("cwd", ui.cwd);
    if (ui.bot) params.set("bot", ui.bot);
    if (ui.status) params.set("status", ui.status);
    if (since()) params.set("since", String(since()));
    try {
      const r = await api(`/api/search?${params}`);
      // An answer to something typed earlier must not replace a newer one.
      if (mine !== asked) return;
      ui.results = r.results;
      ui.more = r.more;
      ui.error = null;
    } catch (e) {
      if (mine !== asked) return;
      ui.error = e.message;
    }
    drawResults();
  }
  const runSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  };

  // Built from nodes, so text from a conversation can never become markup.
  function marked(text) {
    const terms = ui.q.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!terms.length) return text;
    return text.split(new RegExp(`(${terms.join("|")})`, "gi")).map((part, i) => (i % 2 ? h("mark", {}, part) : part));
  }

  const when = (at) => new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const row = (r) =>
    h(
      "button",
      { type: "button", class: "search-row", onclick: () => onOpen(r) },
      h("span", { class: "search-text" }, ...[].concat(marked(r.snippet))),
      h("span", { class: "muted small" }, [KIND_LABEL[r.type], r.who, r.conv_title, when(r.at)].filter(Boolean).join(" · ")),
    );

  const results = h("div", { class: "rs-body", "aria-live": "polite" });
  function drawResults() {
    results.replaceChildren(
      ...(ui.error ? [h("div", { class: "banner danger", role: "alert" }, ui.error)] : []),
      ...(!ui.q.trim()
        ? [h("p", { class: "muted" }, "输入关键词，多个词用空格隔开，要全部出现才算匹配。")]
        : !ui.results
          ? [h("p", { class: "muted" }, "搜索中…")]
          : ui.results.length
            ? [...ui.results.map(row), ...(ui.more ? [h("p", { class: "muted small" }, "只显示最新的 50 条，加几个词或筛选可以缩小范围。")] : [])]
            : [h("p", { class: "muted" }, "没有找到。已归档的对话不在搜索范围内。")]),
    );
  }

  const select = (key, options, label) => {
    const el = h("select", { "aria-label": label, onchange: (e) => { ui[key] = e.target.value; void run(); } }, options.map(([v, t]) => h("option", { value: v }, t)));
    el.value = ui[key];
    return el;
  };
  const box = h("input", {
    type: "search",
    class: "search-box",
    placeholder: "搜索聊天、任务、文件和实验",
    "aria-label": "搜索",
    value: ui.q,
    oninput: (e) => {
      ui.q = e.target.value;
      // Mid-composition text is not what the person means yet.
      if (!e.isComposing) runSoon();
    },
    oncompositionend: (e) => {
      ui.q = e.target.value;
      runSoon();
    },
  });

  root.replaceChildren(
    h("header", { class: "chat-head" }, h("button", { class: "icon-text", type: "button", onclick: onBack }, icon("back", 16), "返回对话"), h("div", { class: "chat-head-text" }, h("h1", {}, "搜索"), h("p", {}, "点一条结果，跳到它原来的位置"))),
    h("div", { class: "search-bar" }, box),
    h("div", { class: "search-filters" }, select("kind", KINDS, "类型"), select("cwd", [["", "全部项目"], ...projects], "项目"), select("bot", [["", "全部 Bot"], ...bots], "Bot"), select("time", TIMES, "时间"), select("status", STATUSES, "状态")),
    results,
  );
  drawResults();
  if (ui.q.trim()) void run();
  box.focus();
  box.select();
  return {};
}
