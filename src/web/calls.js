// What other Bots asked this Bot to do. Those calls run in their own sessions, so they are not in its chats.
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { TASK_STATUS } from "./tasks.js";

const MODE = { task: "后台任务", ask: "提问", compare: "独立比较" };
const when = (at) => new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function mountCalls(root, ctx) {
  const { api, h, bot, onBack, onJump, itemNode, compact } = ctx;
  const ui = { list: null, error: null, open: new Set(), process: new Map() };

  async function refresh() {
    try {
      ui.list = (await api(`/api/bots/${bot.id}/calls`)).calls;
      ui.error = null;
    } catch (e) {
      ui.error = e.message;
    }
    draw();
  }

  async function loadProcess(c) {
    try {
      const { items } = await api(`/api/conversations/${c.child_conv_id}/items`);
      ui.process.set(c.id, items);
    } catch (e) {
      ui.process.set(c.id, e.message);
    }
    draw();
  }

  function row(c) {
    const md = h("div", { class: "md" });
    md.innerHTML = renderMarkdown(c.answer ?? ""); // Output of the escaping renderer in markdown.js.
    const process = ui.process.get(c.id);
    return h(
      "details",
      {
        class: "rs-idea calls-row",
        open: ui.open.has(c.id) ? true : null,
        ontoggle: (e) => {
          if (e.target.open && !ui.open.has(c.id)) {
            ui.open.add(c.id);
            if (!process) void loadProcess(c);
          } else if (!e.target.open) ui.open.delete(c.id);
        },
      },
      h(
        "summary",
        {},
        h("strong", {}, `${c.from} → ${bot.name}`),
        h("span", { class: "chip" }, MODE[c.mode] ?? c.mode),
        h("span", { class: "calls-title" }, c.title),
        h("span", { class: "spacer" }),
        h("span", { class: `tag state-${c.status}` }, TASK_STATUS[c.status] ?? c.status),
      ),
      h("p", { class: "muted small" }, [when(c.at), c.tokens ? `${compact(c.tokens)} tokens` : null, c.root_title ? `来自“${c.root_title}”` : null].filter(Boolean).join(" · ")),
      h("p", { class: "call-label" }, "问题"),
      h("div", { class: "call-question" }, c.question),
      c.answer ? h("p", { class: "call-label" }, c.status === "done" ? "回答" : "结果") : "",
      c.answer ? md : "",
      h("p", { class: "call-label" }, "它的过程"),
      !process ? h("p", { class: "muted small" }, "读取中…") : typeof process === "string" ? h("p", { class: "muted small" }, process) : h("div", { class: "call-process" }, process.map(itemNode).filter(Boolean)),
      c.root_open ? h("div", { class: "task-foot" }, h("span", { class: "spacer" }), h("button", { type: "button", onclick: () => onJump(c) }, c.item_id ? "跳到发起它的卡片" : "打开发起它的对话")) : h("p", { class: "muted small" }, "发起它的对话已归档。"),
    );
  }

  function draw() {
    root.replaceChildren(
      h("header", { class: "chat-head" }, h("button", { class: "icon-text", type: "button", onclick: onBack }, icon("back", 16), "返回对话"), h("div", { class: "chat-head-text" }, h("h1", {}, `${bot.name} 的被调用记录`), h("p", {}, "其他 Bot 让它做的事。这些在单独的会话里进行，它在你们的私聊里不记得"))),
      h(
        "div",
        { class: "rs-body" },
        ui.error ? h("div", { class: "banner danger", role: "alert" }, ui.error) : "",
        !ui.list ? h("p", { class: "muted" }, "读取中…") : ui.list.length ? ui.list.map(row) : h("p", { class: "muted" }, "还没有 Bot 调用过它。"),
      ),
    );
  }

  draw();
  void refresh();
  return { refresh };
}
