// Optional experiment workbench: idea ledger, runs, result comparison, and the test-set gate.
import { icon } from "./icons.js";

const STATUS = { running: "运行中", done: "完成", failed: "失败", lost: "进程丢失", cancelled: "已取消" };
const IDEA = { proposed: "待验证", testing: "验证中", rejected: "已放弃", parked: "已搁置", supported: "成立", not_supported: "不成立" };
const ROLE = { baseline: "基线", variant: "方案", ablation: "消融" };
const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : "—");

export function mountResearch(root, ctx) {
  const { api, h, projectId, title, onBack, openDialog } = ctx;
  const ui = { tab: ctx.tab ?? "ideas", data: null, error: null, picked: new Set(), metric: null, overlay: false, shown: 30, manifests: new Map() };

  const act = async (fn) => {
    try {
      ui.error = null;
      await fn();
    } catch (e) {
      ui.error = e.message;
    }
    await refresh();
  };

  async function refresh() {
    try {
      ui.data = await api(`/api/projects/${projectId}/research`);
    } catch (e) {
      ui.error = e.message;
    }
    draw();
  }

  function ideasTab() {
    const name = h("input", { placeholder: "想法的标题", "aria-label": "想法标题" });
    const hypo = h("input", { placeholder: "假设：怎样才算成立", "aria-label": "假设" });
    const form = h(
      "form",
      {
        class: "rs-add",
        onsubmit: (e) => {
          e.preventDefault();
          if (name.value.trim()) act(() => api(`/api/projects/${projectId}/ideas`, { method: "POST", body: { title: name.value, hypothesis: hypo.value } }));
        },
      },
      name,
      hypo,
      h("button", { type: "submit" }, "记下"),
    );
    const patch = (i, body) => act(() => api(`/api/ideas/${i.id}`, { method: "PATCH", body }));
    const rows = ui.data.ideas.map((i) =>
      h(
        "div",
        { class: "rs-idea" },
        h("div", { class: "rs-idea-head" }, h("strong", {}, i.title), h("span", { class: `tag state-${i.status}` }, IDEA[i.status] ?? i.status)),
        i.hypothesis ? h("p", {}, i.hypothesis) : null,
        i.prior_work ? h("p", { class: "muted small" }, `查重：${i.prior_work}`) : null,
        i.conclusion ? h("p", {}, `结论：${i.conclusion}`) : null,
        i.failure_reason ? h("p", { class: "muted small" }, `失败原因：${i.failure_reason}`) : null,
        i.suggested_verdict
          ? h("div", { class: "rs-verdict" }, `${i.created_by === "用户" ? "Bot" : i.created_by} 建议判定为“${IDEA[i.suggested_verdict]}”`, h("button", { type: "button", class: "primary", onclick: () => patch(i, { status: i.suggested_verdict }) }, "采纳"), h("button", { type: "button", onclick: () => patch(i, { suggested_verdict: null }) }, "驳回"))
          : null,
        h("div", { class: "rs-actions" }, ["supported", "not_supported", "parked"].filter((s) => s !== i.status).map((s) => h("button", { type: "button", onclick: () => patch(i, { status: s }) }, `标记为${IDEA[s]}`))),
      ),
    );
    return [form, rows.length ? rows : h("p", { class: "muted" }, "还没有想法。Bot 提出的想法也会记在这里，避免重复尝试。")];
  }

  function metricKeys(list) {
    const keys = new Set();
    for (const e of list) for (const k of Object.keys(e.metrics ?? {})) keys.add(k);
    return [...keys].slice(0, 6);
  }

  function codeVersion(commit, dirty, hash, complete) {
    if (!commit) return "—";
    if (!dirty) return commit.slice(0, 8);
    if (!hash) return `${commit.slice(0, 8)} +改动（未留快照）`;
    return `${commit.slice(0, 8)} +${hash.slice(0, 8)}${complete ? "" : "（快照不完整）"}`;
  }

  function experimentsTab() {
    const { experiments: list, summary, finalEvals } = ui.data;
    if (!list.length) return [h("p", { class: "muted" }, "还没有实验。让 Bot 用 run_experiment 提交，你批准后会在后台运行。")];
    const keys = metricKeys(list);
    const compare = summary.length
      ? [
          h("h3", {}, "按方案汇总（来自脚本写出的指标）"),
          h("div", { class: "table-wrap" }, h("table", { class: "rs-table" }, h("thead", {}, h("tr", {}, h("th", {}, "方案"), h("th", {}, "类型"), h("th", {}, "配置"), h("th", {}, "代码版本"), h("th", {}, "样本"), keys.map((k) => h("th", {}, k)))), h("tbody", {}, summary.map((s) => h("tr", {}, h("td", {}, s.name), h("td", {}, ROLE[s.role] ?? s.role), h("td", { class: "path", title: JSON.stringify(s.config) }, JSON.stringify(s.config).slice(0, 40)), h("td", { class: "path" }, codeVersion(s.commit, s.dirty, s.code_hash, s.code_complete)), h("td", { title: "同一个种子重复运行只算一个样本，取平均" }, s.seeds === s.runs ? String(s.runs) : `${s.seeds}（共运行 ${s.runs} 次）`), keys.map((k) => h("td", {}, s.metrics[k] ? `${fmt(s.metrics[k].mean)}${s.metrics[k].n > 1 ? ` ± ${s.metrics[k].std.toFixed(4)}` : ""}` : "—"))))))),
        ]
      : [];
    const row = (e) =>
      h(
        "tr",
        {},
        h("td", {}, e.name),
        h("td", {}, e.seed ?? "—"),
        h("td", { class: `state-${e.status}` }, STATUS[e.status] ?? e.status),
        keys.map((k) => h("td", {}, fmt(e.metrics?.[k]))),
        h("td", { class: "path" }, codeVersion(e.commit_hash, e.dirty, e.code_hash, e.code_complete)),
        h("td", {}, e.final_status === "running" ? "评估中" : e.test_metrics ? Object.entries(e.test_metrics).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k} ${fmt(v)}`).join("，") : "—"),
        h(
          "td",
          { class: "rs-actions" },
          h("button", { type: "button", onclick: () => showLog(e) }, "日志"),
          e.status === "running" ? h("button", { type: "button", class: "danger", onclick: () => confirm(`取消实验“${e.name}”？`) && act(() => api(`/api/experiments/${e.id}/cancel`, { method: "POST", body: {} })) }, "取消") : null,
          e.status === "done"
            ? h("button", { type: "button", onclick: () => { ui.picked.add(e.id); ui.tab = "results"; draw(); } }, "看结果")
            : null,
          e.status === "done" && e.final_status !== "running"
            ? h("button", { type: "button", onclick: () => confirm(`用测试集评估“${e.name}”？这个项目已经看过测试集 ${finalEvals} 次，看得越多，结果越可能虚高。结果只显示给你，不会告诉 Bot。`) && act(() => api(`/api/experiments/${e.id}/final-eval`, { method: "POST", body: {} })) }, "最终评估")
            : null,
        ),
      );
    return [
      ...compare,
      h("h3", {}, "每次运行"),
      h("div", { class: "table-wrap" }, h("table", { class: "rs-table" }, h("thead", {}, h("tr", {}, ["方案", "种子", "状态"].map((t) => h("th", {}, t)), keys.map((k) => h("th", {}, k)), h("th", {}, "代码版本"), h("th", {}, "测试集（仅你可见）"), h("th", {}, ""))), h("tbody", {}, list.map(row)))),
    ];
  }

  async function showLog(e) {
    const body = h("pre", { class: "diff-view" }, "读取中…");
    openDialog(`${e.name} 的日志`, body);
    try {
      body.textContent = (await api(`/api/experiments/${e.id}/log`)).log || "还没有日志。";
    } catch (err) {
      body.textContent = err.message;
    }
  }

  const fileUrl = (id, path) => `/api/experiments/${id}/file?path=${encodeURIComponent(path)}`;

  function resultsTab() {
    const done = ui.data.experiments.filter((e) => e.status === "done");
    if (!done.length) return [h("p", { class: "muted" }, "实验完成后可以在这里对比结果。")];
    const picker = h(
      "fieldset",
      { class: "check-list" },
      h("legend", {}, "选择实验（最多 3 个）"),
      done.map((e) =>
        h("label", {}, h("input", { type: "checkbox", checked: ui.picked.has(e.id) ? true : null, onchange: (ev) => {
          if (ev.target.checked && ui.picked.size >= 3) {
            ev.target.checked = false;
            return;
          }
          ev.target.checked ? ui.picked.add(e.id) : ui.picked.delete(e.id);
          draw();
        } }), `${e.name}${e.seed !== null ? ` #${e.seed}` : ""}`),
      ),
    );
    const area = h("div", { class: "rs-results" });
    void loadCases(area);
    return [picker, area];
  }

  async function loadCases(area) {
    const ids = [...ui.picked];
    if (!ids.length) {
      area.replaceChildren(h("p", { class: "muted" }, "选一个实验开始。结果需要脚本在 $BOT_ARTIFACTS_DIR 写出 manifest.json 和 PNG 图片，格式见 README。"));
      return;
    }
    for (const id of ids) {
      if (!ui.manifests.has(id)) {
        const m = await api(`/api/experiments/${id}/manifest`).catch((e) => ({ error: e.message }));
        ui.manifests.set(id, m.cases ?? []);
      }
    }
    const first = ui.manifests.get(ids[0]) ?? [];
    if (!first.length) {
      area.replaceChildren(h("p", { class: "muted" }, "这个实验没有写出 manifest.json。"));
      return;
    }
    const names = new Map(ui.data.experiments.map((e) => [e.id, `${e.name}${e.seed !== null ? ` #${e.seed}` : ""}`]));
    const metrics = [...new Set(first.flatMap((c) => Object.keys(c.metrics)))];
    if (!ui.metric || !metrics.includes(ui.metric)) ui.metric = metrics[0] ?? null;
    const sel = h("select", { "aria-label": "排序指标", onchange: (e) => { ui.metric = e.target.value; void loadCases(area); } }, metrics.map((m) => h("option", { value: m }, m)));
    if (ui.metric) sel.value = ui.metric;
    const sorted = [...first].sort((a, b) => (a.metrics[ui.metric] ?? 0) - (b.metrics[ui.metric] ?? 0));
    const img = (id, path, label, under) => {
      if (!path) return h("div", { class: "rs-cell" }, h("div", { class: "rs-empty" }, "无"), h("span", {}, label));
      const pic = h("img", { src: fileUrl(id, path), alt: label, loading: "lazy" });
      return h("div", { class: "rs-cell" }, under ? h("div", { class: "rs-stack" }, h("img", { src: fileUrl(id, under), alt: "", loading: "lazy" }), pic) : pic, h("span", {}, label));
    };
    area.replaceChildren(
      h(
        "div",
        { class: "rs-toolbar" },
        h("label", {}, "按指标从低到高：", sel),
        h("label", {}, h("input", { type: "checkbox", checked: ui.overlay ? true : null, onchange: (e) => { ui.overlay = e.target.checked; void loadCases(area); } }), " 叠加到原图"),
        h("span", { class: "muted small" }, `共 ${sorted.length} 例`),
      ),
      ...sorted.slice(0, ui.shown).map((c) =>
        h(
          "div",
          { class: "rs-case" },
          h("div", { class: "rs-case-head" }, h("strong", {}, c.id), h("span", { class: "muted small" }, Object.entries(c.metrics).map(([k, v]) => `${k} ${fmt(v)}`).join("，"))),
          h(
            "div",
            { class: "rs-row" },
            img(ids[0], c.image, "原图"),
            img(ids[0], c.label, "标注", ui.overlay ? c.image : null),
            ids.map((id) => {
              const other = (ui.manifests.get(id) ?? []).find((x) => x.id === c.id);
              const m = other?.metrics?.[ui.metric];
              return img(id, other?.pred, `${names.get(id)}${typeof m === "number" ? `：${fmt(m)}` : ""}`, ui.overlay ? other?.image : null);
            }),
          ),
        ),
      ),
      sorted.length > ui.shown ? h("button", { type: "button", onclick: () => { ui.shown += 30; void loadCases(area); } }, "再看 30 例") : null,
    );
  }

  function settingsTab() {
    const s = ui.data.settings;
    const testDir = h("input", { value: s.test_dir, placeholder: "/data/my_project/test", "aria-label": "测试集路径" });
    const cmd = h("textarea", { rows: 2, placeholder: "python eval.py --ckpt $BOT_TRAIN_RUN_DIR --data $BOT_TEST_DIR --out $BOT_METRICS_FILE", "aria-label": "最终评估命令" });
    cmd.value = s.final_eval_command;
    const wake = h("input", { type: "checkbox", checked: s.auto_wake ? true : null });
    return [
      h("h3", {}, "测试集闸门"),
      h("p", { class: "muted small" }, "Bot 提交的命令和配置里不能出现这个路径，测试集结果也不会告诉 Bot。这能防止误用，但不是硬隔离：能读文件的 agent 如果自己找到路径，平台拦不住。"),
      h("label", { class: "field" }, "测试集路径", testDir),
      h("label", { class: "field" }, "最终评估命令（只有你能触发）", cmd),
      h("label", { class: "field check-inline" }, wake, "实验结束后自动唤醒对话（会消耗 token）"),
      h("button", { type: "button", class: "primary", onclick: () => act(() => api(`/api/projects/${projectId}/settings`, { method: "PUT", body: { test_dir: testDir.value, final_eval_command: cmd.value, auto_wake: wake.checked } })) }, "保存"),
      h("p", { class: "muted small" }, `可用的计算目标：本机${ui.data.targets.map((t) => `、${t.name}`).join("")}。在全局设置里添加 SSH 主机。`),
    ];
  }

  function draw() {
    const tabs = [["ideas", "想法"], ["experiments", "实验"], ["results", "结果"], ["settings", "设置"]];
    const body = !ui.data ? [h("p", { class: "muted" }, "读取中…")] : ui.tab === "ideas" ? ideasTab() : ui.tab === "experiments" ? experimentsTab() : ui.tab === "results" ? resultsTab() : settingsTab();
    root.replaceChildren(
      ...[
        h("header", { class: "chat-head" }, h("button", { class: "icon-text", type: "button", onclick: onBack }, icon("back", 16), "返回对话"), h("div", { class: "chat-head-text" }, h("h1", {}, "实验工作台"), h("p", {}, title))),
        h("nav", { class: "rs-tabs", "aria-label": "实验工作台" }, tabs.map(([k, t]) => h("button", { type: "button", class: ui.tab === k ? "selected" : "", "aria-current": ui.tab === k ? "page" : null, onclick: () => { ui.tab = k; draw(); } }, t))),
        ui.error ? h("div", { class: "banner danger", role: "alert" }, ui.error) : null,
        h("div", { class: "rs-body" }, body.flat()),
      ].filter(Boolean),
    );
  }

  draw();
  void refresh();
  return { refresh };
}
