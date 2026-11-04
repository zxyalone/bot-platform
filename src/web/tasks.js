// Task center: every assign_task across conversations, read from the daemon's records.
import { icon } from "./icons.js";

export const TASK_STATUS = { waiting: "等待中", running: "进行中", done: "完成", failed: "失败", timeout: "已超时", interrupted: "已中断", refused: "被拒绝" };
const FILTERS = [
  ["open", "进行中", (t) => t.status === "waiting" || t.status === "running"],
  ["attention", "需要处理", (t) => t.can_retry || t.status === "refused"],
  ["all", "全部", () => true],
];

export function mountTasks(root, ctx) {
  const { api, h, onBack, onOpen } = ctx;
  // The list redraws whenever a task changes, so what is expanded has to outlive a redraw.
  const ui = { filter: "open", tasks: null, loadError: null, retryError: null, busy: new Set(), expanded: new Set() };

  async function refresh() {
    try {
      ui.tasks = (await api("/api/tasks")).tasks;
      ui.loadError = null;
    } catch (e) {
      ui.loadError = e.message;
    }
    draw();
  }

  async function retry(t) {
    ui.busy.add(t.id);
    draw();
    try {
      await api(`/api/tasks/${t.id}/retry`, { method: "POST", body: {} });
      ui.retryError = null;
    } catch (e) {
      ui.retryError = `${t.owner} 的任务不能重试：${e.message}`;
    }
    ui.busy.delete(t.id);
    await refresh();
  }

  function card(t) {
    const line = (label, text, cls = "") => h("div", { class: "task-line" }, h("span", { class: "task-label" }, label), h("span", { class: cls }, text));
    return h(
      "article",
      { class: "rs-idea task-card" },
      h("div", { class: "rs-idea-head" }, h("strong", { class: "task-title" }, t.question), h("span", { class: `tag state-${t.status}` }, TASK_STATUS[t.status] ?? t.status)),
      line("负责人", `${t.owner}（${t.from} 派的）${t.attempt > 1 ? ` · 第 ${t.attempt} 次尝试` : ""}`),
      t.depends_on.length ? h("div", { class: "task-line" }, h("span", { class: "task-label" }, "依赖"), h("span", {}, t.depends_on.map((d) => h("span", { class: "task-dep" }, `${d.owner}：${d.title}`, h("span", { class: `tag state-${d.status}` }, TASK_STATUS[d.status] ?? d.status))))) : null,
      t.waiting_reason ? line("在等", t.waiting_reason, "task-waiting") : null,
      t.failure_reason ? line("原因", t.failure_reason, "task-failure") : null,
      t.answer ? h("details", { class: "task-answer", open: ui.expanded.has(t.id), ontoggle: (e) => (e.target.open ? ui.expanded.add(t.id) : ui.expanded.delete(t.id)) }, h("summary", {}, "结论"), h("p", {}, t.answer)) : null,
      h(
        "div",
        { class: "task-foot" },
        h("button", { type: "button", class: "link-btn", onclick: () => onOpen(t) }, t.conv_title),
        h("span", { class: "spacer" }),
        t.tokens ? h("span", { class: "muted small" }, `${t.tokens} tokens`) : null,
        t.can_retry ? h("button", { type: "button", disabled: ui.busy.has(t.id) ? true : null, title: "如果这一轮已经结束，会新开一轮，占用一份每轮预算；调用次数、深度、并发和审批照常生效", onclick: () => retry(t) }, "重试") : null,
      ),
    );
  }

  function draw() {
    const pick = FILTERS.find(([k]) => k === ui.filter);
    const shown = ui.tasks?.filter(pick[2]);
    const empty = { open: "现在没有进行中的任务。", attention: "没有需要处理的任务。", all: "还没有任务。Bot 用 assign_task 派活时会出现在这里。" }[ui.filter];
    root.replaceChildren(
      ...[
        h("header", { class: "chat-head" }, h("button", { class: "icon-text", type: "button", onclick: onBack }, icon("back", 16), "返回对话"), h("div", { class: "chat-head-text" }, h("h1", {}, "任务中心"), h("p", {}, "Bot 用 assign_task 派出的任务"))),
        h("nav", { class: "rs-tabs", "aria-label": "任务筛选" }, FILTERS.map(([k, label, test]) => h("button", { type: "button", class: ui.filter === k ? "selected" : "", "aria-current": ui.filter === k ? "page" : null, onclick: () => { ui.filter = k; draw(); } }, `${label}${ui.tasks ? ` ${ui.tasks.filter(test).length}` : ""}`))),
        ui.loadError || ui.retryError ? h("div", { class: "banner danger", role: "alert" }, ui.loadError ?? ui.retryError) : null,
        h("div", { class: "rs-body" }, !shown ? h("p", { class: "muted" }, "读取中…") : shown.length ? shown.map(card) : h("p", { class: "muted" }, empty)),
      ].filter(Boolean),
    );
  }

  draw();
  void refresh();
  return { refresh };
}
