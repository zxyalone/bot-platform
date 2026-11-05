// One project at a glance: what it is for, who works on it, what is happening, what waits, and what came out.
import { icon } from "./icons.js";

const ROUND = { completed: "完成", failed: "失败", interrupted: "已停止", over_budget: "预算用完" };
const when = (at) => new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function mountProject(root, ctx) {
  const { api, h, onBack, onOpen, onJump, onArtifacts, onTasks, onBudget, onResearch, projects } = ctx;
  const ui = { cwd: ctx.cwd, data: null, error: null, editing: false, seenFrom: undefined };

  async function refresh() {
    try {
      const pid = projects.find((p) => p.cwd === ui.cwd)?.project_id;
      const q = new URLSearchParams({ cwd: ui.cwd });
      if (ui.seenFrom) q.set("since", String(ui.seenFrom));
      const data = await api(`/api/projects/${pid}/overview?${q}`);
      // The digest stays anchored to when this visit began, or it would empty itself on the first refresh.
      if (ui.seenFrom === undefined) {
        ui.seenFrom = data.brief.last_seen ?? null;
        void api(`/api/projects/${pid}/seen`, { method: "POST", body: {} });
      }
      ui.data = data;
      ui.error = null;
    } catch (e) {
      ui.error = e.message;
    }
    if (!ui.editing) draw();
  }

  const section = (title, ...body) => h("section", { class: "project-section" }, h("h2", {}, title), ...body);
  const link = (text, onclick, cls = "link-btn") => h("button", { type: "button", class: cls, onclick }, text);

  function digest(s) {
    if (!s) return h("p", { class: "muted small" }, "第一次打开这个项目。下次回来时，这里会列出这段时间发生了什么。");
    const bits = [
      s.rounds ? `${s.rounds} 轮对话` : null,
      s.failed_rounds ? `${s.failed_rounds} 轮失败` : null,
      s.stopped_rounds ? `${s.stopped_rounds} 轮被停止或预算用完` : null,
      s.done_tasks ? `${s.done_tasks} 个任务完成` : null,
      s.failed_tasks ? `${s.failed_tasks} 个任务失败或超时` : null,
      s.files ? `${s.files} 个文件有改动` : null,
      s.experiments_done ? `${s.experiments_done} 个实验完成` : null,
      s.experiments_failed ? `${s.experiments_failed} 个实验失败` : null,
      s.tokens ? `用了 ${s.tokens} tokens` : null,
    ].filter(Boolean);
    return h("p", {}, h("span", { class: "muted small" }, `自 ${when(s.at)} 以来：`), bits.length ? bits.join("，") : "没有新动静。");
  }

  function briefView(d) {
    const b = d.brief;
    const block = (label, text) => (text ? h("div", { class: "project-brief" }, h("p", { class: "call-label" }, label), h("p", { class: "project-text" }, text)) : null);
    return section(
      "项目说明",
      b.goal || b.notes || b.references ? [block("目标", b.goal), block("约束和当前决定", b.notes), block("参考资料", b.references)].filter(Boolean) : h("p", { class: "muted small" }, "还没有写。写下目标、约束和参考资料后，这个目录下的每个 Bot 都会读到。"),
      h("div", { class: "task-foot" }, h("span", { class: "spacer" }), link("编辑", () => { ui.editing = true; draw(); }, "")),
    );
  }

  function briefForm(d) {
    const b = d.brief;
    const name = h("input", { value: b.name, maxlength: 60, placeholder: "默认用目录名", "aria-label": "项目名称" });
    const area = (value, label, placeholder) => {
      const el = h("textarea", { rows: 4, maxlength: 4000, placeholder, "aria-label": label });
      el.value = value;
      return h("label", { class: "project-field" }, label, el);
    };
    const goal = area(b.goal, "目标", "这个项目要做成什么");
    const notes = area(b.notes, "约束和当前决定", "不能动什么、已经定下来什么");
    const refs = area(b.references, "参考资料", "路径、链接，一行一个。Bot 要自己去读，平台不会替它打开");
    const save = async () => {
      try {
        await api(`/api/projects/${d.project_id}/brief`, { method: "PUT", body: { name: name.value, goal: goal.lastChild.value, notes: notes.lastChild.value, references: refs.lastChild.value } });
        ui.editing = false;
        await refresh();
        ctx.onRenamed?.();
      } catch (e) {
        ui.error = e.message;
        draw();
      }
    };
    return section(
      "编辑项目说明",
      h("label", { class: "project-field" }, "名称", name),
      goal,
      notes,
      refs,
      h("p", { class: "muted small" }, "保存后，这个目录下的 Bot 从下一条消息开始读到。进行中的回合不受影响。Bot 不能改这里的内容。"),
      h("div", { class: "dialog-actions" }, h("span", { class: "spacer" }), link("取消", () => { ui.editing = false; draw(); }, ""), link("保存", save, "primary")),
    );
  }

  function draw() {
    const d = ui.data;
    const select = h("select", { "aria-label": "切换项目", onchange: (e) => { ui.cwd = e.target.value; ui.data = null; ui.seenFrom = undefined; ui.editing = false; draw(); void refresh(); } }, projects.map((p) => h("option", { value: p.cwd }, p.name)));
    select.value = ui.cwd;
    const head = h("header", { class: "chat-head" }, h("button", { class: "icon-text", type: "button", onclick: onBack }, icon("back", 16), "返回对话"), h("div", { class: "chat-head-text" }, h("h1", {}, d?.name ?? "项目"), h("p", { class: "path" }, ui.cwd)), select);
    if (!d) return root.replaceChildren(head, h("div", { class: "rs-body" }, ui.error ? h("div", { class: "banner danger", role: "alert" }, ui.error) : h("p", { class: "muted" }, "读取中…")));
    const useLine = (label, u) => `${label} ${u.spent}${u.limit ? ` / ${u.limit}` : ""} tokens`;
    const waiting = d.inbox.filter((i) => i.kind !== "later");
    root.replaceChildren(
      head,
      h(
        "div",
        { class: "rs-body project-page" },
        ui.error ? h("div", { class: "banner danger", role: "alert" }, ui.error) : "",
        section("做到哪了", digest(d.since), d.active.length ? h("ul", { class: "project-list" }, d.active.map((a) => h("li", {}, link(a.title, () => onOpen(a)), h("span", { class: "muted small" }, a.activity?.text ?? "进行中")))) : h("p", { class: "muted small" }, "现在没有进行中的对话。")),
        waiting.length || d.tasks.attention.length
          ? section(
              "等你处理",
              waiting.length ? h("ul", { class: "project-list" }, waiting.slice(0, 8).map((i) => h("li", {}, link(i.title, () => onJump(i)), h("span", { class: "muted small" }, i.conv_title)))) : "",
              d.tasks.attention.length ? h("p", { class: "small" }, `${d.tasks.attention.length} 个任务失败、超时或中断。`, link("打开任务中心", onTasks)) : "",
            )
          : "",
        ui.editing ? briefForm(d) : briefView(d),
        section(
          "参与者",
          h("ul", { class: "project-list" }, [...d.groups.map((g) => h("li", {}, link(`群聊：${g.name}`, () => onOpen({ group_id: g.id })))), ...d.bots.map((b) => h("li", {}, link(b.name, () => onOpen({ bot_id: b.id })), h("span", { class: "muted small" }, `${b.agent} · ${b.model}${b.paused ? " · 已暂停" : ""}`)))]),
        ),
        d.tasks.running.length ? section("进行中的任务", h("ul", { class: "project-list" }, d.tasks.running.map((t) => h("li", {}, h("span", {}, `${t.owner}：${t.title}`), t.waiting_reason ? h("span", { class: "muted small" }, t.waiting_reason) : "")))) : "",
        section(
          "成果",
          d.results.length ? h("ul", { class: "project-list" }, d.results.map((r) => h("li", {}, link(r.summary || `改动了 ${r.files} 个文件`, () => onJump(r)), h("span", { class: "muted small" }, [ROUND[r.status] ?? r.status, r.accepted ? "已接受" : r.review === "dismissed" ? "无需验收" : null, when(r.at)].filter(Boolean).join(" · "))))) : h("p", { class: "muted small" }, "还没有结果卡片。"),
          d.worktrees.length ? h("p", { class: "small" }, `${d.worktrees.length} 个工作树还没合并或丢弃：${d.worktrees.map((w) => w.branch).join("、")}`) : "",
          h("div", { class: "task-foot" }, h("span", { class: "muted small" }, `${d.artifact_total} 个产物和附件`), h("span", { class: "spacer" }), link("查看全部", () => onArtifacts(d), "")),
        ),
        section("预算", h("p", { class: "small" }, `${useLine("今天", d.budget.today)}；${useLine("累计", d.budget.total)}`), h("div", { class: "task-foot" }, h("span", { class: "spacer" }), link("设置与明细", () => onBudget(d, refresh), ""))),
        d.research.enabled ? section("实验", h("p", { class: "small" }, `${d.research.running} 个运行中，${d.research.ideas} 个想法等你判定。`), h("div", { class: "task-foot" }, h("span", { class: "spacer" }), link("打开实验工作台", () => onResearch(d), ""))) : "",
      ),
    );
  }

  draw();
  void refresh();
  return { refresh };
}
