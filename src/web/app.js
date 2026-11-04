import { avatar } from "./avatar.js";
import { renderMarkdown } from "./markdown.js";
import { icon } from "./icons.js";
import { mountResearch } from "./research.js";
import { mountSettings } from "./settings.js";
import { mountTasks, TASK_STATUS } from "./tasks.js";
import { mountInbox } from "./inbox.js";

const AGENT_LABEL = { claude: "Claude Code", codex: "Codex", grok: "Grok Build", antigravity: "Antigravity" };
const EFFORT_LABEL = { low: "低", medium: "中", high: "高" };
const PERMISSION_LABEL = { ask: "每次询问", auto_edit: "自动改文件（工作目录）", read_only: "只读（不能改文件）" };
const ROUTE_LABEL = { official: "官方直连", gateway: "经本机网关（Magpie）" };
const APPROVAL_STATUS = { allowed: "已允许", allowed_session: "本对话已允许", denied: "已拒绝", expired: "已失效" };

// Applied before the first paint from the last known values, then corrected from the server.
function applyAppearance(a) {
  const root = document.documentElement;
  const dark = a.theme === "dark" || (a.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.accent = a.accent ?? "indigo";
  root.dataset.font = a.font ?? "medium";
  root.dataset.density = a.density ?? "comfortable";
  root.dataset.width = a.width ?? "normal";
  localStorage.setItem("bot-appearance", JSON.stringify({ theme: a.theme, accent: a.accent, font: a.font, density: a.density, width: a.width }));
  if (state.settings !== a) state.settings = a;
  $("app").classList.toggle("no-details", a.details_open === false);
}

const state = {
  settings: null,
  bots: [],
  groups: [],
  agents: {},
  botId: null,
  groupId: null,
  trace: null,
  worktrees: [],
  view: "chat",
  page: null,
  quota: null,
  chiefDefaultRole: "",
  convId: null,
  items: [],
  connected: true,
  loadError: null,
  sidebarOpen: false,
  drafts: new Map(),
  sending: false,
  sendError: null,
};

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

// replaceChildren turns null into the text "null", so optional children are dropped first.
const setChildren = (root, ...children) => root.replaceChildren(...children.flat().filter(Boolean));

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.body !== undefined ? { "content-type": "application/json" } : {}) } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("连不上守护进程，请确认它还在运行");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const currentBot = () => state.bots.find((b) => b.id === state.botId) ?? null;
const currentGroup = () => state.groups.find((g) => g.id === state.groupId) ?? null;
const currentEntity = () => currentGroup() ?? currentBot();
const currentConv = () => currentEntity()?.conversations.find((c) => c.id === state.convId) ?? null;
const botById = (id) => state.bots.find((b) => b.id === id);
const groupMembers = (g) => g.members.map(botById).filter(Boolean);
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function modelLabel(m) {
  const claude = m.match(/^claude-([a-z]+)-(\d+)-(\d+)$/);
  if (claude) return `${titleCase(claude[1])} ${claude[2]}.${claude[3]}`;
  const gemini = m.match(/^gemini-([\d.]+)-([a-z]+)$/);
  if (gemini) return `Gemini ${gemini[1]} ${titleCase(gemini[2])}`;
  if (m.startsWith("grok-")) return titleCase(m).replace("-build-fast", " Fast").replace("-", " ");
  const gpt = m.match(/^gpt-([\d.]+)-([a-z]+)$/);
  if (gpt) return `GPT-${gpt[1]} ${titleCase(gpt[2])}`;
  return m;
}

