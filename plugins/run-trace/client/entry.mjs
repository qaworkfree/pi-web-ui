/**
 * run-trace 客户端视图 v2 —— 类 harness 轨迹分析。
 *
 * 顶部横向泳道时间轴（输入/模型/工具）看全貌，
 * 左列分段列表定位，右列详情做分析（概述/预览/原始内容/来源），
 * 而不只是把对话内容再看一遍。
 *
 * 约定：ESM 默认导出 { mount(container, ctx) → cleanup? }，纯 DOM 无依赖。
 */

const LANE_FILTER = { input: "input", model: "model", tools: "tools" };

const I18N = {
	zh: {
		title: "运行轨迹",
		live: "实时",
		current: "当前",
		search: "搜索分段…",
		fit: "⤢ 适应",
		zoomHint: "滚轮缩放 · 拖拽平移 · 点击色块看分析",
		replay: "回放",
		exitReplay: "退出回放",
		play: "播放",
		pause: "暂停",
		speed: "速度",
		clear: "清空",
		confirmClear: "确定清空全部轨迹吗？（重拉当前对话恢复）",
		empty: "暂无对话",
		emptyHint: "打开一个对话后，这里直接显示它的时间线与分析。",
		selectHint: "点击时间轴色块或左侧分段查看分析。",
		loading: "加载中…",
		noMatch: "没有匹配的分段（检查搜索/筛选）。",
		copy: "复制",
		copied: "已复制",
		lanes: { input: "输入", model: "模型", tools: "工具" },
		filters: { input: "输入", model: "模型", tools: "工具" },
		tabs: { overview: "概述", preview: "预览", raw: "原始内容", source: "来源" },
		status: { done: "已完成", running: "执行中", error: "失败" },
		f: {
			source: "来源", status: "状态", dur: "时长", turn: "轮次", len: "长度", pos: "位置",
			total: "总时长", turns: "轮数", segs: "分段", toolCalls: "工具调用", toolErr: "工具失败",
			toolTime: "工具耗时", slowest: "最慢工具", files: "文件改动", phase: "阶段分布",
			calls: "累计调用", avg: "平均", errRate: "失败率", share: "耗时占比",
			msgKey: "消息", toolCall: "调用", conv: "对话", time: "时间",
		},
	},
	en: {
		title: "Run Trace",
		live: "live",
		current: "active",
		search: "Search segments…",
		fit: "⤢ Fit",
		zoomHint: "wheel zoom · drag pan · click a block for analysis",
		replay: "Replay",
		exitReplay: "Exit replay",
		play: "Play",
		pause: "Pause",
		speed: "Speed",
		clear: "Clear",
		confirmClear: "Clear all traces? (re-pull restores the open conversation)",
		empty: "No conversation",
		emptyHint: "Open a conversation and its timeline + analysis show up here.",
		selectHint: "Click a ruler block or a left segment for analysis.",
		loading: "Loading…",
		noMatch: "No matching segments (check search/filters).",
		copy: "Copy",
		copied: "Copied",
		lanes: { input: "Input", model: "Model", tools: "Tools" },
		filters: { input: "Input", model: "Model", tools: "Tools" },
		tabs: { overview: "Overview", preview: "Preview", raw: "Raw", source: "Source" },
		status: { done: "Done", running: "Running", error: "Failed" },
		f: {
			source: "Source", status: "Status", dur: "Duration", turn: "Turn", len: "Length", pos: "Position",
			total: "Total", turns: "Turns", segs: "Segments", toolCalls: "Tool calls", toolErr: "Tool errors",
			toolTime: "Tool time", slowest: "Slowest tools", files: "Files changed", phase: "Phases",
			calls: "Calls", avg: "Avg", errRate: "Error rate", share: "Time share",
			msgKey: "Message", toolCall: "Call", conv: "Conversation", time: "Time",
		},
	},
};

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtClock(t) {
	try { return new Date(t).toLocaleTimeString(); } catch { return ""; }
}
function fmtDur(ms) {
	if (ms === undefined || ms === null) return "—";
	const s = Math.max(0, ms) / 1000;
	if (s < 1) return `${Math.round(ms)}ms`;
	if (s < 60) return `${s.toFixed(1)}s`;
	return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}
function chipFor(seg, lang) {
	if (seg.kind === "user") return lang === "zh" ? "用户" : "user";
	if (seg.kind === "thinking") return lang === "zh" ? "思考" : "think";
	if (seg.kind === "text") return lang === "zh" ? "回答" : "text";
	if (seg.kind === "file") return lang === "zh" ? "文件" : "file";
	if (seg.kind === "system") return lang === "zh" ? "系统" : "sys";
	if (seg.kind === "result") return lang === "zh" ? "结果" : "done";
	if (seg.kind === "tool") return (seg.meta?.tool ?? "tool").slice(0, 10);
	return seg.kind;
}

