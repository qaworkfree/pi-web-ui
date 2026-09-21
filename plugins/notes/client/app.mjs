/**
 * notes 的界面本体（视图与浮窗**同一份代码**，靠 `compact` 换布局）。
 *
 * 渲染策略（刻意保守）：
 *   - 骨架（头部/输入行/列表容器/编辑器容器/脚注）**只建一次**，动态部分各自局部更新 ——
 *     否则每次服务端推快照都会重建搜索框/输入框，用户打字会被打断。
 *   - 列表每次重建（条目少、结构简单）；编辑器只在「换条目」或「没在编辑时外部改了数据」
 *     时重建 —— 光标在编辑器里时不重建，用户正在打的字不会被快照洗掉。
 *   - 输入即存（debounce 400ms）：没有保存按钮，也不做「未保存」状态机。服务端返回的快照
 *     是唯一事实源；本地输入只是把它推过去。
 */
import * as S from "./store.mjs";
import {
	fromLocalInput,
	isSupportedEvery,
	occurrencesBetween,
	MAX_EVERY_MINUTES,
	MIN_EVERY_MINUTES,
	toLocalInput,
} from "./cron.mjs";
import { el } from "./dom.mjs";
import { createSettings } from "./settings-form.mjs";

const pad2 = (n) => String(n).padStart(2, "0");