function compact(n) {
  if (!n) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function timeLabel(ms) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

// ---------- routing ----------
function writeHash() {
  const tail = state.convId ? `/${state.convId}` : "";
  const next = state.groupId ? `#/g/${state.groupId}${tail}` : state.botId ? `#/${state.botId}${tail}` : "";
  if (location.hash !== next) history.replaceState(null, "", next || location.pathname);
}

function readHash() {
  const parts = location.hash.split("/");
  if (parts[1] === "g") return { groupId: parts[2], convId: parts[3] };
  return { botId: parts[1], convId: parts[2] };
}

function leaveResearch() {
  state.view = "chat";
  state.page = null;
  $("app").classList.remove("full-page");
}

async function selectGroup(groupId, convId) {
  leaveResearch();
  saveDraft();
  state.groupId = groupId;
  state.botId = null;
  state.sendError = null;
  state.sidebarOpen = false;
  const g = currentGroup();
  state.convId = convId && g?.conversations.some((c) => c.id === convId) ? convId : (g?.conversations[0]?.id ?? null);
  await loadItems();
}

async function selectBot(botId, convId) {
  leaveResearch();
  saveDraft();
  state.botId = botId;
  state.groupId = null;
  state.sendError = null;
  state.sidebarOpen = false;
  const bot = currentBot();
  state.convId = convId && bot?.conversations.some((c) => c.id === convId) ? convId : (bot?.conversations[0]?.id ?? null);
  await loadItems();
}

async function selectConversation(convId) {
  leaveResearch();
  saveDraft();
  state.convId = convId;
  state.sendError = null;
  state.sidebarOpen = false;
  await loadItems();
}

function newConversation() {
  leaveResearch();
  saveDraft();
  state.convId = null;
  state.items = [];
  state.trace = null;
  state.worktrees = [];
  state.sendError = null;
  state.sidebarOpen = false;
  writeHash();
  render({ focus: true });
}

async function loadItems() {
  writeHash();
  if (!state.convId) {
    state.items = [];
    state.trace = null;
    state.worktrees = [];
    render({ focus: true });
    return;
  }
  const target = state.convId;
  try {
    const [{ items, activity }, trace, { worktrees }] = await Promise.all([api(`/api/conversations/${target}/items`), api(`/api/conversations/${target}/trace`), api(`/api/conversations/${target}/worktrees`)]);
    if (state.convId !== target) return;
    state.items = items;
    state.activity = activity;
    state.trace = trace;
    state.worktrees = worktrees;
    state.loadError = null;
  } catch (e) {
    state.loadError = e.message;
  }
  render({ scroll: true, focus: true });
}

function saveDraft() {
  // The box remembers its own key: by the time this runs, the selection may have moved on.
  const box = $("composer-input");
  if (box) state.drafts.set(box.dataset.draftKey, box.value);
}
const draftKey = () => `${state.botId}/${state.convId ?? "new"}`;

// ---------- server events ----------
function connectEvents() {
  const es = new EventSource("/api/events");
  es.onopen = () => {
    if (!state.connected) {
      state.connected = true;
      refreshAll();
    }
  };
  es.onerror = () => {
    if (state.connected) {
      state.connected = false;
      renderMainOnly();
    }
  };
  es.onmessage = (e) => handleEvent(JSON.parse(e.data));
}

const pendingDeltas = new Set();
let deltaFrame = 0;

function handleEvent(ev) {
  switch (ev.type) {
    case "delta": {
      const item = state.items.find((i) => i.id === ev.itemId);
      if (ev.convId !== state.convId || !item) return;
      item.data.text = (item.data.text ?? "") + ev.text;
      pendingDeltas.add(item.id);
      if (!deltaFrame) deltaFrame = requestAnimationFrame(flushDeltas);
      return;
    }
    case "item": {
      // What a task is waiting on includes approvals, which do not touch its call.
      if (ev.item.type === "approval") refreshTasksPage();
      if (INBOX_TYPES.includes(ev.item.type)) refreshInbox();
      if (ev.item.conv_id !== state.convId) {
        if (ev.item.type === "approval") renderSidebar();
        return;
      }
      // This full copy supersedes any text still waiting for the next frame.
      pendingDeltas.delete(ev.item.id);
      const i = state.items.findIndex((x) => x.id === ev.item.id);
      if (i >= 0) {
        state.items[i] = ev.item;
        replaceItemNode(ev.item);
      } else {
        state.items.push(ev.item);
        appendItemNode(ev.item);
      }
      return;
    }
    case "activity": {
      if (ev.convId !== state.convId) return;
      state.activity = ev.activity;
      renderActivity();
      return;
    }
    case "budget": {
      if (ev.convId !== state.convId) return;
      state.trace = { calls: state.trace?.calls ?? [], budget: { spent: ev.spent, limit: ev.limit, active: ev.active } };
      renderDetails();
      return;
    }
    case "research": {
      if (state.view === "research") state.page?.refresh();
      return;
    }
    case "settings": {
      applyAppearance(ev.settings);
      renderDetails();
      restartQuotaTimer();
      return;
    }
    case "bots_changed": {
      api("/api/state").then((fresh) => {
        state.bots = fresh.bots;
        state.groups = fresh.groups;
        renderSidebar();
        renderDetails();
      }, () => {});
      return;
    }
    case "worktrees": {
      if (ev.convId === state.convId) refreshWorktrees();
      return;
    }
    case "trace": {
      refreshTasksPage();
      if (ev.convId === state.convId) refreshTrace();
      return;
    }
    case "group": {
      const i = state.groups.findIndex((g) => g.id === ev.group.id);
      if (i >= 0) state.groups[i] = ev.group;
      else state.groups.push(ev.group);
      render();
      return;
    }
    case "group_archived": {
      refreshInbox();
      state.groups = state.groups.filter((g) => g.id !== ev.groupId);
      if (state.groupId === ev.groupId) {
        state.groupId = null;
        selectBot(state.bots[0]?.id ?? null);
      } else renderSidebar();
      return;
    }
    case "conversation": {
      const owner = ev.conversation.group_id ? state.groups.find((g) => g.id === ev.conversation.group_id) : state.bots.find((b) => b.id === ev.conversation.bot_id);
      if (!owner) return;
      const i = owner.conversations.findIndex((c) => c.id === ev.conversation.id);
      if (i >= 0) owner.conversations[i] = ev.conversation;
      else owner.conversations.unshift(ev.conversation);
      owner.conversations.sort((a, b) => b.updated_at - a.updated_at);
      renderSidebar();
      if (ev.conversation.id === state.convId) {
        renderChatTitle();
        renderComposerState();
      }
      return;
    }
    case "usage": {
      const bot = state.bots.find((b) => b.id === ev.botId);
      if (bot) bot.usage = ev.usage;
      renderDetails();
      return;
    }
    case "bot": {
      const i = state.bots.findIndex((b) => b.id === ev.bot.id);
      if (i >= 0) state.bots[i] = ev.bot;
      else state.bots.push(ev.bot);
      render();
      return;
    }
    case "bot_archived": {
      refreshInbox();
      state.bots = state.bots.filter((b) => b.id !== ev.botId);
      if (state.botId === ev.botId) selectBot(state.bots[0]?.id ?? null);
      else renderSidebar();
      return;
    }
    case "conversation_archived": {
      refreshInbox();
      const owner = ev.groupId ? state.groups.find((g) => g.id === ev.groupId) : state.bots.find((b) => b.id === ev.botId);
      if (owner) owner.conversations = owner.conversations.filter((c) => c.id !== ev.convId);
      if (state.convId === ev.convId) newConversation();
      else renderSidebar();
      return;
    }
  }
}

function flushDeltas() {
  deltaFrame = 0;
  for (const id of pendingDeltas) {
    const item = state.items.find((i) => i.id === id);
    if (item) replaceItemNode(item);
  }
  pendingDeltas.clear();
}

async function refreshWorktrees() {
  const target = state.convId;
  if (!target) return;
  const data = await api(`/api/conversations/${target}/worktrees`).catch(() => null);
  if (data && state.convId === target) {
    state.worktrees = data.worktrees;
    renderDetails();
  }
}

const INBOX_TYPES = ["approval", "queued", "result"];
let inboxTimer = 0;
function refreshInbox() {
  clearTimeout(inboxTimer);
  inboxTimer = setTimeout(loadInbox, 200);
}
async function loadInbox() {
  try {
    const { items } = await api("/api/inbox");
    const changed = items.length !== state.inbox?.length;
    state.inbox = items;
    if (changed) renderSidebar();
    if (state.view === "inbox") state.page?.update(items);
  } catch {
    // The connection banner already says so; the count just stays as it was.
  }
}

let tasksTimer = 0;
function refreshTasksPage() {
  if (state.view !== "tasks") return;
  clearTimeout(tasksTimer);
  tasksTimer = setTimeout(() => {
    if (state.view === "tasks") state.page?.refresh();
  }, 150);
}

let traceTimer = 0;
function refreshTrace() {
  clearTimeout(traceTimer);
  traceTimer = setTimeout(async () => {
    const target = state.convId;
    if (!target) return;
    const trace = await api(`/api/conversations/${target}/trace`).catch(() => null);
    if (trace && state.convId === target) {
      state.trace = trace;
      renderDetails();
    }
  }, 120);
}

async function refreshAll() {
  void loadInbox();
  try {
    const s = await api("/api/state");
    state.bots = s.bots;
    state.groups = s.groups;
    state.agents = s.agents;
    state.chiefDefaultRole = s.chief_default_role;
    state.steerable = s.steerable ?? [];
    applyAppearance(s.settings);
    restartQuotaTimer();
    state.loadError = null;
    if (!currentEntity()) {
      const { botId, groupId, convId } = readHash();
      if (s.groups.some((g) => g.id === groupId)) return selectGroup(groupId, convId);
      const target = s.bots.find((b) => b.id === botId) ? botId : s.bots[0]?.id;
      if (target) return selectBot(target, convId);
    }
    if (state.convId && !currentConv()) state.convId = null;
    await loadItems();
  } catch (e) {
    state.loadError = e.message;
    render();
  }
}

// ---------- actions ----------
async function send() {
  const box = $("composer-input");
  const text = box.value;
  const group = currentGroup();
  const bot = currentBot();
  if (!text.trim() || !(bot || group) || state.sending) return;
  state.sending = true;
  state.sendError = null;
  renderComposerState();
  try {
    const conv = await api(group ? `/api/groups/${group.id}/messages` : `/api/bots/${bot.id}/messages`, { method: "POST", body: { text, conversationId: state.convId } });
    state.drafts.delete(draftKey());
    box.value = "";
    autoGrow(box);
    if (state.convId !== conv.id) {
      state.convId = conv.id;
      box.dataset.draftKey = draftKey();
      // Events for this conversation may have arrived before its id was known here.
      const { items } = await api(`/api/conversations/${conv.id}/items`);
      state.items = items;
      writeHash();
      renderChatTitle();
      renderSidebar();
      renderTimeline({ scroll: true });
    }
  } catch (e) {
    state.sendError = e.message;
  }
  state.sending = false;
  renderComposerState();
  box.focus();
}

// While a round runs, a message waits for it to end, or joins it if the agent can take that.
async function followUp(mode) {
  const box = $("composer-input");
  const text = box.value;
  if (!text.trim() || !state.convId || state.sending) return;
  state.sending = true;
  state.sendError = null;
  renderComposerState();
  try {
    const r = await api(`/api/conversations/${state.convId}/followup`, { method: "POST", body: { text, mode } });
    state.drafts.delete(draftKey());
    box.value = "";
    autoGrow(box);
    if (mode === "steer" && r.delivered === "queued") state.sendError = "这一步无法中途补充，已改为排队，这一轮结束后发出。";
  } catch (e) {
    state.sendError = e.message;
  }
  state.sending = false;
  renderComposerState();
  box.focus();
}

async function withdrawQueued(item) {
  try {
    const { text } = await api(`/api/items/${item.id}/withdraw`, { method: "POST", body: {} });
    const box = $("composer-input");
    fillComposer(box.value.trim() ? `${box.value}\n${text}` : text);
  } catch (e) {
    state.sendError = e.message;
    renderComposerState();
  }
}

async function stopTurn() {
  if (!state.convId) return;
  try {
    await api(`/api/conversations/${state.convId}/interrupt`, { method: "POST", body: {} });
  } catch (e) {
    state.sendError = e.message;
    renderComposerState();
  }
}

async function answerApproval(id, decision) {
  try {
    await api(`/api/approvals/${id}`, { method: "POST", body: { decision } });
  } catch (e) {
    state.sendError = e.message;
    renderComposerState();
  }
}

// ---------- rendering ----------
function render({ scroll = false, focus = false } = {}) {
  $("app").classList.toggle("sidebar-open", state.sidebarOpen);
  renderSidebar();
  renderMain({ scroll, focus });
  renderDetails();
}

function renderMainOnly() {
  renderMain({});
}

function renderSidebar() {
  const root = $("sidebar");
  const convList = (owner) =>
    h(
      "div",
      { class: "conv-list" },
      h("button", { class: `conv-row conv-new${state.convId ? "" : " selected"}`, type: "button", onclick: newConversation }, icon("plus", 14), "新对话"),
      owner.conversations.map((c) =>
        h(
          "div",
          { class: `conv-item${c.id === state.convId ? " selected" : ""}` },
          h("button", { class: "conv-row", type: "button", onclick: () => selectConversation(c.id) }, h("span", { class: "conv-title" }, c.title), c.status === "running" ? h("span", { class: "status-dot small", role: "img", "aria-label": "回复中" }) : h("span", { class: "conv-time" }, timeLabel(c.updated_at))),
          h("button", { class: "conv-archive", type: "button", "aria-label": `归档对话：${c.title}`, title: "归档", onclick: () => archiveConversation(c) }, icon("x", 14)),
        ),
      ),
    );
  const groupRows = state.groups.map((g) => {
    const selected = g.id === state.groupId;
    const running = g.conversations.some((c) => c.status === "running");
    return h(
      "div",
      { class: "bot-group" },
      h(
        "button",
        { class: `bot-row${selected ? " selected" : ""}`, type: "button", "aria-current": selected ? "true" : null, onclick: () => selectGroup(g.id) },
        h("span", { class: "group-avatar" }, groupMembers(g).slice(0, 4).map((m) => avatar(m.id, 17))),
        h("span", { class: "bot-row-text" }, h("span", { class: "bot-row-name" }, g.name), h("span", { class: "bot-row-meta" }, groupMembers(g).map((m) => m.name).join("、"))),
        running ? h("span", { class: "status-dot", role: "img", "aria-label": "回复中" }) : null,
      ),
      selected ? convList(g) : null,
    );
  });
  const rows = state.bots.map((b) => {
    const selected = b.id === state.botId;
    const running = b.conversations.some((c) => c.status === "running");
    const row = h(
      "button",
      { class: `bot-row${selected ? " selected" : ""}`, type: "button", "aria-current": selected ? "true" : null, onclick: () => selectBot(b.id) },
      avatar(b.id),
      h("span", { class: "bot-row-text" }, h("span", { class: "bot-row-name" }, b.name, b.is_chief ? h("span", { class: "tag" }, "主") : null, b.paused ? h("span", { class: "tag muted-tag" }, "已暂停") : null), h("span", { class: "bot-row-meta" }, `${AGENT_LABEL[b.agent]} · ${modelLabel(b.model)}`)),
      running ? h("span", { class: "status-dot", title: "回复中", role: "img", "aria-label": "回复中" }) : null,
    );
    const convs = selected ? convList(b) : null;
    return h("div", { class: "bot-group" }, row, convs);
  });
  setChildren(
    root,
    h("div", { class: "side-brand" }, h("span", { class: "side-logo", "aria-hidden": "true" }, h("span"), h("span"), h("span"), h("span")), "Bot Platform"),
    h("div", { class: "sidebar-head" }, h("span", { class: "brand" }, "群聊"), h("button", { class: "icon-btn", type: "button", "aria-label": "新建群聊", title: "新建群聊", onclick: () => openGroupDialog() }, icon("plus", 16))),
    h("div", { class: "bot-list" }, groupRows.length ? groupRows : h("p", { class: "empty-hint" }, "把几个 Bot 拉进群聊，需要谁就 @ 谁。")),
    h("div", { class: "sidebar-head" }, h("span", { class: "brand" }, "Bots"), h("button", { class: "icon-btn", type: "button", "aria-label": "新建 Bot", title: "新建 Bot", onclick: () => openBotDialog() }, icon("plus", 16))),
    h("div", { class: "bot-list" }, rows.length ? rows : h("p", { class: "empty-hint" }, "还没有 Bot，先建一个。")),
    h("div", { class: "side-foot" }, quotaPanel(), h("button", { class: `side-settings${state.view === "inbox" ? " on" : ""}`, type: "button", onclick: openInbox }, icon("inbox", 16), "待办", state.inbox?.length ? h("span", { class: "inbox-count", "aria-label": `${state.inbox.length} 项待处理` }, String(state.inbox.length)) : null), h("button", { class: `side-settings${state.view === "tasks" ? " on" : ""}`, type: "button", onclick: openTasks }, icon("list", 16), "任务中心"), h("button", { class: `side-settings${state.view === "settings" ? " on" : ""}`, type: "button", onclick: openSettings }, icon("settings", 16), "设置")),
  );
}

// ---------- subscription quota ----------
function resetLabel(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "即将恢复";
  const h = Math.floor(ms / 3600000);
  if (h >= 24) return `${Math.floor(h / 24)} 天后恢复`;
  return h >= 1 ? `${h} 小时后恢复` : `${Math.max(1, Math.floor(ms / 60000))} 分钟后恢复`;
}

function quotaBar(remaining, label) {
  const pct = Math.round(remaining);
  const bar = h("div", { class: "budget-bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": `${label}剩余` }, h("div", { class: `budget-fill${pct <= (state.settings?.low_quota ?? 20) ? " high" : ""}` }));
  bar.firstChild.style.width = `${pct}%`;
  return bar;
}

const tightest = (a) => a.windows.reduce((m, w) => (w.remaining < m.remaining ? w : m), a.windows[0]);

function quotaPanel() {
  const q = state.quota;
  if (!q) return null;
  const byProvider = new Map();
  for (const a of q.accounts) if (!byProvider.has(a.provider)) byProvider.set(a.provider, a);
  return h(
    "section",
    { class: "quota", "aria-label": "订阅额度" },
    h("div", { class: "quota-head" }, h("button", { class: "quota-title", type: "button", onclick: openQuotaDialog }, "订阅额度"), h("button", { class: "icon-btn quota-refresh", type: "button", "aria-label": "刷新额度", title: "刷新（不消耗 token）", onclick: () => loadQuota(true) }, icon("refresh", 14))),
    byProvider.size
      ? [...byProvider.values()].map((a) => {
          const w = tightest(a);
          return h("button", { class: "quota-row", type: "button", onclick: openQuotaDialog, title: `${w.name} · ${resetLabel(w.resetsAt)}` }, h("span", {}, a.label), quotaBar(w.remaining, a.label), h("span", { class: "quota-pct" }, `${Math.round(w.remaining)}%`));
        })
      : h("p", { class: "muted small" }, q.note ?? "读不到额度"),
  );
}

function openQuotaDialog() {
  const dlg = $("bot-dialog");
  const q = state.quota;
  dlg.replaceChildren(
    h(
      "div",
      {},
      h("h2", {}, "订阅额度"),
      q?.note ? h("p", { class: "banner warning" }, q.note) : null,
      (q?.accounts ?? []).map((a) =>
        h(
          "div",
          { class: "quota-account" },
          h("h3", {}, a.label, a.plan ? h("span", { class: "tag" }, a.plan) : null, a.account ? h("span", { class: "muted small quota-user" }, a.account) : null),
          a.windows.map((w) => h("div", { class: "quota-window" }, h("div", { class: "quota-name" }, h("span", {}, w.pool && !w.name.startsWith(w.pool) ? `${w.pool} · ${w.name}` : w.name.replace(/^(.+) - \1\b/, "$1")), h("span", { class: "muted small" }, `剩 ${Math.round(w.remaining)}%  ${resetLabel(w.resetsAt)}`)), quotaBar(w.remaining, w.name))),
        ),
      ),
      h("p", { class: "muted small" }, q?.source === "magpie" ? "数据来自 Magpie，查询不消耗 token。" : "查询不消耗 token。"),
      h("div", { class: "dialog-actions" }, h("span", { class: "spacer" }), h("button", { type: "button", onclick: () => dlg.close() }, "关闭")),
    ),
  );
  dlg.showModal();
}

let quotaTimer = 0;
function restartQuotaTimer() {
  clearInterval(quotaTimer);
  quotaTimer = setInterval(() => {
    if (!document.hidden) loadQuota();
  }, (state.settings?.quota_refresh_minutes ?? 2) * 60000);
}

async function loadQuota(force = false) {
  try {
    state.quota = await api(`/api/quotas${force ? "?refresh=1" : ""}`);
    renderSidebar();
  } catch {}
}

async function archiveConversation(c) {
  if (!confirm(`归档对话“${c.title}”？它会从列表中隐藏。`)) return;
  try {
    await api(`/api/conversations/${c.id}`, { method: "DELETE" });
  } catch (e) {
    state.sendError = e.message;
    renderComposerState();
  }
}

function agentWarning(bot) {
  const a = state.agents[bot.agent];
  if (!a) return null;
  if (!a.installed) return `这台电脑上找不到 ${AGENT_LABEL[bot.agent]}，请先安装。`;
  if (!a.loggedIn) return `${AGENT_LABEL[bot.agent]} 还没登录，请先在终端里登录。`;
  return null;
}

function openResearch() {
  saveDraft();
  state.view = "research";
  const entity = currentEntity();
  state.page = mountResearch($("main"), {
    api,
    h,
    projectId: entity.project_memory,
    title: entity.cwd,
    onBack: () => {
      leaveResearch();
      renderMain({ focus: true });
    },
    openDialog: (title, body) => {
      const dlg = $("bot-dialog");
      dlg.replaceChildren(h("div", {}, h("h2", {}, title), body, h("div", { class: "dialog-actions" }, h("span", { class: "spacer" }), h("button", { type: "button", onclick: () => dlg.close() }, "关闭"))));
      dlg.showModal();
    },
  });
}

function openInbox() {
  saveDraft();
  state.view = "inbox";
  state.sidebarOpen = false;
  $("app").classList.remove("sidebar-open");
  $("app").classList.add("full-page");
  state.page = mountInbox($("main"), {
    h,
    items: state.inbox,
    onBack: () => {
      leaveResearch();
      render({ focus: true });
    },
    onOpen: jumpToItem,
  });
  renderSidebar();
  void loadInbox();
}

async function jumpToItem(entry) {
  await (entry.group_id ? selectGroup(entry.group_id, entry.conv_id) : selectBot(entry.bot_id, entry.conv_id));
  // Selecting falls back to the newest conversation when it cannot find this one.
  const node = state.convId === entry.conv_id ? document.querySelector(`[data-item="${entry.id}"]`) : null;
  if (!node) {
    state.sendError = "没有找到这条待办，它可能刚刚处理完，或者对话已经不在了";
    renderComposerState();
    void loadInbox();
    return;
  }
  node.scrollIntoView({ block: "center" });
  node.classList.add("item-flash");
  setTimeout(() => node.classList.remove("item-flash"), 2000);
}

function openTasks() {
  saveDraft();
  state.view = "tasks";
  state.sidebarOpen = false;
  $("app").classList.remove("sidebar-open");
  $("app").classList.add("full-page");
  state.page = mountTasks($("main"), {
    api,
    h,
    onBack: () => {
      leaveResearch();
      render({ focus: true });
    },
    onOpen: (t) => (t.group_id ? selectGroup(t.group_id, t.conv_id) : selectBot(t.bot_id, t.conv_id)),
  });
  renderSidebar();
}

function openSettings() {
  saveDraft();
  state.view = "settings";
  state.sidebarOpen = false;
  $("app").classList.remove("sidebar-open");
  $("app").classList.add("full-page");
  state.page = mountSettings($("main"), {
    api,
    h,
    agentLabel: AGENT_LABEL,
    permissionLabel: PERMISSION_LABEL,
    getAgents: () => state.agents,
    getQuota: () => state.quota,
    refreshQuota: () => loadQuota(true),
    resetLabel,
    applyAppearance,
    onBack: () => {
      leaveResearch();
      render({ focus: true });
    },
  });
  renderSidebar();
}

function renderMain({ scroll = false, focus = false }) {
  if (state.view !== "chat" && state.page) return;
  saveDraft();
  const root = $("main");
  const group = currentGroup();
  const bot = currentBot();
  if (!bot && !group) {
    setChildren(
      root,
      h(
        "div",
        { class: "welcome" },
        state.loadError ? h("p", { class: "banner danger" }, state.loadError) : null,
        h("h1", {}, "建一个 Bot 开始"),
        h("p", {}, "每个 Bot 都有自己的职责，底层调用你已登录的官方 agent。"),
        h("button", { class: "primary", type: "button", onclick: () => openBotDialog() }, "新建 Bot"),
      ),
    );
    return;
  }
  const warn = bot ? agentWarning(bot) : null;
  const conv = currentConv();
  const stale = bot && conv && conv.agent !== bot.agent;
  const entity = group ?? bot;
  setChildren(
    root,
    h(
      "header",
      { class: "chat-head" },
      h("button", { class: "icon-btn menu-btn", type: "button", "aria-label": "打开 Bot 列表", onclick: toggleSidebar }, icon("menu")),
      group ? h("span", { class: "group-avatar" }, groupMembers(group).slice(0, 4).map((m) => avatar(m.id, 15))) : avatar(bot.id, 32),
      h("div", { class: "chat-head-text" }, h("h1", {}, entity.name), h("p", {}, conv?.title ?? "新对话")),
      h("span", { class: "chip" }, group ? `${group.members.length} 个成员` : `${AGENT_LABEL[bot.agent]} · ${modelLabel(bot.model)}`),
      entity.research_enabled ? h("button", { class: "head-action", type: "button", onclick: openResearch }, icon("flask", 15), "实验") : null,
      h("button", { class: "head-edit", type: "button", onclick: () => (group ? openGroupDialog(group) : openBotDialog(bot)) }, "编辑"),
      h("button", { class: "icon-btn head-panel", type: "button", "aria-label": "显示或隐藏信息栏", title: "信息栏", onclick: toggleDetails }, icon("panel")),
    ),
    !state.connected ? h("div", { class: "banner warning", role: "status" }, "和守护进程的连接断开了，正在重连…") : null,
    state.loadError ? h("div", { class: "banner danger", role: "alert" }, state.loadError) : null,
    warn ? h("div", { class: "banner warning" }, warn) : null,
    stale ? h("div", { class: "banner warning" }, `这个 Bot 已换成 ${AGENT_LABEL[bot?.agent]}，旧对话只能查看。要继续请新建对话。`) : null,
    h("div", { id: "timeline", class: "timeline", role: "log", "aria-live": "polite" }),
    renderComposer(entity),
  );
  renderTimeline({ scroll: true });
  renderComposerState();
  if (focus && window.innerWidth > 720) $("composer-input")?.focus();
  void scroll;
}

function renderChatTitle() {
  const el = document.querySelector(".chat-head p");
  if (el) el.textContent = currentConv()?.title ?? "新对话";
}

async function toggleDetails() {
  const next = { ...state.settings, details_open: state.settings?.details_open === false };
  applyAppearance(next);
  await api("/api/settings", { method: "PUT", body: { details_open: next.details_open } }).catch(() => {});
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  $("app").classList.toggle("sidebar-open", state.sidebarOpen);
}

// ---------- @ mentions ----------
const mention = { open: false, index: 0, options: [], start: 0 };

function updateMention(box) {
  const group = currentGroup();
  const popup = $("mention-popup");
  if (!popup) return;
  const before = box.value.slice(0, box.selectionStart);
  const m = group && before.match(/@([^\s@]*)$/);
  mention.options = m ? groupMembers(group).filter((b) => b.name.toLowerCase().startsWith(m[1].toLowerCase())) : [];
  mention.open = mention.options.length > 0;
  if (!mention.open) {
    popup.hidden = true;
    return;
  }
  mention.index = Math.min(mention.index, mention.options.length - 1);
  mention.start = before.length - m[0].length;
  popup.hidden = false;
  popup.replaceChildren(
    ...mention.options.map((b, i) =>
      h(
        "button",
        { class: `mention-option${i === mention.index ? " active" : ""}`, type: "button", role: "option", "aria-selected": i === mention.index ? "true" : "false", onmousedown: (e) => (e.preventDefault(), pickMention(box, b)) },
        avatar(b.id, 22),
        h("span", {}, b.name),
        h("span", { class: "muted small" }, `${AGENT_LABEL[b.agent]} · ${modelLabel(b.model)}`),
      ),
    ),
  );
}

function pickMention(box, bot) {
  const after = box.value.slice(box.selectionStart);
  const head = `${box.value.slice(0, mention.start)}@${bot.name} `;
  box.value = head + after;
  box.selectionStart = box.selectionEnd = head.length;
  mention.open = false;
  $("mention-popup").hidden = true;
  box.focus();
}

function renderComposer(entity) {
  const isGroup = Boolean(currentGroup());
  const text = isGroup ? `发消息，用 @ 叫 ${groupMembers(entity).map((m) => m.name).join("、")}` : `给 ${entity.name} 发消息`;
  const box = h("textarea", {
    id: "composer-input",
    rows: 1,
    placeholder: text,
    "aria-label": text,
    oninput: (e) => {
      autoGrow(e.target);
      updateMention(e.target);
    },
    onblur: () => {
      mention.open = false;
      const popup = $("mention-popup");
      if (popup) popup.hidden = true;
    },
    onkeydown: (e) => {
      if (mention.open && !e.isComposing && e.keyCode !== 229) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const n = mention.options.length;
          mention.index = (mention.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
          updateMention(e.target);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          pickMention(e.target, mention.options[mention.index]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          mention.open = false;
          $("mention-popup").hidden = true;
          return;
        }
      }
      // During Chinese input, Enter confirms the composition; it must not send the message.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (currentConv()?.status !== "running") send();
        else followUp(canSteer() && (e.metaKey || e.ctrlKey) ? "steer" : "queue");
      }
    },
  });
  box.dataset.draftKey = draftKey();
  box.value = state.drafts.get(draftKey()) ?? "";
  queueMicrotask(() => autoGrow(box));
  return h(
    "div",
    { class: "composer-wrap" },
    h("p", { id: "send-error", class: "send-error", role: "alert", hidden: true }),
    h("div", { id: "activity-bar", class: "activity-bar", role: "status", hidden: true }),
    h("div", { id: "queue-strip", class: "queue-strip", hidden: true }),
    h("div", { id: "mention-popup", class: "mention-popup", role: "listbox", hidden: true }),
    h(
      "div",
      { class: "composer" },
      box,
      h("button", { id: "steer-btn", class: "steer-btn", type: "button", hidden: true, title: "把这条消息补充进正在进行的这一轮", onclick: () => followUp("steer") }, "立即补充"),
      h("button", { id: "stop-btn", class: "send-btn stop", type: "button", hidden: true, title: "停止回复", "aria-label": "停止回复", onclick: stopTurn }, icon("stop", 17)),
      h("button", { id: "send-btn", class: "send-btn", type: "button" }),
    ),
    h("p", { id: "composer-hint", class: "composer-hint" }),
  );
}