export default {
	mount(container, ctx) {
		let lang = "zh";
		const t = () => I18N[lang];
		let convs = [];
		let activeId = null;
		let selectedConvId = null;
		const segsCache = new Map(); // convId → light segs
		const detailCache = new Map(); // `${convId}\n${key}` → { detail, seg, analysis }
		const pendingSeg = new Set();
		let selectedKey = null;
		let detailTab = "overview";
		let search = "";
		const filters = { input: true, model: true, tools: true };
		const replay = { on: false, idx: 0, playing: false, timer: 0, speed: 1 };
		let raf = 0;
		// vis-timeline 专业时间轴状态（懒加载 vendor，失败回退手写 div）
		let visApi = null;
		let visPromise = null;
		let tl = null;
		let tlItems = null;
		let tlDomEl = null;
		let tlConv = null;
		let userZoomed = false;
		let suppressSelect = false;

		function ensureVis() {
			if (!visPromise) {
				visPromise = (async () => {
					try {
						const mod = await import("./vendor/vis-timeline.bundle.mjs").catch(() =>
							import("https://esm.sh/vis-timeline@8.5.4/standalone/esm/vis-timeline-graph2d.min.mjs"),
						);
						injectVisCss();
						return { Timeline: mod.Timeline, DataSet: mod.DataSet };
					} catch {
						return null;
					}
				})();
				visPromise.then((api) => {
					visApi = api;
					if (api) scheduleRender(false);
				});
			}
		}

		function injectVisCss() {
			try {
				if (document.querySelector('link[data-rtr-vis]')) return;
				const link = document.createElement("link");
				link.rel = "stylesheet";
				link.dataset.rtrVis = "1";
				link.href = new URL("./vendor/vis-timeline.css", import.meta.url).href;
				document.head.appendChild(link);
			} catch {
				/* CDN 回退时无自带样式，靠内置覆盖照常可用 */
			}
		}

		function tlDom() {
			if (!tlDomEl) tlDomEl = document.createElement("div");
			return tlDomEl;
		}

		function destroyTl() {
			hideTip();
			try {
				tl?.destroy();
			} catch {}
			tl = null;
			tlItems = null;
			tlConv = null;
		}

		container.innerHTML = `
<div class="rtr">
	<style>
		.rtr { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; color: var(--text, #e6e8ef); position: relative; }
		.rtr-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border, #262a35); flex-wrap: wrap; }
		.rtr-hd h2 { margin: 0; font-size: 15px; }
		.rtr-live { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: var(--green-soft, rgba(52,211,153,.12)); color: var(--green, #34d399); }
		.rtr-hd input[type="search"] { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 5px 9px; font: inherit; width: 140px; }
		.rtr-hd .sp { flex: 1; }
		.rtr-btn { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit; }
		.rtr-btn:hover { border-color: var(--accent, #8b5cff); }
		.rtr-btn.on { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cff); }
		.rtr-btn.danger:hover { border-color: var(--red, #f87171); color: var(--red, #f87171); }
		.rtr-convs { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--border, #262a35); overflow-x: auto; align-items: center; }
		.rtr-conv { border: 1px solid var(--border, #262a35); background: transparent; color: inherit; font: inherit; border-radius: 99px; padding: 3px 12px; cursor: pointer; white-space: nowrap; font-size: 12px; opacity: .65; }
		.rtr-conv.sel { opacity: 1; border-color: var(--accent, #8b5cff); background: var(--accent-soft, rgba(139,92,246,.14)); }
		.rtr-conv .cur { color: var(--green, #34d399); }
		.rtr-ruler { border-bottom: 1px solid var(--border, #262a35); padding: 6px 12px 8px; background: var(--bg-elev, #14161c); }
		.rtr-rulerbar { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
		.rtr-rulerbar .hint { font-size: 11px; opacity: .5; }
		.rtr-rulerbar .sp { flex: 1; }
		.rtr-rulerbar .rtr-btn { font-size: 11px; padding: 2px 9px; }
		.rtr-tlbody { height: 252px; }
		.rtr-tlbody .vis-timeline { border: 0; background: transparent; }
		.rtr-tlbody .vis-panel.vis-left, .rtr-tlbody .vis-panel.vis-center { border-color: var(--border-soft, #1e2230); }
		.rtr-tlbody .vis-labelset .vis-label { color: var(--text-dim, #9aa1b4); border-color: var(--border-soft, #1e2230); background: transparent; }
		.rtr-tlbody .vis-time-axis .vis-text { color: var(--text-faint, #6b7284); }
		.rtr-tlbody .vis-time-axis .vis-grid.vis-minor, .rtr-tlbody .vis-time-axis .vis-grid.vis-major { border-color: var(--border-soft, #1e2230); }
		.rtr-tlbody .vis-item { border-radius: 4px; cursor: pointer; height: 36px; }
		.rtr-tlbody .vis-item::after { content: ""; position: absolute; left: -5px; right: -5px; top: -6px; bottom: -6px; }
		.rtr-tip { position: absolute; z-index: 50; pointer-events: none; background: var(--bg-elev2, #1a1d26); border: 1px solid var(--accent, #8b5cff); border-radius: 7px; padding: 6px 10px; font-size: 12px; max-width: 320px; box-shadow: 0 4px 16px rgba(0,0,0,.45); }
		.rtr-tip .tt { font-weight: 700; margin-bottom: 2px; }
		.rtr-tip .tm { opacity: .65; font-size: 11px; }
		.rtr-tlbody .vis-item .vis-item-content { display: none; }
		.rtr-tlbody .vis-item.lane-input { background: #64748b; border-color: #64748b; }
		.rtr-tlbody .vis-item.lane-model { background: #3b82f6; border-color: #3b82f6; }
		.rtr-tlbody .vis-item.lane-tools { background: #22c55e; border-color: #16a34a; }
		.rtr-tlbody .vis-item.st-error { background: var(--red, #f87171); border-color: var(--red, #f87171); }
		.rtr-tlbody .vis-item.st-running { animation: rtr-blink 1.2s infinite; }
		.rtr-tlbody .vis-item.vis-selected { outline: 2px solid #fff; outline-offset: -1px; z-index: 2; }
		.rtr-tlbody .vis-item.vis-box { height: 14px; margin-top: 11px; border-radius: 50%; min-width: 14px; }
		.rtr-axis { display: flex; justify-content: space-between; font-size: 11px; opacity: .55; margin-bottom: 4px; }
		.rtr-lane { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
		.rtr-lane .ln { width: 34px; flex: none; font-size: 11px; opacity: .6; text-align: right; }
		.rtr-track { position: relative; flex: 1; height: 16px; background: var(--bg-elev2, #1a1d26); border-radius: 4px; overflow: hidden; }
		.rtr-blk { position: absolute; top: 2px; height: 12px; border-radius: 3px; background: #3b82f6; opacity: .85; cursor: pointer; }
		.rtr-blk.lane-input { background: #64748b; }
		.rtr-blk.lane-model { background: #3b82f6; }
		.rtr-blk.lane-tools { background: #22c55e; }
		.rtr-blk.st-error { background: var(--red, #f87171); }
		.rtr-blk.st-running { animation: rtr-blink 1.2s infinite; }
		.rtr-blk.sel { outline: 2px solid #fff; outline-offset: -1px; z-index: 1; }
		@keyframes rtr-blink { 50% { opacity: .35; } }
		.rtr-bd { display: flex; flex: 1; min-height: 0; }
		.rtr-list { flex: 1; min-width: 0; border-right: 1px solid var(--border, #262a35); overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 5px; }
		.rtr-row { display: flex; gap: 8px; align-items: baseline; border: 1px solid transparent; border-radius: 7px; padding: 6px 9px; cursor: pointer; background: transparent; color: inherit; font: inherit; text-align: left; width: 100%; }
		.rtr-row:hover { border-color: var(--accent, #8b5cff); }
		.rtr-row.sel { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cff); }
		.rtr-chip { flex: none; font-size: 11px; padding: 1px 7px; border-radius: 5px; background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border, #262a35); }
		.rtr-row .tt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.rtr-row time { flex: none; font-size: 11px; opacity: .55; }
		.rtr-row.err .rtr-chip { border-color: var(--red, #f87171); color: var(--red, #f87171); }
		.rtr-detail { width: 320px; min-width: 320px; flex: none; overflow-y: auto; padding: 12px 14px; min-height: 0; }
		.rtr-dtabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border, #262a35); margin-bottom: 10px; }
		.rtr-dtab { background: transparent; border: 0; border-bottom: 2px solid transparent; color: inherit; font: inherit; padding: 6px 12px; cursor: pointer; opacity: .6; }
		.rtr-dtab.on { opacity: 1; border-bottom-color: var(--accent, #8b5cff); }
		.rtr-kv { display: grid; grid-template-columns: 86px 1fr; gap: 5px 10px; font-size: 12px; margin-bottom: 12px; }
		.rtr-kv dt { opacity: .55; }
		.rtr-kv dd { margin: 0; word-break: break-word; }
		.rtr-sec { font-size: 12px; font-weight: 700; margin: 12px 0 6px; opacity: .8; }
		.rtr-bar { height: 8px; border-radius: 4px; background: var(--bg-elev2, #1a1d26); overflow: hidden; margin: 3px 0 7px; }
		.rtr-bar i { display: block; height: 100%; background: #3b82f6; }
		.rtr-detail pre { white-space: pre-wrap; word-break: break-word; background: var(--bg-elev, #14161c); border: 1px solid var(--border, #262a35); border-radius: 8px; padding: 9px 11px; font-size: 12px; margin: 0; }
		.rtr-empty { opacity: .6; text-align: center; padding: 40px 20px; }
		.rtr-spin { display: inline-block; animation: rtr-blink 1s infinite; }
		.rtr-replaybar { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--border, #262a35); background: var(--bg-elev, #14161c); font-size: 12px; }
		.rtr-replaybar input[type="range"] { flex: 1; accent-color: var(--accent, #8b5cff); }
		.rtr-replaybar select { background: var(--bg-elev2, #1a1d26); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; font: inherit; padding: 2px 6px; }
	</style>
	<div class="rtr-hd">
		<h2>🧭 <span class="t-title"></span></h2>
		<span class="rtr-live"></span>
		<span class="sp"></span>
		<input type="search" class="q" />
		<button class="rtr-btn act-replay"></button>
		<button class="rtr-btn act-lang">EN</button>
		<button class="rtr-btn danger act-clear"></button>
	</div>
	<div class="rtr-convs"></div>
	<div class="rtr-ruler"><div class="rtr-rulerbar"><span class="hint"></span><span class="sp"></span><button class="rtr-btn act-fit"></button></div><div class="rtr-tlbody"></div></div>
	<div class="rtr-replaybar" hidden></div>
	<div class="rtr-bd">
		<div class="rtr-list"></div>
		<div class="rtr-detail"></div>
	</div>
</div>`;

		const $ = (s) => container.querySelector(s);
		const hdTitle = $(".t-title"), hdLive = $(".rtr-live"), qEl = $(".q");
		const replayBtn = $(".act-replay"), langBtn = $(".act-lang"), clearBtn = $(".act-clear");
		const convsEl = $(".rtr-convs"), rulerEl = $(".rtr-ruler"), replayBar = $(".rtr-replaybar");
		const listEl = $(".rtr-list"), detailEl = $(".rtr-detail");

		function applyLang() {
			const L = t();
			hdTitle.textContent = L.title;
			hdLive.textContent = `● ${L.live}`;
			qEl.placeholder = L.search;
			replayBtn.textContent = replay.on ? `⏹ ${L.exitReplay}` : `▶ ${L.replay}`;
			replayBtn.classList.toggle("on", replay.on);
			langBtn.textContent = lang === "zh" ? "EN" : "中文";
			clearBtn.textContent = `🗑 ${L.clear}`;
		}

		function convOf(id) { return convs.find((c) => c.id === id); }
		function allSegs() { return segsCache.get(selectedConvId ?? "") ?? []; }
		function visibleSegs() {
			const q = search.trim().toLowerCase();
			return allSegs().filter((s) => {
				if (!filters[s.lane]) return false;
				if (q && !`${s.title}\n${s.summary}\n${s.source}\n${s.meta?.tool ?? ""}`.toLowerCase().includes(q)) return false;
				return true;
			});
		}

		function renderConvs() {
			const L = t();
			if (!convs.length) {
				convsEl.innerHTML = `<span style="opacity:.55;font-size:12px">${esc(L.emptyHint)}</span>`;
				return;
			}
			convsEl.innerHTML = convs
				.map((c) => `<button class="rtr-conv${c.id === selectedConvId ? " sel" : ""}" data-id="${esc(c.id)}">${c.id === activeId ? `<span class="cur">●</span> ` : ""}${esc(c.title || L.empty)}${c.isStreaming ? " ⏳" : ""}</button>`)
				.join("");
		}

		function renderRuler() {
			const L = t();
			const hintEl = rulerEl.querySelector(".hint");
			const fitBtn = rulerEl.querySelector(".act-fit");
			if (hintEl) hintEl.textContent = L.zoomHint;
			if (fitBtn) fitBtn.textContent = L.fit;
			const body = rulerEl.querySelector(".rtr-tlbody");
			const all = visibleSegs();
			void ensureVis(); // 后台加载专业时间轴，备好后自动重渲
			if (!visApi || !selectedConvId || !all.length) {
				if (tl) destroyTl();
				if (body) renderRulerFallback(body, all);
				return;
			}
			if (body && body.firstChild !== tlDom()) {
				body.innerHTML = "";
				body.appendChild(tlDom());
			}
			const groups = [
				{ id: "input", content: esc(L.lanes.input) },
				{ id: "model", content: esc(L.lanes.model) },
				{ id: "tools", content: esc(L.lanes.tools) },
			];
			if (!tl || tlConv !== selectedConvId) {
				destroyTl();
				tlItems = new visApi.DataSet(visItems(all));
				tl = new visApi.Timeline(tlDom(), tlItems, groups, {
					stack: true,
					orientation: "top",
					showMajorLabels: true,
					showMinorLabels: true,
					zoomable: true,
					moveable: true,
					selectable: true,
					multiselect: false,
					zoomMin: 10,
					zoomMax: 1000 * 60 * 60 * 24 * 30,
					margin: { item: 3, axis: 6 },
					tooltip: { followMouse: true, overflowMethod: "cap" },
					height: "252px",
				});
				tl.on("select", (props) => {
					const id = props.items?.[0];
					if (id !== undefined && !suppressSelect) selectSeg(String(id));
				});
				tl.on("rangechanged", (props) => {
					if (props.byUser) userZoomed = true;
					hideTip();
				});
				tl.on("itemover", (props) => {
					if (props.item !== undefined && props.event) showTip(String(props.item), props.event);
				});
				tl.on("itemout", () => hideTip());
				tlConv = selectedConvId;
				userZoomed = false;
				try {
					tl.fit({ animation: false });
				} catch {}
			} else {
				try {
					tl.setGroups(groups);
					tlItems.clear();
					tlItems.add(visItems(all));
				} catch {}
				// 实时增量不碰窗口——用户缩放到毫秒级也不会被拽回
			}
			try {
				suppressSelect = true;
				tl.setSelection(selectedKey ? [selectedKey] : []);
			} catch {} finally {
				suppressSelect = false;
			}
		}

		/** 即时浮层（itemover 当帧展示，无原生 title 的延迟；离开/缩放即藏）。 */
		function showTip(key, ev) {
			const s = allSegs().find((x) => x.key === key);
			if (!s) return;
			let tip = container.querySelector(".rtr-tip");
			if (!tip) {
				tip = document.createElement("div");
				tip.className = "rtr-tip";
				container.appendChild(tip);
			}
			tip.innerHTML = `<div class="tt">${esc(s.title)}</div><div class="tm">${esc(s.source ?? "")}</div><div class="tm">${esc(fmtClock(s.t))}${s.dur !== undefined ? ` · ${esc(fmtDur(s.dur))}` : ""}${s.end > s.t ? ` → ${esc(fmtClock(s.end))}` : ""}</div>`;
			tip.style.display = "block";
			const r = container.getBoundingClientRect();
			const x = Math.min(Math.max(8, (ev.clientX ?? 0) - r.left + 14), Math.max(8, r.width - 330));
			const y = Math.min(Math.max(8, (ev.clientY ?? 0) - r.top + 16), Math.max(8, r.height - 90));
			tip.style.left = `${x}px`;
			tip.style.top = `${y}px`;
		}

		function hideTip() {
			container.querySelector(".rtr-tip")?.remove();
		}

		/** vis-timeline 条目。瞬时事件（用户输入/系统，无 dur）用 box 标记点渲染——
		 *  缩放到多分钟跨度时也不消失；有真实/估计时长的用 range，显示层再保底
		 *  最小宽度（约总跨度 0.2%，至少 1s），纯展示不改数据。 */
		function visItems(all) {
			const starts = all.map((s) => s.t);
			const ends = all.map((s) => Math.max(s.end ?? s.t, s.t));
			const span = Math.max(1, Math.max(...ends) - Math.min(...starts));
			const minDur = Math.max(1000, span * 0.002);
			return all.map((s) => {
				const startMs = s.t;
				const endMs = Math.max(s.end ?? s.t, s.t);
				const cls = `lane-${s.lane}${s.status === "error" ? " st-error" : ""}${s.status === "running" ? " st-running" : ""}`;
				if (endMs <= startMs) {
					return { id: s.key, group: s.lane, start: new Date(startMs), type: "box", className: cls };
				}
				const end = new Date(endMs - startMs < minDur ? startMs + minDur : endMs);
				return {
					id: s.key,
					group: s.lane,
					start: new Date(startMs),
					end,
					type: "range",
					content: "",
					className: cls,
				};
			});
		}

		/** 专业库缺席时的手写时间轴（离线无 vendor 且 CDN 不可达时兜底）。 */
		function renderRulerFallback(body, all) {
			const L = t();
			if (tl) destroyTl();
			if (!selectedConvId || !all.length) {
				body.innerHTML = ["input", "model", "tools"]
					.map((ln) => `<div class="rtr-lane"><span class="ln">${esc(L.lanes[ln])}</span><div class="rtr-track"></div></div>`)
					.join("");
				body._vis = null;
				return;
			}
			const minT = Math.min(...all.map((s) => s.t));
			const maxT = Math.max(...all.map((s) => Math.max(s.end ?? s.t, s.t)));
			const span = Math.max(1, maxT - minT);
			const total = all[all.length - 1] ? fmtDur(maxT - minT) : "";
			const lanes = ["input", "model", "tools"];
			body.innerHTML = `
<div class="rtr-axis"><span>${esc(fmtClock(minT))}</span><span>${esc(total)}</span><span>${esc(fmtClock(maxT))}</span></div>
${lanes
					.map((ln) => {
						const blocks = all
							.map((s, i) => ({ s, i }))
							.filter(({ s }) => s.lane === ln);
						return `<div class="rtr-lane"><span class="ln">${esc(L.lanes[ln])}</span><div class="rtr-track">${blocks
							.map(({ s, i }) => {
								const left = ((s.t - minT) / span) * 100;
								const end = Math.max(s.end ?? s.t, s.t + span * 0.004);
								const width = ((end - s.t) / span) * 100;
								return `<span class="rtr-blk lane-${ln}${s.status === "error" ? " st-error" : ""}${s.status === "running" ? " st-running" : ""}${s.key === selectedKey ? " sel" : ""}" data-i="${i}" title="${esc(s.title)}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></span>`;
							})
							.join("")}</div></div>`;
					})
					.join("")}`;
			body._vis = all;
		}

		function renderList() {
			const L = t();
			const all = visibleSegs();
			if (!selectedConvId) {
				listEl.innerHTML = `<div class="rtr-empty">${esc(L.selectHint)}</div>`;
				return;
			}
			if (!all.length) {
				listEl.innerHTML = `<div class="rtr-empty">${esc(allSegs().length ? L.noMatch : L.emptyHint)}</div>`;
				return;
			}
			const shown = replay.on ? all.slice(0, replay.idx + 1) : all;
			listEl.innerHTML = shown
				.map((s) => `<button class="rtr-row${s.key === selectedKey ? " sel" : ""}${s.status === "error" ? " err" : ""}" data-key="${esc(s.key)}">
<span class="rtr-chip">${esc(chipFor(s, lang))}</span>
<span class="tt">${esc(s.title)}</span>
<time>${esc(fmtClock(s.t))}${s.dur !== undefined ? ` · ${esc(fmtDur(s.dur))}` : ""}</time>
</button>`).join("");
			renderReplayBar(all);
		}

		function renderReplayBar(all) {
			const L = t();
			if (!replay.on || !all.length) {
				replayBar.hidden = true;
				replayBar.innerHTML = "";
				return;
			}
			replayBar.hidden = false;
			replayBar.innerHTML = `
<button class="rtr-btn act-play">${replay.playing ? `⏸ ${esc(L.pause)}` : `▶ ${esc(L.play)}`}</button>
<input type="range" min="0" max="${all.length - 1}" value="${Math.min(replay.idx, all.length - 1)}" />
<span>${Math.min(replay.idx, all.length - 1) + 1}/${all.length}</span>
<label>${esc(L.speed)} <select class="spd">${[0.5, 1, 2, 4].map((x) => `<option value="${x}"${x === replay.speed ? " selected" : ""}>${x}x</option>`).join("")}</select></label>`;
		}

		function kvRow(k, v) { return `<dt>${esc(k)}</dt><dd>${v}</dd>`; }

		function renderDetail() {
			const L = t(), F = L.f;
			const c = convOf(selectedConvId ?? "");
			const all = visibleSegs();
			const seg = allSegs().find((s) => s.key === selectedKey) ?? null;
			const cached = seg ? detailCache.get(`${selectedConvId}\n${seg.key}`) : null;

			// 无选中 → 对话级分析
			if (!seg || !c) {
				if (!c?.analysis) {
					detailEl.innerHTML = `<div class="rtr-empty">${esc(c ? L.selectHint : L.emptyHint)}</div>`;
					return;
				}
				const a = c.analysis;
				const maxMs = Math.max(1, ...a.tools.map((x) => x.ms));
				detailEl.innerHTML = `
<h3 style="margin:0 0 8px">📊 ${esc(c.title || L.title)}</h3>
<dl class="rtr-kv">
${kvRow(F.total, esc(fmtDur(a.totalMs)))}${kvRow(F.turns, esc(String(a.turns)))}${kvRow(F.segs, esc(String(c.segCount)))}
${kvRow(F.toolCalls, esc(`${a.toolCalls}（${F.toolErr} ${a.toolErrs}）`))}${kvRow(F.toolTime, esc(fmtDur(a.toolMs)))}
${kvRow(F.files, esc(a.filesChanged.length ? `${a.filesChanged.length} 个` : "—"))}
</dl>
<div class="rtr-sec">${esc(F.phase)} · 💬${a.counts.text} 💭${a.counts.thinking} 🔧${a.counts.tool} 📝${a.counts.file} 👤${a.counts.user}</div>
<div class="rtr-sec">${esc(F.slowest)}</div>
${a.tools.slice(0, 5).map((x) => `<div style="font-size:12px">${esc(x.name)} · ${x.calls}× · ${esc(fmtDur(x.ms))}${x.errs ? ` · ❌${x.errs}` : ""}</div><div class="rtr-bar"><i style="width:${((x.ms / maxMs) * 100).toFixed(1)}%"></i></div>`).join("") || `<div style="opacity:.6;font-size:12px">—</div>`}
${a.filesChanged.length ? `<div class="rtr-sec">${esc(F.files)}</div><pre>${esc(a.filesChanged.slice(0, 20).join("\n"))}</pre>` : ""}`;
				return;
			}

			// 有选中 → 四 tab
			const tabs = ["overview", "preview", "raw", "source"].map((k) => `<button class="rtr-dtab${detailTab === k ? " on" : ""}" data-tab="${k}">${esc(L.tabs[k])}</button>`).join("");
			let body = "";
			if (!cached) {
				body = `<div class="rtr-empty"><span class="rtr-spin">⏳</span> ${esc(L.loading)}</div>`;
			} else if (detailTab === "overview") {
				const an = cached.analysis ?? {};
				const st = L.status[seg.status] ?? seg.status;
				body = `<dl class="rtr-kv">
${kvRow(F.source, esc(seg.source ?? "—"))}${kvRow(F.status, esc(st))}${kvRow(F.dur, esc(fmtDur(seg.dur)))}
${kvRow(F.turn, esc(an.turnText ?? (seg.turn ? `第 ${seg.turn} 轮` : "—")))}${kvRow(F.len, esc(seg.meta?.chars ? `${seg.meta.chars} 字` : `${(cached.detail ?? "").length} 字`))}${kvRow(F.pos, esc(an.position ?? "—"))}
</dl>`;
				if (an.tool) {
					const avg = an.tool.calls ? an.tool.ms / an.tool.calls : 0;
					const share = an.convToolMs ? (100 * (an.tool.ms / an.convToolMs)).toFixed(0) : "0";
					body += `<div class="rtr-sec">📈 ${esc(an.tool.name)}</div><dl class="rtr-kv">
${kvRow(F.calls, esc(`${an.tool.calls}（${F.toolErr} ${an.tool.errs}，${F.errRate} ${an.tool.calls ? Math.round((100 * an.tool.errs) / an.tool.calls) : 0}%）`))}
${kvRow(F.toolTime, esc(`${fmtDur(an.tool.ms)} · ${F.avg} ${fmtDur(avg)} · ${F.share} ${share}%`))}
</dl>`;
				}
				body += `<div class="rtr-sec">${esc(L.tabs.preview)}</div><pre>${esc((cached.detail ?? "").slice(0, 800))}</pre>`;
			} else if (detailTab === "preview") {
				body = `<pre>${esc((cached.detail ?? "").slice(0, 2000))}</pre>`;
			} else if (detailTab === "raw") {
				body = `<pre>${esc(cached.detail ?? "")}</pre><div style="height:10px"></div><button class="rtr-btn act-copy">📋 ${esc(L.copy)}</button>`;
			} else {
				const an = cached.analysis ?? {};
				body = `<dl class="rtr-kv">
${kvRow(F.msgKey, esc(seg.key))}${seg.meta?.toolCallId ? kvRow(F.toolCall, esc(seg.meta.toolCallId)) : ""}
${kvRow(F.turn, esc(an.turnText ?? (seg.turn ? `第 ${seg.turn} 轮 · 共 ${an.convTurns ?? "?"} 轮` : "—")))}
${kvRow(F.conv, esc(`${c.title ?? ""} · ${String(c.id).slice(0, 8)}`))}${kvRow(F.time, esc(fmtClock(seg.t)))}
</dl>`;
			}
			detailEl.innerHTML = `<h3 style="margin:0 0 8px">${esc(seg.title)}</h3><div class="rtr-dtabs">${tabs}</div>${body}`;
		}

		function scheduleRender(stick = true) {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				const keep = stick && !replay.on && listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
				renderConvs();
				renderRuler();
				renderList();
				renderDetail();
				if (keep) listEl.scrollTop = listEl.scrollHeight;
			});
		}

		function selectConv(id) {
			selectedConvId = id;
			selectedKey = null;
			replay.on = false;
			stopPlay();
			applyLang();
			if (id && !segsCache.has(id)) ctx.send({ action: "get_conv", convId: id });
			scheduleRender(false);
		}

		function selectSeg(key) {
			hideTip();
			selectedKey = key;
			if (replay.on) {
				const i = visibleSegs().findIndex((s) => s.key === key);
				if (i >= 0) replay.idx = i;
			}
			const ck = `${selectedConvId}\n${key}`;
			if (key && !detailCache.has(ck) && !pendingSeg.has(ck)) {
				pendingSeg.add(ck);
				ctx.send({ action: "get_seg", convId: selectedConvId, key });
			}
			scheduleRender();
		}

		function stopPlay() {
			replay.playing = false;
			if (replay.timer) clearInterval(replay.timer);
			replay.timer = 0;
		}
		function startPlay() {
			stopPlay();
			replay.playing = true;
			replay.timer = setInterval(() => {
				const all = visibleSegs();
				if (replay.idx >= all.length - 1) { stopPlay(); scheduleRender(); return; }
				replay.idx += 1;
				selectedKey = all[replay.idx]?.key ?? selectedKey;
				scheduleRender();
			}, Math.max(200, 900 / replay.speed));
		}

		// ---- 事件 ----
		convsEl.addEventListener("click", (e) => {
			const b = e.target.closest("[data-id]");
			if (b) selectConv(b.dataset.id);
		});
		rulerEl.addEventListener("click", (e) => {
			if (e.target.closest(".act-fit")) {
				try {
					tl?.fit({ animation: true });
					userZoomed = false;
				} catch {}
				return;
			}
			if (tl) return; // 专业时间轴自己处理 select
			const body = rulerEl.querySelector(".rtr-tlbody");
			const b = e.target.closest("[data-i]");
			if (b && body?._vis) {
				const s = body._vis[Number(b.dataset.i)];
				if (s) selectSeg(s.key);
			}
		});
		listEl.addEventListener("click", (e) => {
			const b = e.target.closest("[data-key]");
			if (b) selectSeg(b.dataset.key);
		});
		detailEl.addEventListener("click", (e) => {
			const tab = e.target.closest("[data-tab]");
			if (tab) {
				detailTab = tab.dataset.tab;
				scheduleRender();
				return;
			}
			if (e.target.closest(".act-copy")) {
				const cached = detailCache.get(`${selectedConvId}\n${selectedKey}`);
				const txt = cached ? `${cached.seg.title}\n${cached.detail}` : "";
				if (txt) {
					navigator.clipboard?.writeText(txt).then(() => {
						e.target.textContent = `✅ ${t().copied}`;
						setTimeout(scheduleRender, 1200);
					}, () => {});
				}
			}
		});
		qEl.addEventListener("input", () => { search = qEl.value; scheduleRender(); });
		replayBtn.addEventListener("click", () => {
			if (!selectedConvId) return;
			replay.on = !replay.on;
			stopPlay();
			if (replay.on) {
				replay.idx = 0;
				selectedKey = visibleSegs()[0]?.key ?? null;
				if (selectedKey) selectSeg(selectedKey);
			}
			applyLang();
			scheduleRender(false);
		});
		replayBar.addEventListener("click", (e) => {
			if (e.target.closest(".act-play")) {
				if (replay.playing) stopPlay();
				else startPlay();
				scheduleRender();
			}
		});
		replayBar.addEventListener("input", (e) => {
			if (e.target.matches('input[type="range"]')) {
				stopPlay();
				replay.idx = Number(e.target.value);
				selectedKey = visibleSegs()[replay.idx]?.key ?? null;
				scheduleRender();
			}
		});
		replayBar.addEventListener("change", (e) => {
			if (e.target.matches(".spd")) {
				replay.speed = Number(e.target.value);
				if (replay.playing) startPlay();
			}
		});
		langBtn.addEventListener("click", () => {
			lang = lang === "zh" ? "en" : "zh";
			applyLang();
			scheduleRender();
		});
		clearBtn.addEventListener("click", () => {
			if (window.confirm(t().confirmClear)) ctx.send({ action: "clear" });
		});

		const off = ctx.onData((p) => {
			if (!p || typeof p !== "object") return;
			switch (p.kind) {
				case "state":
					convs = Array.isArray(p.conversations) ? p.conversations : [];
					activeId = p.activeId ?? null;
					if ((!selectedConvId || !convs.some((c) => c.id === selectedConvId)) && activeId) {
						selectConv(activeId);
						return;
					}
					scheduleRender();
					break;
				case "conv_new":
					if (p.conv && !convs.some((c) => c.id === p.conv.id)) convs.unshift(p.conv);
					if (!selectedConvId) selectConv(p.conv.id);
					else scheduleRender();
					break;
				case "conv_update":
					if (p.conv) {
						const i = convs.findIndex((c) => c.id === p.conv.id);
						if (i >= 0) convs[i] = p.conv;
						else convs.unshift(p.conv);
					}
					scheduleRender();
					break;
				case "segs": {
					if (!p.convId || !Array.isArray(p.segs)) break;
					if (p.reset || !segsCache.has(p.convId)) segsCache.set(p.convId, [...p.segs]);
					else segsCache.get(p.convId).push(...p.segs);
					if (p.convId === selectedConvId && !selectedKey && p.segs.length && !replay.on) {
						selectedKey = p.segs[p.segs.length - 1].key;
						selectSeg(selectedKey);
						return;
					}
					scheduleRender();
					break;
				}
				case "seg_update": {
					const arr = segsCache.get(p.convId ?? "");
					const s = arr?.find((x) => x.key === p.key);
					if (s && p.patch) Object.assign(s, p.patch);
					scheduleRender();
					break;
				}
				case "seg_detail":
					if (p.key) {
						const ck = `${p.convId}\n${p.key}`;
						pendingSeg.delete(ck);
						detailCache.set(ck, { detail: String(p.detail ?? ""), seg: p.seg, analysis: p.analysis });
						if (p.convId === selectedConvId && p.key === selectedKey) scheduleRender(false);
					}
					break;
				case "cleared":
					convs = [];
					segsCache.clear();
					detailCache.clear();
					pendingSeg.clear();
					selectedConvId = null;
					selectedKey = null;
					activeId = null;
					replay.on = false;
					stopPlay();
					applyLang();
					scheduleRender(false);
					break;
				default:
					break;
			}
		});

		applyLang();
		scheduleRender(false);
		ctx.send({ action: "state" });

		return () => {
			stopPlay();
			if (raf) cancelAnimationFrame(raf);
			destroyTl();
			off();
			container.innerHTML = "";
		};
	},
};
