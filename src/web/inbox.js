// Inbox: what is waiting for the person, across every conversation. Details stay in the conversation.
import { icon } from "./icons.js";

const GROUPS = [
  ["approval", "等你批准"],
  ["unsent", "没有发出的消息"],
  ["result", "等你确认的结果"],
  ["later", "稍后处理"],
];

export function mountInbox(root, ctx) {
  const { h, onBack, onOpen, onReview } = ctx;
  let items = ctx.items ?? null;

  const row = (i) =>
    h(
      "div",
      { class: "inbox-line" },
      h(
        "button",
        { type: "button", class: "inbox-row", onclick: () => onOpen(i) },
        h("span", { class: "inbox-title" }, i.title),
        h("span", { class: "muted small" }, [i.conv_title, new Date(i.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }), i.detail].filter(Boolean).join(" · ")),
      ),
      i.kind === "result" ? h("button", { type: "button", title: "先放一边，不计入待办数量", onclick: () => onReview(i, "later") }, "稍后处理") : null,
      i.kind === "result" || i.kind === "later" ? h("button", { type: "button", title: "移出待办。这不代表你接受了结果", onclick: () => onReview(i, "dismissed") }, "无需验收") : null,
    );

  function draw() {
    const groups = GROUPS.map(([kind, label]) => [label, (items ?? []).filter((i) => i.kind === kind)]).filter(([, list]) => list.length);
    root.replaceChildren(
      h("header", { class: "chat-head" }, h("button", { class: "icon-text", type: "button", onclick: onBack }, icon("back", 16), "返回对话"), h("div", { class: "chat-head-text" }, h("h1", {}, "待办"), h("p", {}, "需要你处理的事，点一下跳到对应的对话"))),
      h("div", { class: "rs-body" }, !items ? h("p", { class: "muted" }, "读取中…") : groups.length ? groups.map(([label, list]) => h("section", { class: "inbox-group" }, h("h2", {}, `${label} ${list.length}`), list.map(row))) : h("p", { class: "muted" }, "现在没有需要你处理的事。")),
    );
  }

  draw();
  return {
    update(next) {
      items = next;
      draw();
    },
  };
}