function autoGrow(el) {
  // An empty box needs no measuring, and measuring before layout gives a wrong, huge height.
  if (!el.value) {
    el.style.height = "";
    return;
  }
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}

function renderComposerState() {
  const btn = $("send-btn");
  if (!btn) return;
  const conv = currentConv();
  const bot = currentBot();
  const running = conv?.status === "running";
  const blocked = conv && bot && !currentGroup() && conv.agent !== bot.agent;
  const label = running ? "排队发送" : "发送";
  btn.replaceChildren(icon("send", 17));
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.onclick = running ? () => followUp("queue") : send;
  btn.disabled = state.sending || Boolean(blocked);
  $("stop-btn").hidden = !running;
  const steer = $("steer-btn");
  steer.hidden = !(running && canSteer());
  steer.disabled = state.sending;
  const hint = $("composer-hint");
  if (hint) hint.textContent = !running ? "Enter 发送，Shift + Enter 换行" : canSteer() ? "Enter 排队，这一轮结束后发出；⌘/Ctrl + Enter 立即补充" : "Enter 排队，这一轮结束后发出。这个 agent 或群聊不能中途补充";
  renderQueue();
  renderActivity();
  const box = $("composer-input");
  if (box) box.disabled = Boolean(blocked);
  const err = $("send-error");
  if (err) {
    err.hidden = !state.sendError;
    err.textContent = state.sendError ?? "";
  }
}

