// Messages the platform sends to a Bot on a schedule.
const DAY = "日一二三四五六";
const when = (at) => (at ? new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

export function describeSchedule(r) {
  if (r.every_minutes) return r.every_minutes % 60 === 0 ? `每 ${r.every_minutes / 60} 小时` : `每 ${r.every_minutes} 分钟`;
  const days = !r.weekdays.length || r.weekdays.length === 7 ? "每天" : r.weekdays.join(",") === "1,2,3,4,5" ? "工作日" : `每周${r.weekdays.map((d) => DAY[d]).join("、")}`;
  return `${days} ${r.daily_at}`;
}

// ctx: { api, h, bot, dlg, onJump(convId), onChanged() }
export function routineSection(ctx) {
  const { h, bot, api, onJump, onChanged } = ctx;
  const routines = bot.routines ?? [];
  const act = async (fn) => {
    try {
      await fn();
    } catch (e) {
      alert(e.message);
    }
    onChanged();
  };
  return [
    h("h2", { class: "section" }, "定时任务"),
    routines.length
      ? routines.map((r) =>
          h(
            "div",
            { class: `routine${r.enabled ? "" : " routine-off"}` },
            h(
              "div",
              { class: "routine-head" },
              h("strong", {}, r.name),
              h("span", { class: "chip" }, describeSchedule(r)),
              r.created_by === "bot" ? h("span", { class: "chip", title: "Bot 在对话里自己设的" }, "Bot 创建") : null,
              r.enabled ? null : h("span", { class: "chip" }, "已暂停"),
            ),
            h("p", { class: "muted small" }, [r.enabled ? `下次 ${when(r.next_run)}` : null, r.last_run ? `上次 ${when(r.last_run)}：${r.last_status}` : "还没运行过"].filter(Boolean).join(" · ")),
            h(
              "div",
              { class: "routine-actions" },
              h("button", { type: "button", onclick: () => act(() => api(`/api/routines/${r.id}/run`, { method: "POST" })) }, "立即运行"),
              h("button", { type: "button", onclick: () => act(() => api(`/api/routines/${r.id}`, { method: "PATCH", body: { enabled: !r.enabled } })) }, r.enabled ? "暂停" : "开启"),
              h("button", { type: "button", onclick: () => openRoutineDialog(ctx, r) }, "编辑"),
              r.conv_id ? h("button", { type: "button", onclick: () => onJump(r.conv_id) }, "查看对话") : null,
              h("button", { type: "button", class: "danger", onclick: () => confirm(`删除定时任务「${r.name}」？`) && act(() => api(`/api/routines/${r.id}`, { method: "DELETE" })) }, "删除"),
            ),
          ),
        )
      : h("p", { class: "muted small" }, "到点后平台把一段话发给这个 Bot，比如“每小时看一下训练日志”。也可以直接在对话里让 Bot 自己设。"),
    h("button", { type: "button", onclick: () => openRoutineDialog(ctx, null) }, "新建定时任务"),
  ];
}

export function openRoutineDialog(ctx, r) {
  const { h, api, bot, dlg, onChanged } = ctx;
  const name = h("input", { maxlength: 60, value: r?.name ?? "", placeholder: "比如：检查训练进度", "aria-label": "名称" });
  const prompt = h("textarea", { rows: 5, maxlength: 4000, placeholder: "到点时发给 Bot 的话。写清楚看什么、什么情况算异常、要不要通知你。", "aria-label": "内容" }, r?.prompt ?? "");
  const kind = h("select", { "aria-label": "方式" }, h("option", { value: "interval" }, "每隔一段时间"), h("option", { value: "daily" }, "每天定时"));
  kind.value = r && !r.every_minutes ? "daily" : "interval";
  const every = h("input", { type: "number", min: 5, max: 10080, value: String(r?.every_minutes ?? 60), "aria-label": "间隔分钟" });
  const at = h("input", { type: "time", value: r?.daily_at ?? "09:00", "aria-label": "时间" });
  const days = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ d, box: h("input", { type: "checkbox", checked: !r?.weekdays?.length || r.weekdays.includes(d) ? true : null, "aria-label": `周${DAY[d]}` }) }));
  const intervalRow = h("label", { class: "project-field" }, "间隔（分钟，至少 5）", every);
  const dailyRow = h("div", {}, h("label", { class: "project-field" }, "时间", at), h("div", { class: "routine-days" }, days.map(({ d, box }) => h("label", { class: "check" }, box, `周${DAY[d]}`))));
  const sync = () => {
    intervalRow.hidden = kind.value !== "interval";
    dailyRow.hidden = kind.value !== "daily";
  };
  kind.onchange = sync;
  sync();
  const error = h("p", { class: "send-error", role: "alert", hidden: true });
  const save = async () => {
    const picked = days.filter((x) => x.box.checked).map((x) => x.d);
    const body = { name: name.value, prompt: prompt.value, ...(kind.value === "interval" ? { every_minutes: Number(every.value), daily_at: null } : { every_minutes: null, daily_at: at.value, weekdays: picked.length === 7 ? [] : picked }) };
    try {
      await (r ? api(`/api/routines/${r.id}`, { method: "PATCH", body }) : api(`/api/bots/${bot.id}/routines`, { method: "POST", body }));
      dlg.close();
      onChanged();
    } catch (e) {
      error.hidden = false;
      error.textContent = e.message;
    }
  };
  dlg.replaceChildren(
    h(
      "div",
      {},
      h("h2", {}, r ? "编辑定时任务" : `给 ${bot.name} 新建定时任务`),
      h("p", { class: "muted small" }, "到点后这段话会作为一条新消息发给 Bot，结果留在同一个对话里。每次运行都会消耗用量，也受项目预算限制。上一次还没结束时，这一次会跳过。电脑睡眠时错过的只补跑一次。"),
      h("label", { class: "project-field" }, "名称", name),
      h("label", { class: "project-field" }, "内容", prompt),
      h("label", { class: "project-field" }, "方式", kind),
      intervalRow,
      dailyRow,
      error,
      h("div", { class: "dialog-actions" }, h("span", { class: "spacer" }), h("button", { type: "button", onclick: () => dlg.close() }, "取消"), h("button", { type: "button", class: "primary", onclick: save }, "保存")),
    ),
  );
  dlg.showModal();
  name.focus();
}