/** 当天 0 点 / 当月 1 号 0 点 / 加 N 天 / 加 N 月（都按本地时区）。 */
function startOfDay(ms) {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function startOfMonth(ms) {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
function addDays(ms, n) {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}
function addMonths(ms, n) {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
}
/** 本地日期键 YYYY-MM-DD（按天归桶用）。 */
function dayKey(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** 只要时刻 HH:MM。 */
function fmtHM(ms) {
	const d = new Date(ms);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 两个时间戳是否同一本地日历日。 */
function sameDay(a, b) {
	const x = new Date(a);
	const y = new Date(b);
	return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** 毫秒 → 人话（今天/明天/周X/日期 + 时刻）。 */
export function formatWhen(ms, t, nowMs = Date.now()) {
	if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return "";
	const d = new Date(Number(ms));
	const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	const day = Number(new Date(nowMs).setHours(0, 0, 0, 0));
	const target = Number(new Date(d).setHours(0, 0, 0, 0));
	const diffDays = Math.round((target - day) / 86400000);
	if (diffDays === 0) return `${t("agenda.today")} ${hm}`;
	if (diffDays === 1) return `${t("agenda.tomorrow")} ${hm}`;
	if (diffDays > 1 && diffDays < 7) return `${t(`week.${d.getDay()}`)} ${hm}`;
	if (d.getFullYear() === new Date(nowMs).getFullYear()) {
		return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
	}
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

/** 提醒 schedule → 人话（编辑器与列表共用）。 */
export function scheduleLabel(schedule, t) {
	const s = S.normalizeSchedule(schedule);
	if (!s) return "—";
	switch (s.type) {
		case "once":
			return `${t("type.once")} · ${formatWhen(fromLocalInput(s.at), t)}`;
		case "daily":
			return `${t("type.daily")} · ${s.time}`;
		case "weekly":
			return `${t("type.weekly")} · ${s.dow.map((d) => t(`week.${d}`)).join(" ")} ${s.time}`;
		case "monthly":
			return `${t("type.monthly")} · ${s.dom} ${s.time}`;
		case "every":
			return `${t("type.every")} · ${s.minutes}`;
		case "cron":
			return `${t("type.cron")} · ${s.spec}`;
		default:
			return "—";
	}
}

const KIND_OF_TAB = { todo: "todo", note: "note", reminder: "reminder" };

/**
 * 建一个笔记界面。
 *   root      挂载容器（调用方给一个空 div）
 *   data      data.mjs 的共享客户端
 *   t         文案函数（i18n.mjs）
 *   compact   true = 浮窗里的紧凑布局（当前唯一在用的形态：插件没有独立视图）
 */
export function createNotesApp(options) {
	const { root, data, t, compact = false } = options;
	const state = {
		tab: readTab(),
		query: "",
		editingId: null,
		includeDone: false,
		tag: "",
		/** 日历：显示中的月份锚点（该月 1 号 0 点）与选中的那一天。 */
		month: startOfMonth(Date.now()),
		day: startOfDay(Date.now()),
	};

	let snapshot = data.getState();
	let editorKey = "";
	let saveTimer = 0;
	let pendingPatch = null;
	let pendingKind = "";

	root.classList.add("nt-root");
	root.textContent = "";

	// ---------------------------------------------------------------- 骨架
	const tabButtons = {};
	const tabBar = el("div", { class: "nt-tabs" });
	for (const tab of compact ? ["todo", "note", "reminder", "calendar"] : ["todo", "note", "reminder", "agenda", "calendar"]) {
		const btn = el("button", {
			type: "button",
			class: "nt-tab",
			onClick: () => {
				state.tab = tab;
				// 切 tab = 结束编辑：editingId 与 editorKey 一起复位（漏一个就会出现
				// 「列表被 CSS 藏起来 + 编辑器是空的」的全空面板，见 closeEditor）
				state.editingId = null;
				editorKey = "";
				writeTab(tab);
				render();
			},
		});
		tabButtons[tab] = btn;
		tabBar.append(btn);
	}
	const searchInput = el("input", {
		class: "nt-search",
		type: "search",
		placeholder: t("search.placeholder"),
		onInput: (e) => {
			state.query = e.target.value;
			renderList();
		},
	});
	const head = el("div", { class: "nt-head" }, tabBar, el("span", { class: "nt-grow" }), searchInput);
	const quickInput = el("input", {
		type: "text",
		onKeyDown: (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				void submitQuick();
			}
		},
	});
	const quickBtn = el("button", { type: "button", class: "nt-btn", text: t("quick.add"), onClick: () => void submitQuick() });
	const quickRow = el("div", { class: "nt-quick" }, quickInput, quickBtn);

	const listEl = el("div", { class: "nt-list" });
	const editorEl = el("div", { class: "nt-editor" });
	const bodyEl = el("div", { class: "nt-body" }, listEl, editorEl);
	const footEl = el("div", { class: "nt-foot" });
	const app = el("div", { class: `nt-app${compact ? " nt-compact" : ""}` }, head, quickRow, bodyEl, footEl);
	root.append(app);

	// 光标在编辑器里时不重建编辑器（否则打字被打断）。判定**从 DOM 现算**（focus/blur
	// 事件维护的布尔会粘住：正在编辑的条目被别处删掉时，节点被移除不会补发 focusout，
	// 那个 true 会永久挡住后续所有重画 → 编辑器再也画不出来）。
	const editorHasFocus = () => {
		try {
			return editorEl.contains(document.activeElement);
		} catch {
			return false;
		}
	};
	editorEl.addEventListener("focusout", () => {
		// 失焦即结算未落盘的改动（不等 debounce）
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = 0;
			void commit();
		}
	});

	// 非紧凑布局（更宽、带自己的 ⚙ 设置块）：**当前走不到** —— 插件已去掉独立视图
	// （manifest view:false），浮窗是唯一界面。留着是为了以后重新挂一个视图时不用重写。
	// 浮窗自己的设置走 panel.mjs 的覆盖层（同一份 settings-form.mjs）。
	let settingsBox = null;
	if (compact) {
		// 手机上浮窗很窄：搜索框默认收起，一个 🔍 按钮按需展开
		searchInput.style.display = "none";
		const searchBtn = el("button", {
			type: "button",
			class: "nt-btn nt-icon",
			text: "🔍",
			title: t("search.placeholder"),
			onClick: () => {
				const hidden = searchInput.style.display === "none";
				searchInput.style.display = hidden ? "" : "none";
				if (hidden) searchInput.focus();
			},
		});
		head.insertBefore(searchBtn, searchInput);
	} else {
		settingsBox = createSettings({ t, data, onNotify: (text) => notifyInfo(text) });
		const settingsBtn = el("button", {
			type: "button",
			class: "nt-btn nt-icon",
			text: "⚙",
			title: t("action.settings"),
			onClick: () => {
				settingsBox.el.style.display = settingsBox.el.style.display === "none" ? "" : "none";
			},
		});
		head.append(settingsBtn);
		settingsBox.el.style.display = "none";
		// 设置块插在输入行上面（头部之下）
		app.insertBefore(settingsBox.el, quickRow);
	}

	// ---------------------------------------------------------------- 数据订阅
	const unsubscribe = data.subscribe((next) => {
		snapshot = next;
		render();
	});

	// ---------------------------------------------------------------- 渲染
	function store() {
		return snapshot.store;
	}

	function items() {
		const tab = state.tab;
		return S.searchItems(store(), {
			tab: KIND_OF_TAB[tab] ?? tab,
			query: state.query,
			tag: state.tag,
			includeDone: state.includeDone,
		});
	}

	function render() {
		const counts = S.counts(store());
		for (const [tab, btn] of Object.entries(tabButtons)) {
			const n = tab === "todo" ? counts.openTodos : tab === "note" ? counts.notes : tab === "reminder" ? counts.reminders : 0;
			btn.className = `nt-tab${state.tab === tab ? " on" : ""}`;
			btn.textContent = t(`tab.${tab}`);
			if (n) btn.append(el("span", { class: "nt-count", text: String(n) }));
		}
		if (document.activeElement !== searchInput && searchInput.value !== state.query) searchInput.value = state.query;
		// 「浮窗里显示列表还是编辑器」只由 state 派生（历史上这里在两处手写 class，
		// 切换 tab 漏摘一次 → 列表被藏、编辑器空白）
		app.classList.toggle("nt-editing", compact && Boolean(state.editingId));
		searchInput.placeholder = t("search.placeholder");
		renderQuick();
		renderList();
		renderEditor();
		renderFoot(counts);
	}

	function renderQuick() {
		const map = {
			todo: ["quick.todo", "quick.hintTodo"],
			note: ["quick.note", "quick.hintNote"],
			reminder: ["quick.reminder", "quick.hintReminder"],
			agenda: ["quick.todo", "quick.hintTodo"],
			calendar: ["quick.todo", "quick.hintTodo"],
		};
		const [ph, hint] = map[state.tab] ?? map.todo;
		quickInput.placeholder = t(ph);
		quickRow.title = t(hint);
		quickRow.style.display = state.tab === "agenda" || state.tab === "calendar" ? "none" : "";
		quickBtn.textContent = t("quick.add");
	}

	function renderFoot(counts) {
		footEl.textContent = "";
		const status = snapshot.status;
		const dotClass = status === "online" ? "nt-dot" : status === "offline" ? "nt-dot nt-bad" : "nt-dot nt-busy";
		const statusText = status === "online" ? "" : status === "offline" ? t("status.offline") : t("status.syncing");
		footEl.append(el("span", { class: dotClass, title: statusText || "online" }));
		footEl.append(el("span", { text: `${t("tab.todo")} ${counts.openTodos} · ${t("due.today")} ${counts.dueTodos}` }));
		const nextRem = nextReminder();
		// nt-foot-rem：浮窗里这一句长了要省略号（见 styles.mjs 的 .nt-panel .nt-foot-rem）
		if (nextRem) footEl.append(el("span", { class: "nt-foot-rem", text: `⏰ ${formatWhen(nextRem.ms, t)} ${nextRem.text}` }));
		if (status === "offline") footEl.append(el("span", { text: statusText }));
		const clear = el("button", {
			type: "button",
			class: "nt-btn nt-icon",
			text: t("todo.clearDone"),
			onClick: () => {
				const done = store().todos.filter((x) => x.done).length;
				if (!done) return;
				if (confirm(t("confirm.clearDone", { n: done }))) void data.op({ op: "todo.clearDone" });
			},
		});
		clear.style.display = state.tab === "todo" && store().todos.some((x) => x.done) ? "" : "none";
		footEl.append(el("span", { class: "nt-grow" }), clear);
	}

	function nextReminder() {
		let best = null;
		for (const rem of store().reminders) {
			const ms = data.nextAt(rem);
			if (ms && (!best || ms < best.ms)) best = { ms, text: rem.text };
		}
		return best;
	}

	// ---------------------------------------------------------------- 列表
	function renderList() {
		listEl.textContent = "";
		if (state.tab === "agenda") {
			renderAgenda(listEl);
			return;
		}
		if (state.tab === "calendar") {
			renderCalendar(listEl);
			return;
		}
		const list = items();
		if (!list.length) {
			listEl.append(el("div", { class: "nt-empty", text: state.query ? t("empty.search") : t(`empty.${state.tab}`) }));
			return;
		}
		for (const item of list) {
			if (state.tab === "note") listEl.append(noteRow(item));
			else if (state.tab === "todo") listEl.append(todoRow(item));
			else listEl.append(reminderRow(item));
		}
	}

	/** 条目 → 纯文本（复制 / 塞进输入框共用，带上关键元信息免得只剩半句）。 */
	function itemText(kind, item) {
		if (kind === "note") {
			const tagLine = item.tags?.length ? `\n\n${item.tags.map((x) => `#${x}`).join(" ")}` : "";
			return `# ${item.title}\n\n${item.body ?? ""}${tagLine}`.trim();
		}
		if (kind === "todo") {
			const bits = [];
			if (item.due) bits.push(`${t("field.due")} ${String(item.due).replace("T", " ")}`);
			if (item.priority) bits.push(t(`pri.${item.priority}`));
			if (item.repeat && item.repeat !== "none") bits.push(t(`repeat.${item.repeat}`));
			if (item.tags?.length) bits.push(item.tags.map((x) => `#${x}`).join(" "));
			return `${item.done ? "[x]" : "[ ]"} ${item.text}${bits.length ? `（${bits.join(" · ")}）` : ""}`;
		}
		return `${item.text}（${scheduleLabel(item.schedule, t)}）`;
	}

	/** 剪贴板写入（Clipboard API 被拦时退回 textarea + execCommand）。 */
	async function copyItemText(btn, text) {
		let ok = false;
		try {
			await navigator.clipboard.writeText(text);
			ok = true;
		} catch {
			try {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.append(ta);
				ta.select();
				ok = document.execCommand("copy");
				ta.remove();
			} catch {
				ok = false;
			}
		}
		if (!ok) notifyError(t("status.error", { e: text.slice(0, 60) }));
		// 按钮上闪一下 ✓ 当反馈（比每次弹通知条安静）
		if (!btn) return;
		try {
			const old = btn.textContent;
			btn.textContent = ok ? "✓" : "!";
			setTimeout(() => {
				btn.textContent = old;
			}, 900);
		} catch {
			/* 列表已重画：节点不在了，无需反馈 */
		}
	}

	/** 把条目文本塞进主输入框草稿（等用户自己发）；桥没就绪就退化成复制，字不丢。 */
	function quoteItemText(text) {
		let ok = false;
		try {
			ok = globalThis.window?.__piWebUiHost?.compose?.({ text }) ?? false;
		} catch {
			ok = false;
		}
		if (!ok) {
			notifyInfo(t("action.composerBusy"));
			void copyItemText(null, text);
		}
	}

	function rowShell(kind, item, main, extra = []) {
		const node = el(
			"div",
			{
				class: `nt-item${state.editingId === item.id ? " on" : ""}`,
				dataset: { id: item.id, kind },
				onClick: (e) => {
					if (e.target.closest("button,input,a")) return;
					openEditor(kind, item.id);
				},
			},
			main,
			...extra,
			el("button", {
				type: "button",
				class: "nt-x",
				text: "💬",
				title: t("action.quote"),
				onClick: (e) => {
					e.stopPropagation();
					quoteItemText(itemText(kind, item));
				},
			}),
			el("button", {
				type: "button",
				class: "nt-x",
				text: "📋",
				title: t("action.copy"),
				onClick: (e) => {
					e.stopPropagation();
					void copyItemText(e.currentTarget, itemText(kind, item));
				},
			}),
			el("button", {
				type: "button",
				class: "nt-x",
				text: "✕",
				title: t("action.delete"),
				onClick: (e) => {
					e.stopPropagation();
					void removeItem(kind, item);
				},
			}),
		);
		return node;
	}

	function todoRow(todo) {
		const check = el("input", {
			type: "checkbox",
			class: "nt-check",
			checked: !!todo.done,
			onChange: () => void data.op({ op: "todo.toggle", id: todo.id }),
		});
		const meta = el("div", { class: "nt-meta" });
		if (todo.priority) meta.append(el("span", { class: `nt-pri nt-pri-${todo.priority}`, text: t(`pri.${todo.priority}`) }));
		const ds = S.dueState(todo);
		if (todo.due) {
			const ms = fromLocalInput(todo.due);
			meta.append(
				el("span", {
					class: ds === "overdue" ? "nt-due-overdue" : ds === "today" ? "nt-due-today" : "",
					text: `${t(`due.${ds}`)} ${formatWhen(ms, t)}`,
				}),
			);
		}
		if (todo.repeat && todo.repeat !== "none") meta.append(el("span", { text: `🔁 ${t(`repeat.${todo.repeat}`)}` }));
		for (const tag of todo.tags) meta.append(el("span", { class: "nt-tag", text: `#${tag}` }));
		const main = el(
			"div",
			{ class: "nt-main" },
			el("div", { class: "nt-title nt-fixed", text: todo.text }),
			meta.childNodes.length ? meta : null,
		);
		const node = rowShell("todo", todo, main);
		node.insertBefore(check, main);
		node.classList.toggle("nt-done", todo.done);
		return node;
	}

	function noteRow(note) {
		const meta = el("div", { class: "nt-meta" });
		for (const tag of note.tags) meta.append(el("span", { class: "nt-tag", text: `#${tag}` }));
		meta.append(el("span", { text: note.updatedAt.replace("T", " ") }));
		const preview = (note.body || "").split("\n").filter(Boolean)[1] ?? "";
		const main = el(
			"div",
			{ class: "nt-main" },
			el("div", { class: "nt-title", text: `${note.pinned ? "📌 " : ""}${note.title}` }),
			preview ? el("div", { class: "nt-title nt-fixed", style: "color:var(--nt-dim);font-size:12px", text: preview }) : null,
			meta,
		);
		return rowShell("note", note, main);
	}

	function reminderRow(rem) {
		const ms = data.nextAt(rem);
		const meta = el("div", { class: "nt-meta" });
		meta.append(el("span", { text: scheduleLabel(rem.schedule, t) }));
		meta.append(el("span", { text: rem.enabled ? (ms ? `${t("rem.next")} ${formatWhen(ms, t)}` : t("rem.never")) : t("rem.disabled") }));
		if (rem.lastFired) meta.append(el("span", { text: `${t("rem.last")} ${rem.lastFired.replace("T", " ")}` }));
		const main = el(
			"div",
			{ class: "nt-main" },
			el("div", { class: "nt-title", text: `${rem.enabled ? "🔔" : "🔕"} ${rem.text}` }),
			meta,
		);
		const actions = [];
		if (rem.enabled) {
			actions.push(
				el("button", {
					type: "button",
					class: "nt-btn nt-icon",
					text: "⏰",
					title: t("rem.snooze"),
					onClick: (e) => {
						e.stopPropagation();
						void data.op({ op: "reminder.snooze", id: rem.id, minutes: 10 });
					},
				}),
			);
		}
		return rowShell("reminder", rem, main, actions);
	}

	// ---------------------------------------------------------------- 议程
	function renderAgenda(container) {
		const now = Date.now();
		const groups = new Map();
		const add = (key, label, node) => {
			if (!groups.has(key)) groups.set(key, { label, nodes: [] });
			groups.get(key).nodes.push(node);
		};
		const overdue = [];
		const today = [];
		const tomorrow = [];
		const week = [];
		const noDate = [];
		for (const todo of store().todos) {
			if (todo.done) continue;
			if (!todo.due) {
				noDate.push(todo);
				continue;
			}
			const ms = fromLocalInput(todo.due);
			const ds = S.dueState(todo, now);
			if (ds === "overdue") overdue.push(todo);
			else if (sameDay(ms, now)) today.push(todo);
			else if (sameDay(ms, now + 86400000)) tomorrow.push(todo);
			else if (ms - now <= 7 * 86400000) week.push(todo);
		}
		const reminderBuckets = new Map();
		for (const rem of store().reminders) {
			const ms = data.nextAt(rem);
			if (!ms || ms - now > 14 * 86400000) continue;
			const key = new Date(ms).toDateString();
			if (!reminderBuckets.has(key)) reminderBuckets.set(key, { ms, items: [] });
			reminderBuckets.get(key).items.push(rem);
		}
		if (overdue.length) for (const x of overdue) add("overdue", t("agenda.overdue"), todoRow(x));
		if (today.length) for (const x of today) add("today", t("agenda.today"), todoRow(x));
		for (const [key, bucket] of [...reminderBuckets.entries()].sort((a, b) => a[1].ms - b[1].ms)) {
			const isToday = sameDay(bucket.ms, now);
			for (const rem of bucket.items) {
				add(`rem-${key}`, isToday ? t("agenda.reminders") : formatWhen(bucket.ms, t), reminderRow(rem));
			}
		}
		if (tomorrow.length) for (const x of tomorrow) add("tomorrow", t("agenda.tomorrow"), todoRow(x));
		if (week.length) for (const x of week) add("week", t("agenda.week"), todoRow(x));
		if (noDate.length) for (const x of noDate) add("none", t("agenda.noDate"), todoRow(x));
		if (!groups.size) {
			container.append(el("div", { class: "nt-empty", text: t("empty.agenda") }));
			return;
		}
		for (const [key, group] of groups) {
			const cls = key === "overdue" ? " nt-overdue" : key === "today" ? " nt-today" : "";
			container.append(el("div", { class: `nt-group${cls}`, text: group.label }));
			for (const node of group.nodes) container.append(node);
		}
	}

	// ---------------------------------------------------------------- 日历（月视图）
	/** 当月每一天 → { todos, reminders }：待办按截止日期，提醒按**当月所有触发实例**。 */
	function monthBuckets(lib, anchorMs) {
		const from = startOfMonth(anchorMs);
		const to = addMonths(from, 1);
		const map = new Map();
		const bucket = (ms) => {
			const key = dayKey(ms);
			if (!map.has(key)) map.set(key, { todos: [], reminders: [] });
			return map.get(key);
		};
		for (const todo of lib.todos) {
			if (!todo.due) continue;
			const ms = fromLocalInput(todo.due);
			if (ms === null || ms < from || ms >= to) continue;
			bucket(ms).todos.push(todo);
		}
		for (const rem of lib.reminders) {
			if (!rem.enabled) continue;
			// 一个月内的所有实例（「每天 9:00 吃药」要在整月每一天都画出来）
			for (const at of occurrencesBetween(rem.schedule, from, to, 40)) {
				bucket(at).reminders.push({ rem, at });
			}
		}
		for (const entry of map.values()) {
			entry.todos.sort((a, b) => String(a.due).localeCompare(String(b.due)));
			entry.reminders.sort((a, b) => a.at - b.at);
		}
		return map;
	}

	function renderCalendar(container) {
		const lib = store(); // 注意别叫 store：会遮蔽上面的 store() 取值函数（TDZ 直接抛错）
		const monthStart = state.month;
		const buckets = monthBuckets(lib, monthStart);
		const todayKey = dayKey(Date.now());
		const selectedKey = dayKey(state.day);

		// 头部：‹ 2026年9月 › + 今天
		const head = el(
			"div",
			{ class: "nt-cal-head" },
			el("button", {
				type: "button",
				class: "nt-btn nt-icon",
				text: "‹",
				title: t("cal.prev"),
				onClick: () => {
					state.month = addMonths(state.month, -1);
					renderList();
				},
			}),
			el("span", { class: "nt-cal-title", text: t("cal.month", { y: new Date(monthStart).getFullYear(), m: new Date(monthStart).getMonth() + 1 }) }),
			el("button", {
				type: "button",
				class: "nt-btn nt-icon",
				text: "›",
				title: t("cal.next"),
				onClick: () => {
					state.month = addMonths(state.month, 1);
					renderList();
				},
			}),
			el("span", { class: "nt-grow" }),
			el("button", {
				type: "button",
				class: "nt-btn",
				text: t("cal.today"),
				onClick: () => {
					state.month = startOfMonth(Date.now());
					state.day = startOfDay(Date.now());
					renderList();
				},
			}),
		);
		container.append(head);

		// 星期表头（周一开头，跟着中国习惯走）
		const grid = el("div", { class: "nt-cal-grid" });
		for (let i = 0; i < 7; i++) {
			grid.append(el("div", { class: "nt-cal-wd", text: t(`week.${(i + 1) % 7}`) }));
		}
		// 从「当月 1 号所在周的周一」开始，画满 6 周（42 格，跨月补位）
		const firstCell = addDays(startOfMonth(monthStart), -((new Date(monthStart).getDay() + 6) % 7));
		for (let i = 0; i < 42; i++) {
			const dayMs = addDays(firstCell, i);
			const key = dayKey(dayMs);
			const entry = buckets.get(key);
			const count = (entry?.todos.length ?? 0) + (entry?.reminders.length ?? 0);
			const cell = el("div", {
				class:
					"nt-cal-cell" +
					(new Date(dayMs).getMonth() !== new Date(monthStart).getMonth() ? " nt-out" : "") +
					(key === todayKey ? " nt-today" : "") +
					(key === selectedKey ? " nt-sel" : ""),
				dataset: { day: key },
				onClick: () => {
					state.day = dayMs;
					renderList();
				},
			});
			cell.append(el("div", { class: "nt-cal-day", text: String(new Date(dayMs).getDate()) }));
			const chips = el("div", { class: "nt-cal-chips" });
			let shown = 0;
			for (const todo of entry?.todos ?? []) {
				if (shown >= 3) break;
				chips.append(el("div", { class: `nt-cal-chip${todo.done ? " nt-done" : ""}`, text: `• ${todo.text}` }));
				shown++;
			}
			for (const { rem, at } of entry?.reminders ?? []) {
				if (shown >= 3) break;
				chips.append(el("div", { class: "nt-cal-chip nt-rem", text: `⏰ ${fmtHM(at)} ${rem.text}` }));
				shown++;
			}
			if (count > shown) chips.append(el("div", { class: "nt-cal-chip nt-more", text: t("cal.more", { n: count - shown }) }));
			cell.append(chips);
			grid.append(cell);
		}
		container.append(grid);

		// 选中那天的清单（点条目照常进编辑器）
		const entry = buckets.get(selectedKey);
		const detail = el("div", { class: "nt-cal-detail" });
		const selected = new Date(state.day);
		detail.append(
			el("div", {
				class: "nt-group",
				text: `${selected.getFullYear()}-${String(selected.getMonth() + 1).padStart(2, "0")}-${String(selected.getDate()).padStart(2, "0")}（${t(`week.${selected.getDay()}`)}）`,
			}),
		);
		if (!entry || (!entry.todos.length && !entry.reminders.length)) {
			detail.append(el("div", { class: "nt-empty", text: t("cal.empty") }));
		} else {
			for (const todo of entry.todos) detail.append(todoRow(todo));
			for (const { rem, at } of entry.reminders) {
				const node = reminderRow(rem);
				node.prepend(el("span", { class: "nt-meta", text: fmtHM(at) }));
				detail.append(node);
			}
		}
		container.append(detail);
	}

	// ---------------------------------------------------------------- 编辑器
	function findItem(kind, id) {
		if (kind === "note") return S.findNote(store(), id);
		if (kind === "todo") return S.findTodo(store(), id);
		return S.findReminder(store(), id);
	}

	function openEditor(kind, id) {
		state.editingId = id;
		editorKey = ""; // 强制重画（即使焦点还在编辑器里）
		render();
		editorEl.scrollTop = 0;
	}

	function closeEditor() {
		state.editingId = null;
		editorKey = "";
		render();
	}

	function renderEditor() {
		const kind = KIND_OF_TAB[state.tab] ?? lastKindOfEditing();
		if (!state.editingId) {
			if (editorHasFocus() && editorKey) return;
			editorEl.textContent = "";
			editorKey = "";
			return;
		}
		const item = findItem(kind, state.editingId);
		if (!item) {
			state.editingId = null;
			editorEl.textContent = "";
			editorKey = "";
			return;
		}
		// 渲染键带 updatedAt：外部改了同一条（AI 工具/另一个标签页）也要能刷新；
		// 但光标在编辑器里/有未落盘输入时一律不重建（打字的字不能被快照洗掉）。
		const key = `${kind}:${item.id}#${item.updatedAt}#${state.tab}`;
		if (key === editorKey) return;
		if (editorHasFocus() || pendingPatch) return;
		editorKey = key;
		editorEl.textContent = "";
		if (kind === "note") editorEl.append(noteForm(item));
		else if (kind === "todo") editorEl.append(todoForm(item));
		else editorEl.append(reminderForm(item));
	}

	function lastKindOfEditing() {
		const inTodos = store().todos.some((x) => x.id === state.editingId);
		if (inTodos) return "todo";
		const inNotes = store().notes.some((x) => x.id === state.editingId);
		if (inNotes) return "note";
		return "reminder";
	}

	/** 统一的「输入即存」：把 patch 合并进待发送队列，400ms 后落盘。 */
	function queueSave(kind, id, patch) {
		pendingKind = kind;
		pendingPatch = { id, ...(pendingPatch ?? {}), ...patch };
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveTimer = 0;
			void commit();
		}, 400);
	}

	async function commit() {
		const patch = pendingPatch;
		const kind = pendingKind || KIND_OF_TAB[state.tab] || lastKindOfEditing();
		pendingPatch = null;
		pendingKind = "";
		if (!patch) return;
		const opName = kind === "note" ? "note.save" : kind === "todo" ? "todo.save" : "reminder.save";
		const res = await data.op({ op: opName, item: patch });
		if (res && res.ok === false && res.error) notifyError(res.error);
	}

	function field(label, control, hint) {
		return el(
			"div",
			{ class: "nt-field" },
			el("label", { text: label }),
			control,
			hint ? el("div", { class: "nt-hint", text: hint }) : null,
		);
	}

	function deleteButton(kind, item) {
		return el("button", {
			type: "button",
			class: "nt-btn nt-danger",
			text: t("action.delete"),
			onClick: () => void removeItem(kind, item),
		});
	}

	function noteForm(note) {
		const title = el("input", {
			class: "nt-input",
			value: note.title,
			onInput: (e) => queueSave("note", note.id, { id: note.id, title: e.target.value }),
		});
		const tags = el("input", {
			class: "nt-input",
			value: note.tags.join(" "),
			placeholder: t("field.tagsHint"),
			onInput: (e) => queueSave("note", note.id, { id: note.id, tags: e.target.value }),
		});
		const body = el("textarea", {
			class: "nt-textarea",
			value: note.body,
			onInput: (e) => queueSave("note", note.id, { id: note.id, body: e.target.value }),
		});
		const pinned = el("input", {
			type: "checkbox",
			checked: !!note.pinned,
			onChange: (e) => queueSave("note", note.id, { id: note.id, pinned: e.target.checked }),
		});
		return el(
			"div",
			{ class: "nt-form" },
			field(t("field.title"), title),
			field(t("field.tags"), tags),
			field(t("field.body"), body, t("field.bodyHint")),
			el("label", { class: "nt-checkline" }, pinned, el("span", { text: t("field.pinned") })),
			el(
				"div",
				{ class: "nt-actions" },
				el("button", { type: "button", class: "nt-btn", text: t("action.cancel"), onClick: closeEditor }),
				deleteButton("note", note),
				el("span", { class: "nt-grow" }),
				el("span", { class: "nt-hint", text: note.updatedAt.replace("T", " ") }),
			),
		);
	}

	function todoForm(todo) {
		const text = el("input", {
			class: "nt-input",
			value: todo.text,
			onInput: (e) => queueSave("todo", todo.id, { id: todo.id, text: e.target.value }),
		});
		const pri = el(
			"select",
			{
				class: "nt-select",
				onChange: (e) => queueSave("todo", todo.id, { id: todo.id, priority: Number(e.target.value) }),
			},
			...[0, 1, 2, 3].map((p) => el("option", { value: String(p), selected: todo.priority === p, text: t(`pri.${p}`) })),
		);
		const due = el("input", {
			class: "nt-input",
			type: "datetime-local",
			value: todo.due ?? "",
			onChange: (e) => queueSave("todo", todo.id, { id: todo.id, due: e.target.value }),
		});
		const dueClear = el("button", {
			type: "button",
			class: "nt-btn",
			text: "✕",
			onClick: () => {
				due.value = "";
				queueSave("todo", todo.id, { id: todo.id, due: "" });
			},
		});
		const repeat = el(
			"select",
			{
				class: "nt-select",
				onChange: (e) => queueSave("todo", todo.id, { id: todo.id, repeat: e.target.value }),
			},
			...["none", "daily", "weekly", "monthly"].map((r) =>
				el("option", { value: r, selected: todo.repeat === r, text: t(`repeat.${r}`) }),
			),
		);
		const tags = el("input", {
			class: "nt-input",
			value: todo.tags.join(" "),
			placeholder: t("field.tagsHint"),
			onInput: (e) => queueSave("todo", todo.id, { id: todo.id, tags: e.target.value }),
		});
		const done = el("button", {
			type: "button",
			class: `nt-btn${todo.done ? " on" : ""}`,
			text: todo.done ? t("todo.open") : t("todo.done"),
			onClick: () => void data.op({ op: "todo.toggle", id: todo.id }),
		});
		return el(
			"div",
			{ class: "nt-form" },
			field(t("field.text"), text),
			el("div", { class: "nt-grid2" }, field(t("field.priority"), pri), field(t("field.repeat"), repeat)),
			field(t("field.due"), el("div", { class: "nt-inline-row" }, due, dueClear)),
			field(t("field.tags"), tags),
			el("div", { class: "nt-actions" }, done, el("span", { class: "nt-grow" }), deleteButton("todo", todo)),
		);
	}

	function reminderForm(rem) {
		const text = el("input", {
			class: "nt-input",
			value: rem.text,
			onInput: (e) => queueSave("reminder", rem.id, { id: rem.id, text: e.target.value }),
		});
		const sched = rem.schedule;
		const typeSel = el(
			"select",
			{
				class: "nt-select",
				onChange: (e) => {
					const type = e.target.value;
					const next = defaultSchedule(type, sched);
					void data.op({ op: "reminder.save", item: { id: rem.id, schedule: next } });
					editorKey = ""; // 换类型 → 重画表单（字段集不同）
				},
			},
			...["once", "daily", "weekly", "monthly", "every", "cron"].map((x) =>
				el("option", { value: x, selected: sched.type === x, text: t(`type.${x}`) }),
			),
		);
		const rows = [field(t("field.text"), text), field(t("field.schedule"), typeSel)];
		if (sched.type === "once") {
			rows.push(
				field(
					t("field.at"),
					el("input", {
						class: "nt-input",
						type: "datetime-local",
						value: sched.at,
						onChange: (e) => queueSave("reminder", rem.id, { id: rem.id, schedule: { type: "once", at: e.target.value } }),
					}),
				),
			);
		} else if (sched.type === "daily" || sched.type === "weekly" || sched.type === "monthly") {
			rows.push(
				field(
					t("field.time"),
					el("input", {
						class: "nt-input",
						type: "time",
						value: sched.time,
						onChange: (e) =>
							queueSave("reminder", rem.id, { id: rem.id, schedule: { ...sched, time: e.target.value } }),
					}),
				),
			);
		}
		if (sched.type === "weekly") {
			const dowRow = el("div", { class: "nt-dows" });
			for (let d = 0; d < 7; d++) {
				const on = sched.dow.includes(d);
				dowRow.append(
					el("button", {
						type: "button",
						class: `nt-btn${on ? " on" : ""}`,
						text: t(`week.${d}`),
						onClick: () => {
							const next = on ? sched.dow.filter((x) => x !== d) : [...sched.dow, d].sort((a, b) => a - b);
							if (!next.length) return;
							void data.op({ op: "reminder.save", item: { id: rem.id, schedule: { ...sched, dow: next } } });
						},
					}),
				);
			}
			rows.push(field(t("field.dow"), dowRow));
		}
		if (sched.type === "monthly") {
			rows.push(
				field(
					t("field.dom"),
					el("input", {
						class: "nt-input",
						type: "number",
						min: 1,
						max: 31,
						value: sched.dom,
						onChange: (e) =>
							queueSave("reminder", rem.id, { id: rem.id, schedule: { ...sched, dom: Number(e.target.value) } }),
					}),
				),
			);
		}
		if (sched.type === "every") {
			// 真间隔：任意 1..10080 分钟（到点判定走 nextDue，不受 cron 表达能力限制）
			const everyInput = el("input", {
				class: "nt-input",
				type: "number",
				min: MIN_EVERY_MINUTES,
				max: MAX_EVERY_MINUTES,
				value: sched.minutes,
				onChange: (e) => {
					const minutes = Math.round(Number(e.target.value));
					if (!isSupportedEvery(minutes)) {
						e.target.value = String(sched.minutes); // 越界就退回原值（不写库）
						return;
					}
					queueSave("reminder", rem.id, { id: rem.id, schedule: { type: "every", minutes } });
				},
			});
			rows.push(field(t("field.minutes"), everyInput, t("field.minutesHint")));
		}
		if (sched.type === "cron") {
			rows.push(
				field(
					t("field.cron"),
					el("input", {
						class: "nt-input",
						value: sched.spec,
						placeholder: "0 9 * * 1-5",
						onChange: (e) => queueSave("reminder", rem.id, { id: rem.id, schedule: { type: "cron", spec: e.target.value } }),
					}),
				),
			);
		}
		const ms = data.nextAt(rem);
		rows.push(
			el("label", { class: "nt-checkline" },
				el("input", {
					type: "checkbox",
					checked: rem.enabled,
					onChange: (e) => void data.op({ op: "reminder.save", item: { id: rem.id, enabled: e.target.checked } }),
				}),
				el("span", { text: t("field.enabled") }),
			),
			el("div", { class: "nt-hint", text: rem.enabled ? (ms ? `${t("rem.next")} ${formatWhen(ms, t)}` : t("rem.never")) : t("rem.disabled") }),
			el(
				"div",
				{ class: "nt-actions" },
				el("button", {
					type: "button",
					class: "nt-btn",
					text: t("rem.snooze"),
					onClick: () => void data.op({ op: "reminder.snooze", id: rem.id, minutes: 10 }),
				}),
				el("span", { class: "nt-grow" }),
				deleteButton("reminder", rem),
			),
		);
		return el("div", { class: "nt-form" }, ...rows);
	}

	function defaultSchedule(type, prev) {
		const now = Date.now();
		const base = { ...prev };
		if (type === "once") return { type: "once", at: toLocalInput(now + 3600_000) };
		if (type === "daily") return { type: "daily", time: base.time ?? "09:00" };
		if (type === "weekly") return { type: "weekly", time: base.time ?? "09:00", dow: base.dow?.length ? base.dow : [1] };
		if (type === "monthly") return { type: "monthly", time: base.time ?? "09:00", dom: 1 };
		if (type === "every") return { type: "every", minutes: 30 };
		return { type: "cron", spec: "0 9 * * *" };
	}

	// ---------------------------------------------------------------- 动作
	async function submitQuick() {
		const raw = quickInput.value.trim();
		if (!raw) return;
		if (state.tab === "note") {
			const res = await data.op({ op: "note.save", item: { title: raw } });
			if (res?.item) {
				quickInput.value = "";
				openEditor("note", res.item.id);
			}
			return;
		}
		if (state.tab === "reminder") {
			const parsed = S.parseQuickReminder(raw);
			if (!parsed) {
				notifyError(t("quick.hintReminder"));
				return;
			}
			const res = await data.op({ op: "reminder.save", item: { text: parsed.text, schedule: parsed.schedule } });
			if (res?.ok === false) notifyError(res.error ?? "error");
			else quickInput.value = "";
			return;
		}
		const parsed = S.parseQuickTodo(raw);
		if (!parsed.text) {
			notifyError(t("quick.hintTodo"));
			return;
		}
		const res = await data.op({
			op: "todo.save",
			item: { text: parsed.text, due: parsed.due, priority: parsed.priority, tags: parsed.tags },
		});
		if (res?.ok === false) notifyError(res.error ?? "error");
		else quickInput.value = "";
	}

	async function removeItem(kind, item) {
		const name = kind === "note" ? item.title : item.text;
		if (!confirm(t("confirm.delete", { name }))) return;
		const op = kind === "note" ? "note.remove" : kind === "todo" ? "todo.remove" : "reminder.remove";
		await data.op({ op, id: item.id });
		if (state.editingId === item.id) closeEditor();
	}

	function notifyInfo(text) {
		try {
			const bridge = globalThis.window?.__piWebUiHost;
			if (typeof bridge?.notifyAction === "function") void bridge.notifyAction({ text, actions: [] });
		} catch {
			/* 宿主桥未就绪：静默（界面本身会反映结果） */
		}
	}

	function notifyError(text) {
		notifyInfo(text);
		console.warn("[notes]", text);
	}

	// 输入框聚焦快捷键（浮窗里 Ctrl/Cmd+K 定位到快速输入）
	function onKeyDown(e) {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && root.contains(e.target)) {
			e.preventDefault();
			quickInput.focus();
		}
		if (e.key === "Escape" && state.editingId) closeEditor();
	}
	app.addEventListener("keydown", onKeyDown);

	render();
	void data.refresh();

	return {
		destroy() {
			unsubscribe();
			// 400ms 合并窗口里还没落盘的编辑要先发出去（切视图/切语言/插件热重载都会走
			// destroy，直接 clearTimeout 会让用户刚打的这段话凭空消失）
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = 0;
				void commit();
			}
			root.textContent = "";
		},
		/** 外部（浮窗被打开/宿主快捷键）请求聚焦快速输入。 */
		focusQuickInput() {
			quickInput.focus();
		},
		render,
	};
}

function readTab() {
	try {
		const v = localStorage.getItem("notes:tab");
		if (v && ["todo", "note", "reminder", "agenda"].includes(v)) return v;
	} catch {
		/* ignore */
	}
	return "todo";
}

function writeTab(tab) {
	try {
		localStorage.setItem("notes:tab", tab);
	} catch {
		/* ignore */
	}
}