const canSteer = () => !currentGroup() && (state.steerable ?? []).includes(currentConv()?.agent);

function renderQueue() {
  const strip = $("queue-strip");
  if (!strip) return;
  const list = state.items.filter((i) => i.type === "queued" && (i.status === "queued" || i.status === "unsent"));
  strip.hidden = !list.length;
  strip.replaceChildren(
    ...list.map((i) =>
      h(
        "div",
        { "data-item": i.id, class: `queued-row ${i.status}` },
        h("span", { class: "chip" }, i.status === "queued" ? "排队中" : "没有发出"),
        h("span", { class: "queued-text", title: i.data.reason ?? i.data.text }, i.data.text),
        h("button", { type: "button", onclick: () => withdrawQueued(i) }, i.status === "queued" ? "撤回" : "放回输入框"),
      ),
    ),
  );
}

const STALE_MS = 120000;
const sinceLabel = (ms) => (ms < 5000 ? "刚刚有更新" : ms < 60000 ? `${Math.round(ms / 1000)} 秒前有更新` : `${Math.round(ms / 60000)} 分钟前有更新`);

function renderActivity() {
  const bar = $("activity-bar");
  if (!bar) return;
  const running = currentConv()?.status === "running";
  bar.hidden = !running;
  clearTimeout(state.activityTimer);
  if (!running) return;
  const a = state.activity ?? { kind: "working", text: "正在处理", at: Date.now() };
  const idle = Date.now() - a.at;
  // Waiting for a person is not being stuck.
  const stale = idle > STALE_MS && a.kind !== "approval" && a.kind !== "waiting";
  bar.className = `activity-bar ${a.kind}${stale ? " stale" : ""}`;
  bar.replaceChildren(h("span", { class: "status-dot small" }), h("span", { class: "activity-text" }, a.text), h("span", { class: "activity-time" }, sinceLabel(idle)));
  if (stale) bar.append(h("span", { class: "activity-stale" }, "很久没有新动静了，可能还在长时间执行，也可能卡住了。可以再等等，或者点停止。"));
  state.activityTimer = setTimeout(renderActivity, 5000);
}

