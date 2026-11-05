// Files a project's rounds produced, and files the person gave them. Read from the daemon's records.
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";

const SCOPES = [["conv", "这个对话"], ["project", "整个项目"]];
const KINDS = [["", "全部"], ["file", "产物"], ["attachment", "附件"]];
const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);
const STATE = { changed: "这一轮之后又被改过，下面显示的是现在的内容", gone: "文件已经不在了", discarded: "已随工作树丢弃" };
const available = (a) => a.state !== "gone" && a.state !== "discarded";
const fileUrl = (id, download) => `/api/artifacts/${id}/file${download ? "?download=1" : ""}`;

// Shared with the chat, where an attachment can be opened from its message.
export async function previewArtifact({ api, h, dialog }, a) {
  const body = h("div", { class: "artifact-preview" }, "读取中…");
  dialog.replaceChildren(h("div", {}, h("h2", {}, a.name), a.kind === "file" ? h("p", { class: "muted small path" }, a.rel) : "", body, h("div", { class: "dialog-actions" }, h("span", { class: "spacer" }), h("a", { class: "button", href: fileUrl(a.id, true), download: a.name }, "下载"), h("button", { type: "button", onclick: () => dialog.close() }, "关闭"))));
  dialog.showModal();
  if (a.preview === "image") return body.replaceChildren(h("img", { src: fileUrl(a.id), alt: a.name }));
  if (a.preview === "pdf") return body.replaceChildren(h("a", { href: fileUrl(a.id), target: "_blank", rel: "noopener" }, "在新标签页打开 PDF"));
  if (a.preview !== "text") return body.replaceChildren(h("p", { class: "muted" }, "这个文件太大或者无法预览，请下载后查看。"));
  try {
    const d = await api(`/api/artifacts/${a.id}/text`);
    if (d.markdown) {
      const md = h("div", { class: "md" });
      md.innerHTML = renderMarkdown(d.text); // Output of the escaping renderer in markdown.js.
      body.replaceChildren(md);
    } else body.replaceChildren(h("pre", { class: "diff-view" }, d.text));
  } catch (e) {
    body.replaceChildren(h("p", { class: "muted" }, e.message));
  }
}

export function mountArtifacts(root, ctx) {
  const { api, h, onBack, onOpen, cwd, convId, dialog } = ctx;
  const ui = { scope: convId ? "conv" : "project", kind: "", list: null, error: null, canReveal: false, notice: null };

  async function refresh() {
    const params = new URLSearchParams({ cwd });
    if (ui.scope === "conv" && convId) params.set("conv", convId);
    if (ui.kind) params.set("kind", ui.kind);
    try {
      const r = await api(`/api/artifacts?${params}`);
      ui.list = r.artifacts;
      ui.canReveal = r.can_reveal;
      ui.error = null;
    } catch (e) {
      ui.error = e.message;
    }
    draw();
  }

  async function reveal(a) {
    try {
      await api(`/api/artifacts/${a.id}/reveal`, { method: "POST", body: {} });
      ui.error = null;
    } catch (e) {
      ui.error = e.message;
    }
    draw();
  }

  const row = (a) =>
    h(
      "article",
      { class: "rs-idea artifact-row" },
      h("div", { class: "rs-idea-head" }, h("strong", { class: "task-title" }, a.name), a.change ? h("span", { class: "tag" }, a.change) : null, h("span", { class: "tag" }, a.kind === "attachment" ? "附件" : "产物")),
      a.kind === "file" && a.rel !== a.name ? h("p", { class: "muted small path" }, a.rel) : null,
      h("p", { class: "small" }, [a.origin, available(a) ? fileSize(a.size) : null, new Date(a.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })].filter(Boolean).join(" · ")),
      STATE[a.state] ? h("p", { class: "muted small" }, STATE[a.state]) : null,
      h(
        "div",
        { class: "task-foot" },
        a.conv_title ? h("button", { type: "button", class: "link-btn", onclick: () => onOpen(a) }, a.conv_title) : null,
        h("span", { class: "spacer" }),
        available(a) ? h("button", { type: "button", onclick: () => previewArtifact({ api, h, dialog }, a) }, "预览") : null,
        available(a) ? h("a", { class: "button", href: fileUrl(a.id, true), download: a.name }, "下载") : null,
        available(a) && ui.canReveal ? h("button", { type: "button", title: "只在访达中选中这个文件，不会打开它", onclick: () => reveal(a) }, "在访达中显示") : null,
      ),
    );

  function draw() {
    const tabs = (list, key) => list.filter(([v]) => key !== "scope" || v !== "conv" || convId).map(([v, t]) => h("button", { type: "button", class: ui[key] === v ? "selected" : "", onclick: () => { ui[key] = v; ui.list = null; draw(); void refresh(); } }, t));
    root.replaceChildren(
      ...[
        h("header", { class: "chat-head" }, h("button", { class: "icon-text", type: "button", onclick: onBack }, icon("back", 16), "返回对话"), h("div", { class: "chat-head-text" }, h("h1", {}, "产物和附件"), h("p", { class: "path" }, cwd))),
        h("nav", { class: "rs-tabs" }, tabs(SCOPES, "scope"), h("span", { class: "spacer" }), tabs(KINDS, "kind")),
        ui.error ? h("div", { class: "banner danger", role: "alert" }, ui.error) : null,
        h("div", { class: "rs-body" }, !ui.list ? h("p", { class: "muted" }, "读取中…") : ui.list.length ? ui.list.map(row) : h("p", { class: "muted" }, "还没有。Bot 改过的文件和你拖进来的附件会出现在这里。实验结果在实验工作台。")),
      ].filter(Boolean),
    );
  }

  draw();
  void refresh();
  return { refresh };
}