function resultNode(item, attrs) {
  const d = item.data;
  const ended = { completed: "这一轮完成了", failed: "这一轮失败了", interrupted: "这一轮被停止了", over_budget: "这一轮预算用完了" }[item.status] ?? "这一轮结束了";
  const shown = d.files.slice(0, 8);
  const passed = d.checks.filter((c) => c.status === "done").length;
  const failed = d.checks.length - passed;
  const source = d.source === "git" ? "平台用 Git 检查，这一轮期间目录里的变化" : "Bot 的工具上报，平台没有在 Git 里看到这些改动";
  return h(
    "div",
    { ...attrs, class: `result-card ${item.status}` },
    h("div", { class: "result-head" }, h("strong", {}, ended), d.accepted ? h("span", { class: "chip" }, "你已接受") : null),
    d.summary ? h("p", { class: "result-summary" }, h("span", { class: "muted" }, "Bot 自述："), d.summary) : null,
    d.files.length
      ? h(
          "div",
          { class: "result-section" },
          h("p", { class: "call-label" }, `改动 ${d.total} 个文件${d.commits ? `，${d.commits} 个新提交` : ""}（${source}）`),
          h("ul", { class: "result-files" }, shown.map((f) => h("li", {}, h("span", { class: "chip" }, f.change), h("span", { class: "path" }, f.path)))),
          d.total > shown.length ? h("p", { class: "muted small" }, `还有 ${d.total - shown.length} 个文件`) : null,
        )
      : null,
    d.worktrees.length ? h("div", { class: "result-section" }, h("p", { class: "call-label" }, "工作树（在右侧面板合并或丢弃）"), h("ul", { class: "result-files" }, d.worktrees.map((w) => h("li", {}, h("span", { class: "path" }, `${w.bot} · ${w.branch}`), h("span", { class: "muted small" }, w.changes.replace(/^实际改动：\n?/, "").split("\n")[0]))))) : null,
    h(
      "div",
      { class: "result-section" },
      h("p", { class: "call-label" }, "验证"),
      d.checks.length
        ? h("p", { class: failed ? "result-failed" : "small" }, `平台记录到 ${d.checks.length} 条检查命令：${passed} 条成功${failed ? `，${failed} 条失败` : ""}。`, h("span", { class: "muted" }, ` ${d.checks.map((c) => c.command).slice(0, 3).join("；")}`))
        : h("p", { class: "muted small" }, "平台没有记录到测试或检查命令。Bot 说验证过的，请自己确认。"),
    ),
    h(
      "div",
      { class: "approval-actions" },
      d.repo ? h("button", { type: "button", onclick: () => openResultDiff(item) }, "查看改动") : null,
      h("button", { type: "button", onclick: () => fillComposer("请继续修改：") }, "继续修改"),
      d.accepted ? null : h("button", { type: "button", class: "primary", title: "只记下你看过并接受了，不会合并或提交任何东西", onclick: () => acceptResult(item) }, "接受结果"),
    ),
  );
}

async function acceptResult(item) {
  try {
    await api(`/api/items/${item.id}/accept`, { method: "POST", body: {} });
  } catch (e) {
    state.sendError = e.message;
    renderComposerState();
  }
}

async function openResultDiff(item) {
  const dlg = $("bot-dialog");
  const body = h("pre", { class: "diff-view" }, "读取中…");
  dlg.replaceChildren(h("div", {}, h("h2", {}, "这一轮的改动"), h("p", { class: "muted small" }, "相对这一轮开始时的提交。这些文件在这一轮之前已有的未提交改动也会显示。"), body, h("div", { class: "dialog-actions" }, h("span", { class: "spacer" }), h("button", { type: "button", onclick: () => dlg.close() }, "关闭"))));
  dlg.showModal();
  try {
    const d = await api(`/api/items/${item.id}/diff`);
    const extra = d.untracked.length ? `\n新文件：\n${d.untracked.map((f) => `  ${f}`).join("\n")}\n` : "";
    body.textContent = (d.diff + extra).trim() || "现在已经没有差异了，这些改动可能又被改回去了。";
    if (d.clipped) body.textContent += "\n\n…（改动太长，已截断）";
    if (d.clippedFiles) body.textContent += "\n\n…（文件太多，只比较了前面一部分）";
  } catch (e) {
    body.textContent = e.message;
  }
}

// Adds to what is already being typed, because the person did not ask to lose that.
function addToComposer(text) {
  const box = $("composer-input");
  if (!box) return;
  fillComposer(box.value.trim() ? `${box.value.trimEnd()}\n${text}` : text);
}

function fillComposer(text) {
  const box = $("composer-input");
  if (!box) return;
  box.value = text;
  autoGrow(box);
  box.focus();
}

function renderTimeline({ scroll = false } = {}) {
  const log = $("timeline");
  if (!log) return;
  const bot = currentBot();
  const group = currentGroup();
  if (!state.items.length) {
    log.replaceChildren(
      group
        ? h("div", { class: "empty-chat" }, h("span", { class: "group-avatar large" }, groupMembers(group).slice(0, 4).map((m) => avatar(m.id, 30))), h("h2", {}, group.name), h("p", {}, "用 @ 叫成员回复。一次 @ 多个时会依次回复，后面的能看到前面说的话。"), h("p", { class: "muted" }, groupMembers(group).map((m) => m.name).join("、")))
        : h(
            "div",
            { class: "empty-chat" },
            avatar(bot.id, 60),
            h("h2", {}, bot.name),
            h("p", { class: "empty-role" }, bot.role || "这个 Bot 还没有写职责。"),
            h("p", { class: "small" }, `${AGENT_LABEL[bot.agent]} · ${modelLabel(bot.model)}`),
            bot.is_chief ? h("div", { class: "starter-list" }, ["帮我拆解一个任务", "团队里现在有谁", "帮我调研一个问题"].map((t) => h("button", { class: "starter", type: "button", onclick: () => fillComposer(t) }, t))) : null,
          ),
    );
    return;
  }
  log.replaceChildren(...state.items.map(itemNode).filter(Boolean));
  if (scroll) log.scrollTop = log.scrollHeight;
  renderComposerState();
}

function stickToBottom(log, wasNear) {
  if (wasNear) log.scrollTop = log.scrollHeight;
}
const nearBottom = (log) => log.scrollHeight - log.scrollTop - log.clientHeight < 120;

function appendItemNode(item) {
  const log = $("timeline");
  if (!log) return;
  const near = nearBottom(log);
  if (log.querySelector(".empty-chat")) log.replaceChildren();
  const node = itemNode(item);
  if (node) log.append(node);
  renderComposerState();
  // A new message makes the retry on an earlier failure out of date.
  if (item.type === "user") for (const e of state.items) if (e.type === "error") replaceItemNode(e);
  stickToBottom(log, near || item.type === "user" || item.type === "approval");
}

function replaceItemNode(item) {
  const log = $("timeline");
  if (!log) return;
  const near = nearBottom(log);
  const cur = log.querySelector(`[data-item="${item.id}"]`);
  const node = itemNode(item);
  if (cur && node) {
    // Keep an expanded tool card expanded while its status updates.
    if ((item.type === "tool" || item.type === "call") && cur.querySelector("details")?.open) node.querySelector("details")?.setAttribute("open", "");
    cur.replaceWith(node);
  } else if (cur) cur.remove();
  else if (node) log.append(node);
  renderComposerState();
  stickToBottom(log, near);
}

function itemNode(item) {
  const d = item.data ?? {};
  const attrs = { "data-item": item.id };
  switch (item.type) {
    case "user":
      return h("div", { ...attrs, class: "msg user" }, d.steered ? h("span", { class: "chip" }, "运行中补充") : null, h("div", { class: "bubble" }, d.text));
    case "result":
      return resultNode(item, attrs);
    case "assistant": {
      const body = h("div", { class: "md" });
      body.innerHTML = renderMarkdown(d.text); // Output of the escaping renderer in markdown.js.
      const who = d.bot?.id ?? currentBot()?.id ?? item.conv_id;
      return h(
        "div",
        { ...attrs, class: `msg assistant${item.status === "streaming" ? " streaming" : ""}` },
        h("div", { class: "msg-avatar" }, avatar(who, 28)),
        h("div", { class: "msg-body" }, d.bot ? h("div", { class: "speaker" }, d.bot.name) : null, body, item.status === "interrupted" ? h("p", { class: "note" }, "这段回复被中断了") : null),
      );
    }
    case "tool": {
      if (item.status === "hidden") return null;
      const label = { running: "进行中", done: "完成", failed: "失败", interrupted: "已中断" }[item.status] ?? item.status;
      return h(
        "div",
        { ...attrs, class: `tool-card ${item.status}` },
        h(
          "details",
          {},
          h("summary", {}, h("span", { class: "tool-title" }, d.title), h("span", { class: "tool-status" }, label)),
          d.detail ? h("pre", {}, d.detail) : null,
          d.output ? h("pre", { class: "tool-output" }, d.output) : null,
        ),
      );
    }
    case "approval": {
      const pending = item.status === "pending";
      return h(
        "div",
        { ...attrs, class: `approval-card ${item.status}` },
        h("div", { class: "approval-head" }, h("strong", {}, pending ? (d.kind === "bot_proposal" ? "Chief 的提议" : "需要你确认") : APPROVAL_STATUS[item.status]), h("span", {}, d.from ? `${d.from}：${d.title}` : d.title)),
        d.detail ? h("details", { open: pending ? true : null }, h("summary", {}, "查看详情"), h("pre", {}, d.detail)) : null,
        pending
          ? h(
              "div",
              { class: "approval-actions" },
              h("button", { class: "primary", type: "button", onclick: () => answerApproval(item.id, "allow") }, d.kind ? "批准" : "允许一次"),
              d.kind === "bot_proposal" ? h("button", { type: "button", onclick: () => openBotDialog(undefined, item) }, "修改后批准") : null,
              d.canRemember ? h("button", { type: "button", onclick: () => answerApproval(item.id, "allow_session") }, "本对话都允许") : null,
              h("button", { class: "danger", type: "button", onclick: () => answerApproval(item.id, "deny") }, "拒绝"),
            )
          : null,
      );
    }
    case "call":
      return callNode(item, attrs);
    case "job": {
      const label = { running: "运行中", done: "完成", failed: "失败", lost: "进程丢失", cancelled: "已取消" }[item.status] ?? item.status;
      const metrics = Object.entries(d.metrics ?? {}).map(([k, v]) => `${k} ${typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(4)) : v}`).join("，");
      return h("div", { ...attrs, class: `call-card ${item.status === "running" ? "running" : item.status === "done" ? "done" : "failed"}` }, h("div", { class: "job-line" }, h("span", { class: "call-route" }, `实验：${d.name}`), h("span", { class: "tool-title call-preview" }, [d.seed !== null && d.seed !== undefined ? `种子 ${d.seed}` : "", metrics].filter(Boolean).join(" · ")), h("span", { class: "tool-status" }, label)));
    }
    case "notice":
      return h("div", { ...attrs, class: "turn-summary" }, `平台通知：${String(d.text ?? "").split("\n")[0]}`);
    case "error":
      return errorNode(item, attrs);
    case "turn_summary": {
      const parts = [];
      if (d.bot) parts.push(d.bot.name);
      if (item.status === "interrupted") parts.push("已停止");
      if (d.ms) parts.push(`${(d.ms / 1000).toFixed(1)} 秒`);
      if (d.inputTokens || d.outputTokens) parts.push(`输入 ${compact(d.inputTokens)} · 输出 ${compact(d.outputTokens)}`);
      if (typeof d.costUsd === "number") parts.push(`估算 $${d.costUsd.toFixed(3)}`);
      return parts.length ? h("div", { ...attrs, class: "turn-summary" }, parts.join(" · ")) : null;
    }
    default:
      return null;
  }
}

function errorNode(item, attrs) {
  const d = item.data;
  const text = d.bot ? `${d.bot.name}：${d.message}` : d.message;
  if (d.noRecover) return h("div", { ...attrs, class: "error-card", role: "alert" }, text);
  const openHandoff = (r) => {
    const bot = botById(r.botId);
    if (bot) selectBot(bot.id, r.convId);
  };
  const r = d.recovery;
  return h(
    "div",
    { ...attrs, class: "error-card", role: "alert" },
    h("div", {}, text),
    r
      ? h("div", { class: "error-recovery" }, h("span", { class: "chip" }, r.action === "handoff" ? `已交给 ${r.bot}` : "已重试"), r.action === "handoff" ? h("button", { type: "button", class: "link-btn", onclick: () => openHandoff(r) }, "打开接手的对话") : null)
      : h(
          "div",
          { class: "approval-actions" },
          canRetry(item) ? h("button", { type: "button", title: "再跑一次失败的这一步，预算、调用限制和审批照常生效。这一轮已经结束时会新开一轮，占用一份每轮预算", onclick: (e) => retryFailure(item, e.currentTarget) }, "重试这一步") : null,
          h("button", { type: "button", onclick: () => openHandoffDialog(item) }, "换 Bot 接手"),
          h("button", { type: "button", onclick: () => addToComposer(`${d.bot ? `@${d.bot.name} ` : ""}补充信息：`) }, "补充信息"),
        ),
  );
}

// The daemon decides; this only hides a button it would certainly refuse.
function canRetry(item) {
  const d = item.data;
  if (d.callId) return d.callMode === "task";
  if (!d.requestItemId) return false;
  const at = state.items.findIndex((i) => i.id === item.id);
  return at >= 0 && !state.items.slice(at + 1).some((i) => i.type === "user");
}

// A failure inside an opened call card is not in state.items, so its card is redrawn from the reply.
function showRecovered(item) {
  document.querySelector(`[data-item="${item.id}"]`)?.replaceWith(itemNode(item));
}

async function retryFailure(item, button) {
  button.disabled = true;
  try {
    showRecovered(await api(`/api/items/${item.id}/retry`, { method: "POST", body: {} }));
    state.sendError = null;
  } catch (e) {
    button.disabled = false;
    state.sendError = `不能重试：${e.message}`;
  }
  renderComposerState();
}

function openHandoffDialog(item) {
  const dlg = $("bot-dialog");
  const failed = item.data.bot?.id ?? (item.conv_id === state.convId ? currentBot()?.id : null);
  const from = item.conv_id === state.convId ? currentConv()?.cwd : null;
  const error = h("p", { class: "result-failed small", role: "alert", hidden: true });
  const choose = async (bot, button) => {
    button.disabled = true;
    try {
      const { item: updated } = await api(`/api/items/${item.id}/handoff`, { method: "POST", body: { botId: bot.id } });
      showRecovered(updated);
      dlg.close();
    } catch (e) {
      button.disabled = false;
      error.textContent = e.message;
      error.hidden = false;
    }
  };
  const row = (b) => {
    const note = from === undefined || from === null ? "工作目录可能不同，不一定看得到上一位的改动" : from === b.cwd ? "工作目录相同" : `工作目录不同（${b.cwd}），看不到上一位的改动`;
    return h("button", { type: "button", class: "handoff-row", onclick: (e) => choose(b, e.currentTarget) }, h("span", { class: "handoff-name" }, avatar(b.id, 22), b.name, b.paused ? h("span", { class: "tag muted-tag" }, "已暂停") : null), h("span", { class: "muted small" }, note));
  };
  const bots = state.bots.filter((b) => b.id !== failed);
  dlg.replaceChildren(
    h(
      "div",
      {},
      h("h2", {}, "换 Bot 接手"),
      h("p", { class: "muted small" }, "会和它新开一个对话，把原来的请求、失败原因和平台记录到的改动写给它。上一位的会话上下文带不过去，它要先检查现状。这会占用它的一份每轮预算，审批按它自己的设置。"),
      bots.length ? h("div", { class: "handoff-list" }, bots.map(row)) : h("p", { class: "muted" }, "没有别的 Bot 可以接手。"),
      error,
      h("div", { class: "dialog-actions" }, h("span", { class: "spacer" }), h("button", { type: "button", onclick: () => dlg.close() }, "取消")),
    ),
  );
  dlg.showModal();
}

const CALL_STATUS = TASK_STATUS;

function callNode(item, attrs) {
  const d = item.data;
  const body = h("div", { class: "call-body" });
  const answer = h("div", { class: "md" });
  answer.innerHTML = renderMarkdown(d.answer ?? ""); // Output of the escaping renderer in markdown.js.
  const process = h("div", { class: "call-process" });
  body.append(h("p", { class: "call-label" }, "问题"), h("div", { class: "call-question" }, d.question));
  if (d.answer) body.append(h("p", { class: "call-label" }, item.status === "refused" ? "原因" : "回答"), answer);
  if (d.childConvId) body.append(h("p", { class: "call-label" }, "对方的过程"), process);
  return h(
    "div",
    { ...attrs, class: `call-card ${item.status}` },
    h(
      "details",
      {
        ontoggle: async (e) => {
          if (!e.target.open || !d.childConvId) return;
          const data = await api(`/api/conversations/${d.childConvId}/items`).catch(() => null);
          if (!data) return;
          // The first entry is the request itself, which is already shown above.
          process.replaceChildren(...data.items.map(itemNode).filter(Boolean));
        },
      },
      h("summary", {}, h("span", { class: "call-route" }, `${d.from} → ${d.to}`), d.mode === "task" ? h("span", { class: "chip" }, "后台任务") : null, d.branch ? h("span", { class: "chip" }, "工作树") : null, h("span", { class: "tool-title call-preview" }, d.question), h("span", { class: "tool-status" }, [CALL_STATUS[item.status] ?? item.status, d.tokens ? ` · ${compact(d.tokens)}` : ""].join(""))),
      body,
    ),
  );
}

function traceSection() {
  const t = state.trace;
  if (!t?.budget) return [];
  const { spent, limit, active } = t.budget;
  const pct = limit ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  const bar = h("div", { class: "budget-bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "本轮预算" }, h("div", { class: `budget-fill${pct >= 80 ? " high" : ""}` }));
  bar.firstChild.style.width = `${pct}%`;
  const tree = t.calls.map((c) => {
    const row = h("div", { class: `trace-row ${c.status}` }, h("span", { class: "trace-name" }, `${c.from} → ${c.to}`), h("span", { class: "tool-status" }, [CALL_STATUS[c.status] ?? c.status, c.tokens ? ` · ${compact(c.tokens)}` : ""].join("")));
    row.style.paddingLeft = `${(c.depth - 1) * 12}px`;
    return row;
  });
  return [
    h("h2", { class: "section" }, active ? "本轮预算（进行中）" : "上一轮用量"),
    bar,
    h("p", { class: "muted small budget-text" }, `${compact(spent)} / ${compact(limit)} tokens（不含缓存）`),
    t.calls.length ? h("h2", { class: "section" }, "调用链") : null,
    tree,
  ];
}

function moduleSection(entity) {
  return [
    h("h2", { class: "section" }, "可选功能"),
    h(
      "div",
      { class: "module-row" },
      h("span", {}, "实验工作台", h("span", { class: "muted small block" }, "后台训练、实验记录、想法账本和结果对比。开启后 Bot 会多几个工具。")),
      h(
        "button",
        {
          type: "button",
          onclick: async () => {
            await api(`/api/projects/${entity.project_memory}/settings`, { method: "PUT", body: { enabled: !entity.research_enabled } });
            const fresh = await api("/api/state");
            state.bots = fresh.bots;
            state.groups = fresh.groups;
            render();
          },
        },
        entity.research_enabled ? "关闭" : "开启",
      ),
    ),
  ];
}

function memorySection(entries) {
  return [
    h("h2", { class: "section" }, "记忆"),
    h("div", { class: "memory-links" }, entries.map(([label, scope, id, title]) => h("button", { type: "button", onclick: () => openMemoryDialog(scope, id, title) }, label))),
  ];
}

function worktreeSection() {
  if (!state.worktrees.length) return [];
  return [
    h("h2", { class: "section" }, "工作树"),
    state.worktrees.map((w) =>
      h(
        "div",
        { class: "worktree" },
        h("div", { class: "worktree-name", title: w.path }, w.bot_name, h("span", { class: "path" }, w.branch)),
        h(
          "div",
          { class: "worktree-actions" },
          h("button", { type: "button", onclick: () => openDiffDialog(w) }, "看改动"),
          h("button", { type: "button", onclick: () => worktreeAction(w, "merge") }, "合并"),
          h("button", { class: "danger", type: "button", onclick: () => worktreeAction(w, "discard") }, "丢弃"),
        ),
      ),
    ),
  ];
}

async function worktreeAction(w, action) {
  const text = action === "merge" ? `把 ${w.branch} 提交并合并到 ${w.base_branch}？` : `丢弃 ${w.branch}？这个工作树里的改动会被永久删除，无法恢复。`;
  if (!confirm(text)) return;
  try {
    await api(`/api/worktrees/${w.id}/${action}`, { method: "POST", body: {} });
    state.sendError = null;
  } catch (e) {
    state.sendError = e.message;
  }
  renderComposerState();
  refreshWorktrees();
}

async function openDiffDialog(w) {
  const dlg = $("bot-dialog");
  const body = h("pre", { class: "diff-view" }, "读取中…");
  dlg.replaceChildren(h("div", {}, h("h2", {}, `${w.bot_name} 的改动`), h("p", { class: "muted small" }, `${w.branch} ← 基于 ${w.base_branch}`), body, h("div", { class: "dialog-actions" }, h("span", { class: "spacer" }), h("button", { type: "button", onclick: () => dlg.close() }, "关闭"))));
  dlg.showModal();
  try {
    const d = await api(`/api/worktrees/${w.id}/diff`);
    const extra = d.untracked.length ? `\n新文件：\n${d.untracked.map((f) => `  ${f}`).join("\n")}\n` : "";
    body.textContent = (d.diff + extra).trim() || "没有改动。";
    if (d.clipped) body.textContent += "\n\n…（改动太长，已截断）";
  } catch (e) {
    body.textContent = e.message;
  }
}

async function openMemoryDialog(scope, id, title) {
  const dlg = $("bot-dialog");
  const load = async () => {
    const error = h("p", { class: "send-error", role: "alert", hidden: true });
    let data;
    try {
      data = await api(`/api/memory/${scope}/${id}`);
    } catch (e) {
      data = { content: "", history: [] };
      error.textContent = e.message;
      error.hidden = false;
    }
    const box = h("textarea", { class: "memory-box", rows: 10, "aria-label": title, placeholder: "还没有记忆。Bot 可以用 remember 记下要点，你也可以直接写。" });
    box.value = data.content;
    const act = async (fn) => {
      try {
        await fn();
        await load();
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
      }
    };
    dlg.replaceChildren(
      h(
        "div",
        {},
        h("h2", {}, title),
        h("p", { class: "muted small" }, "每次启动 agent 时会读入最近的内容。这些内容会占用额度，建议只留要点。"),
        box,
        error,
        h("div", { class: "dialog-actions" }, h("span", { class: "spacer" }), h("button", { type: "button", onclick: () => dlg.close() }, "关闭"), h("button", { class: "primary", type: "button", onclick: () => act(() => api(`/api/memory/${scope}/${id}`, { method: "PUT", body: { content: box.value } })) }, "保存")),
        data.history.length ? h("h3", { class: "history-title" }, "历史") : null,
        h(
          "div",
          { class: "history" },
          data.history.map((c, i) =>
            h(
              "div",
              { class: "history-row" },
              h("span", { class: "history-msg", title: c.message }, c.message),
              h("span", { class: "muted small" }, timeLabel(c.at)),
              i === 0 ? null : h("button", { type: "button", onclick: () => confirm(`回滚到“${c.message}”这个版本？之后还能再回滚回来。`) && act(() => api(`/api/memory/${scope}/${id}/rollback`, { method: "POST", body: { hash: c.hash } })) }, "回滚"),
            ),
          ),
        ),
      ),
    );
  };
  dlg.replaceChildren(h("p", {}, "读取中…"));
  if (!dlg.open) dlg.showModal();
  await load();
}

function renderDetails() {
  const root = $("details");
  const group = currentGroup();
  const b = currentBot();
  if (!b && !group) {
    root.replaceChildren();
    return;
  }
  const row = (k, v) => h("div", { class: "kv" }, h("dt", {}, k), h("dd", {}, v));
  if (group) {
    setChildren(
      root,
      h("div", { class: "details-head" }, h("h2", {}, "群聊信息"), h("button", { type: "button", onclick: () => openGroupDialog(group) }, "编辑")),
      h("h2", { class: "section first" }, "成员"),
      ...groupMembers(group).map((m) => h("div", { class: "member-row" }, avatar(m.id, 24), h("span", { class: "member-name" }, m.name), h("span", { class: "muted small" }, modelLabel(m.model)))),
      h("dl", { class: "spaced" }, row("每轮预算", `${compact(group.budget_tokens)} tokens`), h("div", { class: "kv stacked" }, h("dt", {}, "共用工作目录"), h("dd", { class: "path", title: group.cwd }, group.cwd))),
      ...worktreeSection(),
      ...memorySection([["项目记忆", "project", group.project_memory, `${group.name} 的项目记忆`]]),
      ...moduleSection(group),
      ...traceSection(),
    );
    return;
  }
  const u = b.usage ?? {};
  setChildren(
    root,
    h("div", { class: "details-head" }, h("h2", {}, "Bot 信息"), h("button", { type: "button", onclick: () => openBotDialog(b) }, "编辑")),
    h("p", { class: "role-text" }, b.role || "还没有写职责。"),
    h(
      "dl",
      {},
      row("底层 agent", AGENT_LABEL[b.agent]),
      row("模型", b.model),
      row("强度", EFFORT_LABEL[b.effort]),
      row("权限", PERMISSION_LABEL[b.permission]),
      row("每轮预算", `${compact(b.budget_tokens)} tokens`),
      row("可调用", b.can_call === null ? "所有 Bot" : b.can_call.length ? b.can_call.map((id) => botById(id)?.name).filter(Boolean).join("、") : "无"),
      b.agent === "codex" ? row("路由", ROUTE_LABEL[b.route]) : null,
      h("div", { class: "kv stacked" }, h("dt", {}, "工作目录"), h("dd", { class: "path", title: b.cwd }, b.cwd)),
    ),
    ...worktreeSection(),
    ...memorySection([["个人记忆", "bot", b.id, `${b.name} 的记忆`], ["项目记忆", "project", b.project_memory, `${b.name} 所在目录的项目记忆`]]),
    ...moduleSection(b),
    ...traceSection(),
    h("h2", { class: "section" }, "累计用量"),
    h("dl", {}, row("轮数", String(u.turns ?? 0)), row("输入", compact(u.input_tokens)), row("其中缓存", compact(u.cached_tokens)), row("输出", compact(u.output_tokens)), typeof u.cost_usd === "number" ? row("估算费用", `$${u.cost_usd.toFixed(3)}`) : null),
    h("p", { class: "muted small" }, "估算费用由 agent 上报。使用订阅时不一定等于实际扣费。"),
  );
}

// ---------- Bot dialog ----------
function openBotDialog(bot, proposal) {
  const src = proposal?.data.spec ?? bot;
  const dlg = $("bot-dialog");
  const agents = Object.keys(AGENT_LABEL);
  const agentSel = h("select", { id: "f-agent", name: "agent" }, agents.map((a) => h("option", { value: a }, AGENT_LABEL[a])));
  const modelSel = h("select", { id: "f-model", name: "model", required: true });
  const routeWrap = h("label", { class: "field", for: "f-route" }, "路由", h("select", { id: "f-route", name: "route" }, Object.entries(ROUTE_LABEL).map(([k, v]) => h("option", { value: k }, v))));
  const error = h("p", { class: "send-error", role: "alert", hidden: true });
  const fillModels = (selected) => {
    const list = state.agents[agentSel.value]?.models ?? [];
    const options = selected && !list.includes(selected) ? [...list, selected] : list;
    // Starts empty on purpose: which model a Bot runs on, and what it costs, should be a choice.
    modelSel.replaceChildren(h("option", { value: "" }, "请选择模型"), ...options.map((m) => h("option", { value: m }, modelLabel(m))));
    modelSel.value = selected ?? "";
    routeWrap.hidden = agentSel.value !== "codex";
  };
  agentSel.value = src?.agent ?? state.settings?.default_agent ?? "claude";
  agentSel.addEventListener("change", () => fillModels());
  const form = h(
    "form",
    {
      method: "dialog",
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const body = Object.fromEntries([...f.entries()].filter(([k]) => k !== "cc"));
        if (body.agent !== "codex") delete body.route;
        body.budget_tokens = Number(body.budget_tokens);
        const others = state.bots.filter((x) => x.id !== bot?.id);
        const picked = f.getAll("cc");
        if (!proposal) body.can_call = picked.length === others.length ? null : picked;
        if (proposal) delete body.route;
        if (bot) body.paused = f.has("paused");
        else delete body.paused;
        error.hidden = true;
        if (proposal) {
          try {
            await api(`/api/approvals/${proposal.id}`, { method: "POST", body: { decision: "allow", spec: body } });
            dlg.close();
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
          }
          return;
        }
        try {
          await api(bot ? `/api/bots/${bot.id}` : "/api/bots", { method: bot ? "PATCH" : "POST", body });
          const fresh = await api("/api/state");
          state.bots = fresh.bots;
          state.groups = fresh.groups;
          dlg.close();
          if (!bot) await selectBot(fresh.bots[fresh.bots.length - 1].id);
          else render();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      },
    },
    h("h2", {}, proposal ? "修改后批准" : bot ? `编辑 ${bot.name}` : "新建 Bot"),
    h("label", { class: "field", for: "f-name" }, "名称", h("input", { id: "f-name", name: "name", required: true, maxlength: 40, value: src?.name ?? "", placeholder: "Engineer", autocomplete: "off" })),
    h("label", { class: "field", for: "f-role" }, bot?.is_chief ? "角色和调度规则" : "职责", h("textarea", { id: "f-role", name: "role", rows: bot?.is_chief ? 9 : 4, maxlength: 8000, placeholder: "用自己的话写：这个 Bot 负责什么、怎么做事。写几句就行，可以让 AI 完善" })),
    h(
      "div",
      { class: "role-tools" },
      h("button", { id: "f-refine", type: "button", onclick: () => refineRoleText(bot, proposal) }, "AI 完善"),
      h("button", { id: "f-undo", type: "button", hidden: true, onclick: () => undoRefine() }, "还原"),
      bot?.is_chief ? h("button", { type: "button", onclick: () => ($("f-role").value = state.chiefDefaultRole) }, "恢复默认") : null,
      h("span", { id: "f-refine-note", class: "muted small", role: "status" }),
    ),
    h("div", { class: "field-row" }, h("label", { class: "field", for: "f-agent" }, "底层 agent", agentSel), h("label", { class: "field", for: "f-model" }, "模型", modelSel)),
    h(
      "div",
      { class: "field-row" },
      h("label", { class: "field", for: "f-effort" }, "强度", h("select", { id: "f-effort", name: "effort" }, Object.entries(EFFORT_LABEL).map(([k, v]) => h("option", { value: k }, v)))),
      h("label", { class: "field", for: "f-permission" }, "权限", h("select", { id: "f-permission", name: "permission" }, Object.entries(PERMISSION_LABEL).map(([k, v]) => h("option", { value: k }, v)))),
    ),
    routeWrap,
    h("label", { class: "field", for: "f-budget" }, "每轮预算（tokens，不含缓存）", h("input", { id: "f-budget", name: "budget_tokens", type: "number", min: 1000, step: 1000, required: true, value: String(src?.budget_tokens ?? state.settings?.default_budget_bot ?? 150000) })),
    bot ? h("label", { class: "field check-inline" }, h("input", { type: "checkbox", name: "paused", checked: bot.paused ? true : null }), "暂停（其他 Bot 不能调用它）") : null,
    !proposal && state.bots.some((x) => x.id !== bot?.id)
      ? h(
          "fieldset",
          { class: "field check-list" },
          h("legend", {}, "可以调用的 Bot"),
          state.bots.filter((x) => x.id !== bot?.id).map((x) => h("label", {}, h("input", { type: "checkbox", name: "cc", value: x.id, checked: !bot || bot.can_call === null || bot.can_call.includes(x.id) ? true : null }), x.name)),
        )
      : null,
    proposal ? null : h("label", { class: "field", for: "f-cwd" }, "工作目录", h("input", { id: "f-cwd", name: "cwd", value: bot?.cwd ?? "", placeholder: "留空则使用这个 Bot 的独立目录", autocomplete: "off" })),
    h("p", { class: "muted small" }, "选“自动改文件”时，Codex 还可以写系统临时目录。写到其他位置会被拦下或询问。"),
    bot ? h("p", { class: "muted small" }, "工作目录和底层 agent 的改动只对新对话生效。") : null,
    error,
    h(
      "div",
      { class: "dialog-actions" },
      bot && !bot.is_chief ? h("button", { class: "danger ghost", type: "button", onclick: () => archiveBot(bot, dlg, error) }, "归档 Bot") : null,
      h("span", { class: "spacer" }),
      h("button", { type: "button", onclick: () => dlg.close() }, "取消"),
      h("button", { class: "primary", type: "submit" }, proposal ? "批准" : bot ? "保存" : "创建"),
    ),
  );
  dlg.replaceChildren(form);
  $("f-role").value = src?.role ?? "";
  $("f-effort").value = src?.effort ?? state.settings?.default_effort ?? "medium";
  $("f-permission").value = src?.permission ?? state.settings?.default_permission ?? "ask";
  $("f-route").value = bot?.route ?? "official";
  fillModels(src?.model);
  dlg.showModal();
  $("f-name").focus();
}

function openGroupDialog(group) {
  const dlg = $("bot-dialog");
  const error = h("p", { class: "send-error", role: "alert", hidden: true });
  const form = h(
    "form",
    {
      method: "dialog",
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const body = { name: f.get("name"), budget_tokens: Number(f.get("budget_tokens")), members: f.getAll("members") };
        if (f.get("cwd")) body.cwd = f.get("cwd");
        error.hidden = true;
        try {
          const saved = await api(group ? `/api/groups/${group.id}` : "/api/groups", { method: group ? "PATCH" : "POST", body });
          const i = state.groups.findIndex((g) => g.id === saved.id);
          if (i >= 0) state.groups[i] = saved;
          else state.groups.push(saved);
          dlg.close();
          if (!group) await selectGroup(saved.id);
          else render();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      },
    },
    h("h2", {}, group ? `编辑 ${group.name}` : "新建群聊"),
    h("label", { class: "field", for: "g-name" }, "名称", h("input", { id: "g-name", name: "name", required: true, maxlength: 40, value: group?.name ?? "", placeholder: "方案评审", autocomplete: "off" })),
    h(
      "fieldset",
      { class: "field check-list" },
      h("legend", {}, "成员（至少两个）"),
      state.bots.map((b) => h("label", {}, h("input", { type: "checkbox", name: "members", value: b.id, checked: group?.members.includes(b.id) ? true : null }), `${b.name}（${AGENT_LABEL[b.agent]}）`)),
    ),
    h("label", { class: "field", for: "g-budget" }, "每轮预算（tokens，不含缓存）", h("input", { id: "g-budget", name: "budget_tokens", type: "number", min: 1000, step: 1000, required: true, value: String(group?.budget_tokens ?? state.settings?.default_budget_group ?? 300000) })),
    h("label", { class: "field", for: "g-cwd" }, "共用工作目录", h("input", { id: "g-cwd", name: "cwd", value: group?.cwd ?? "", placeholder: "留空则使用这个群聊的独立目录", autocomplete: "off" })),
    group ? h("p", { class: "muted small" }, "工作目录的改动只对新对话生效。") : null,
    error,
    h(
      "div",
      { class: "dialog-actions" },
      group ? h("button", { class: "danger ghost", type: "button", onclick: () => archiveGroup(group, dlg, error) }, "归档群聊") : null,
      h("span", { class: "spacer" }),
      h("button", { type: "button", onclick: () => dlg.close() }, "取消"),
      h("button", { class: "primary", type: "submit" }, group ? "保存" : "创建"),
    ),
  );
  dlg.replaceChildren(form);
  dlg.showModal();
  $("g-name").focus();
}

async function archiveGroup(group, dlg, error) {
  if (!confirm(`归档群聊“${group.name}”？它和它的对话会从列表中隐藏。`)) return;
  try {
    await api(`/api/groups/${group.id}`, { method: "DELETE" });
    dlg.close();
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  }
}

let refineUndo = null;

async function refineRoleText(bot, proposal) {
  const btn = $("f-refine");
  const note = $("f-refine-note");
  const box = $("f-role");
  btn.disabled = true;
  note.textContent = "完善中，会消耗少量 token…";
  try {
    const { role } = await api("/api/role/refine", { method: "POST", body: { name: $("f-name").value, draft: box.value, chief: Boolean(bot?.is_chief) } });
    // The dialog may have closed while waiting.
    if ($("f-role") !== box) return;
    refineUndo = box.value;
    box.value = role;
    $("f-undo").hidden = false;
    note.textContent = proposal ? "已填入，批准后生效。" : "已填入，保存后才生效。";
  } catch (e) {
    note.textContent = e.message;
  }
  btn.disabled = false;
}

function undoRefine() {
  $("f-role").value = refineUndo ?? "";
  $("f-undo").hidden = true;
  $("f-refine-note").textContent = "";
}

async function archiveBot(bot, dlg, error) {
  if (!confirm(`归档 Bot “${bot.name}”？它和它的对话会从列表中隐藏。`)) return;
  try {
    await api(`/api/bots/${bot.id}`, { method: "DELETE" });
    dlg.close();
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  }
}

document.addEventListener("click", (e) => {
  if (state.sidebarOpen && !e.target.closest?.(".sidebar, .menu-btn")) toggleSidebar();
});

// Copy buttons sit inside rendered Markdown, which is rebuilt while a reply streams.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest?.(".copy-code");
  if (!btn) return;
  const code = btn.parentElement.querySelector("code")?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(code);
    btn.textContent = "已复制";
  } catch {
    btn.textContent = "复制失败";
  }
  setTimeout(() => (btn.textContent = "复制"), 1500);
});

try {
  applyAppearance(JSON.parse(localStorage.getItem("bot-appearance") ?? "{}"));
} catch {}
connectEvents();
refreshAll();
loadQuota();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.settings && applyAppearance(state.settings));
