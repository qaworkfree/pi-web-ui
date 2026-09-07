/**
 * run-trace 客户端视图 —— 运行轨迹时间线。
 *
 * 约定：ESM 默认导出 { mount(container, ctx) → cleanup? }。
 * ctx.send 上行 plugin_message；ctx.onData 订阅 plugin_data。
 * 纯 DOM，无依赖（不共享主应用 React 实例）。
 *
 * 布局（三栏，一眼看全貌、一点看细节）：
 *   左 = 轮次列表（任务标题 + 状态 + 计数）
 *   中 = 选中轮次的时间线（节点卡片，纵向轨迹；支持回放）
 *   右 = 选中节点的详情（完整文本/参数/结果，一键复制）
 */

const KIND_FILTER = { thinking: "thinking", tool: "tools", file: "files", text: "texts", turn: "turns" };

const I18N = {
	zh: {
		subtitle: "任务 → 思考 → 工具 → 文件 → 结果",
		live: "实时",
		search: "搜索节点…",
		replay: "回放",
		exitReplay: "退出回放",
		play: "播放",
		pause: "暂停",
		speed: "速度",
		clear: "清空",
		confirmClear: "确定清空全部轨迹历史吗？",
		empty: "暂无运行轨迹",
		emptyHint: "在对话中发送任务后，这里会实时聚出完整时间线。",
		selectHint: "在左侧选一轮，或等待新任务开始。",
		loading: "加载中…",
		noMatch: "没有匹配的节点（检查搜索/筛选）。",
		copy: "复制",
		copied: "已复制",
		task: "任务",
		filters: { thinking: "💭思考", tools: "🔧工具", files: "📝文件", texts: "💬文本", turns: "轮次" },
		status: { running: "进行中", done: "已完成", stopped: "已停止" },
		statLine: (c) => `💭${c.thinking} 🔧${c.tools} 📝${c.files} 💬${c.texts}`,
		justNow: "刚刚",
	},
	en: {
		subtitle: "task → thinking → tools → files → result",
		live: "live",
		search: "Search nodes…",
		replay: "Replay",
		exitReplay: "Exit replay",
		play: "Play",
		pause: "Pause",
		speed: "Speed",
		clear: "Clear",
		confirmClear: "Clear all trajectory history?",
		empty: "No runs yet",
		emptyHint: "Send a task in chat and the full timeline aggregates here live.",
		selectHint: "Pick a run on the left, or wait for a new task.",
		loading: "Loading…",
		noMatch: "No matching nodes (check search/filters).",
		copy: "Copy",
		copied: "Copied",
		task: "Task",
		filters: { thinking: "💭Thinking", tools: "🔧Tools", files: "📝Files", texts: "💬Text", turns: "Turns" },
		status: { running: "Running", done: "Done", stopped: "Stopped" },
		statLine: (c) => `💭${c.thinking} 🔧${c.tools} 📝${c.files} 💬${c.texts}`,
		justNow: "just now",
	},
};

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(t) {
	try {
		return new Date(t).toLocaleTimeString();
	} catch {
		return "";
	}
}

function fmtDur(ms) {
	if (ms === undefined || ms === null) return "";
	const s = ms / 1000;
	return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export default {
	mount(container, ctx) {
		let lang = "zh";
		const t = () => I18N[lang];
		/** summaries（服务端序：新在前）。 */
		let runs = [];
		let activeRunId = null;
		/** runId → 全量 nodes（get/detail 或 run_new 起始 + nodes 增量）。 */
		const nodesCache = new Map();
		/** 待补全的 runId（已发 get，等 detail）。 */
		const pendingGet = new Set();
		let selectedId = null;
		let selectedSeq = null;
		let search = "";
		const filters = { thinking: true, tools: true, files: true, texts: true, turns: true };
		const replay = { on: false, idx: 0, playing: false, timer: 0, speed: 1 };
		let raf = 0;

		container.innerHTML = `
<div class="rtr">
	<style>
		.rtr { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; color: var(--text, #e6e8ef); }
		.rtr-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border, #262a35); flex-wrap: wrap; }
		.rtr-hd h2 { margin: 0; font-size: 15px; }
		.rtr-hd .sub { opacity: .55; font-size: 12px; }
		.rtr-live { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: var(--green-soft, rgba(52,211,153,.12)); color: var(--green, #34d399); }
		.rtr-hd input[type="search"] { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 5px 9px; font: inherit; width: 150px; }
		.rtr-hd .sp { flex: 1; }
		.rtr-btn { background: var(--bg-elev, #14161c); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit; }
		.rtr-btn:hover { border-color: var(--accent, #8b5cff); }
		.rtr-btn.on { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cff); }
		.rtr-btn.danger:hover { border-color: var(--red, #f87171); color: var(--red, #f87171); }
		.rtr-filters { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--border, #262a35); flex-wrap: wrap; }
		.rtr-filters .rtr-btn { font-size: 12px; padding: 3px 9px; opacity: .45; }
		.rtr-filters .rtr-btn.on { opacity: 1; }
		.rtr-bd { display: flex; flex: 1; min-height: 0; }
		.rtr-runs { width: 250px; min-width: 250px; border-right: 1px solid var(--border, #262a35); overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
		.rtr-run { border: 1px solid var(--border, #262a35); border-radius: 8px; padding: 8px 10px; cursor: pointer; background: transparent; text-align: left; color: inherit; font: inherit; }
		.rtr-run:hover { border-color: var(--accent, #8b5cff); }
		.rtr-run.sel { background: var(--accent-soft, rgba(139,92,246,.14)); border-color: var(--accent, #8b5cff); }
		.rtr-run .tt { font-weight: 600; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
		.rtr-run .mt { display: flex; gap: 6px; align-items: center; margin-top: 5px; font-size: 11px; opacity: .75; }
		.rtr-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint, #6b7284); flex: none; }
		.rtr-dot.running { background: var(--green, #34d399); animation: rtr-blink 1.2s infinite; }
		.rtr-dot.stopped { background: var(--amber, #fbbf24); }
		@keyframes rtr-blink { 50% { opacity: .3; } }
		.rtr-tl-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
		.rtr-replaybar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border, #262a35); background: var(--bg-elev, #14161c); }
		.rtr-replaybar input[type="range"] { flex: 1; accent-color: var(--accent, #8b5cff); }
		.rtr-replaybar select { background: var(--bg-elev2, #1a1d26); color: inherit; border: 1px solid var(--border, #262a35); border-radius: 6px; font: inherit; padding: 3px 6px; }
		.rtr-tl { flex: 1; overflow-y: auto; padding: 12px 14px 24px; min-height: 0; }
		.rtr-node { position: relative; padding: 0 0 4px 26px; cursor: pointer; }
		.rtr-node::before { content: ""; position: absolute; left: 8px; top: 26px; bottom: -2px; width: 2px; background: var(--border, #262a35); }
		.rtr-node:last-child::before { display: none; }
		.rtr-ic { position: absolute; left: 0; top: 8px; width: 18px; height: 18px; border-radius: 50%; background: var(--bg-elev2, #1a1d26); border: 1px solid var(--border, #262a35); display: flex; align-items: center; justify-content: center; font-size: 10px; }
		.rtr-node.sel .rtr-card { border-color: var(--accent, #8b5cff); background: var(--accent-soft, rgba(139,92,246,.14)); }
		.rtr-card { border: 1px solid var(--border, #262a35); border-radius: 8px; padding: 7px 10px; background: var(--bg-elev, #14161c); }
		.rtr-card:hover { border-color: var(--accent, #8b5cff); }
		.rtr-card .nt { font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
		.rtr-card .nt time { margin-left: auto; font-weight: 400; font-size: 11px; opacity: .55; flex: none; }
		.rtr-card .ns { margin-top: 3px; font-size: 12px; opacity: .8; white-space: pre-wrap; word-break: break-word; }
		.rtr-card .dur { font-size: 11px; opacity: .55; }
		.rtr-node.err .rtr-card { border-color: var(--red, #f87171); }
		.rtr-turn { text-align: center; font-size: 11px; opacity: .5; padding: 8px 0 12px; }
		.rtr-detail { width: 330px; min-width: 330px; border-left: 1px solid var(--border, #262a35); overflow-y: auto; padding: 12px 14px; min-height: 0; }
		.rtr-detail h3 { margin: 0 0 6px; font-size: 14px; }
		.rtr-detail .meta { font-size: 11px; opacity: .6; margin-bottom: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
		.rtr-detail pre { white-space: pre-wrap; word-break: break-word; background: var(--bg-elev, #14161c); border: 1px solid var(--border, #262a35); border-radius: 8px; padding: 9px 11px; font-size: 12px; margin: 0; max-height: none; }
		.rtr-empty { opacity: .6; text-align: center; padding: 40px 20px; }
		.rtr-spin { display: inline-block; animation: rtr-blink 1s infinite; }
	</style>
	<div class="rtr-hd">
		<h2>🧭 <span class="t-title"></span></h2>
		<span class="sub"></span>
		<span class="rtr-live"></span>
		<span class="sp"></span>
		<input type="search" class="q" />
		<button class="rtr-btn act-replay"></button>
		<button class="rtr-btn act-lang">EN</button>
		<button class="rtr-btn danger act-clear"></button>
	</div>
	<div class="rtr-filters"></div>
	<div class="rtr-bd">
		<div class="rtr-runs"></div>
		<div class="rtr-tl-wrap">
			<div class="rtr-replaybar" hidden></div>
			<div class="rtr-tl"></div>
		</div>
		<div class="rtr-detail"></div>
	</div>
</div>`;

		const $ = (s) => container.querySelector(s);
		const hdTitle = $(".t-title"), hdSub = $(".sub"), hdLive = $(".rtr-live");
		const qEl = $(".q"), replayBtn = $(".act-replay"), langBtn = $(".act-lang"), clearBtn = $(".act-clear");
		const filtersEl = $(".rtr-filters"), runsEl = $(".rtr-runs");
		const replayBar = $(".rtr-replaybar"), tlEl = $(".rtr-tl"), detailEl = $(".rtr-detail");

		function applyLang() {
			const L = t();
			hdTitle.textContent = lang === "zh" ? "运行轨迹" : "Run Trace";
			hdSub.textContent = L.subtitle;
			hdLive.textContent = `● ${L.live}`;
			qEl.placeholder = L.search;
			replayBtn.textContent = replay.on ? `⏹ ${L.exitReplay}` : `▶ ${L.replay}`;
			replayBtn.classList.toggle("on", replay.on);
			langBtn.textContent = lang === "zh" ? "EN" : "中文";
			clearBtn.textContent = `🗑 ${L.clear}`;
			filtersEl.innerHTML = Object.entries(L.filters)
				.map(([k, label]) => `<button class="rtr-btn${filters[k] ? " on" : ""}" data-f="${k}">${esc(label)}</button>`)
				.join("");
		}

		function visibleNodes(runId) {
			const all = nodesCache.get(runId) ?? [];
			const q = search.trim().toLowerCase();
			return all.filter((n) => {
				const fk = KIND_FILTER[n.kind];
				if (fk && !filters[fk]) return false;
				if (q && !`${n.title}\n${n.summary}\n${n.detail}`.toLowerCase().includes(q)) return false;
				return true;
			});
		}

		function renderRuns() {
			const L = t();
			if (!runs.length) {
				runsEl.innerHTML = `<div class="rtr-empty">🧭<br><b>${esc(L.empty)}</b><br>${esc(L.emptyHint)}</div>`;
				return;
			}
			runsEl.innerHTML = runs
				.map((r) => {
					const st = L.status[r.status] ?? r.status;
					return `<button class="rtr-run${r.id === selectedId ? " sel" : ""}" data-id="${esc(r.id)}">
	<div class="tt">${esc(r.task)}</div>
	<div class="mt"><span class="rtr-dot ${esc(r.status)}"></span><span>${esc(st)}</span><span>${esc(fmtTime(r.startedAt))}</span></div>
	<div class="mt">${esc(L.statLine(r.counts))}${r.truncated ? " · …" : ""}</div>
</button>`;
				})
				.join("");
		}

		function stickBottom() {
			return tlEl.scrollHeight - tlEl.scrollTop - tlEl.clientHeight < 60;
		}

		function renderTimeline() {
			const L = t();
			if (!selectedId) {
				tlEl.innerHTML = `<div class="rtr-empty">${esc(L.selectHint)}</div>`;
				renderReplayBar([]);
				return;
			}
			if (pendingGet.has(selectedId) && !nodesCache.has(selectedId)) {
				tlEl.innerHTML = `<div class="rtr-empty"><span class="rtr-spin">⏳</span> ${esc(L.loading)}</div>`;
				renderReplayBar([]);
				return;
			}
			const all = visibleNodes(selectedId);
			if (!all.length) {
				tlEl.innerHTML = `<div class="rtr-empty">${esc(L.noMatch)}</div>`;
				renderReplayBar([]);
				return;
			}
			const shown = replay.on ? all.slice(0, replay.idx + 1) : all;
			tlEl.innerHTML = shown
				.map((n) => {
					if (n.kind === "turn") return `<div class="rtr-turn">${esc(n.title)}</div>`;
					return `<div class="rtr-node${n.seq === selectedSeq ? " sel" : ""}${n.error ? " err" : ""}" data-seq="${n.seq}">
	<div class="rtr-ic">${n.running ? "⏳" : "·"}</div>
	<div class="rtr-card">
		<div class="nt"><span>${esc(n.title)}</span><time>${esc(fmtTime(n.t))}${n.dur !== undefined ? ` · ${esc(fmtDur(n.dur))}` : ""}</time></div>
		${n.summary ? `<div class="ns">${esc(n.summary)}</div>` : ""}
	</div>
</div>`;
				})
				.join("");
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
<label>${esc(L.speed)} <select class="spd">
	${[0.5, 1, 2, 4].map((s) => `<option value="${s}"${s === replay.speed ? " selected" : ""}>${s}x</option>`).join("")}
</select></label>`;
		}

		function renderDetail() {
			const L = t();
			const nodes = nodesCache.get(selectedId ?? "") ?? [];
			const n = nodes.find((x) => x.seq === selectedSeq) ?? (replay.on ? visibleNodes(selectedId)[replay.idx] : null);
			if (!n) {
				detailEl.innerHTML = `<div class="rtr-empty">${esc(L.selectHint)}</div>`;
				return;
			}
			const meta = [`⏰ ${esc(fmtTime(n.t))}`];
			if (n.dur !== undefined) meta.push(`⏱ ${esc(fmtDur(n.dur))}`);
			if (n.tool) meta.push(`🔧 ${esc(n.tool)}`);
			if (n.files?.length) meta.push(`📝 ${n.files.length}`);
			detailEl.innerHTML = `
<h3>${esc(n.title)}</h3>
<div class="meta">${meta.join("<span>·</span>")}</div>
${n.files?.length ? `<pre>${esc(n.files.join("\n"))}</pre><div style="height:8px"></div>` : ""}
<pre>${esc(n.detail || n.summary || "")}</pre>
<div style="height:10px"></div>
<button class="rtr-btn act-copy">📋 ${esc(L.copy)}</button>`;
		}

		function scheduleRender(keepStick = true) {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				const stick = keepStick && stickBottom() && !replay.on;
				renderRuns();
				renderTimeline();
				renderDetail();
				if (stick) tlEl.scrollTop = tlEl.scrollHeight;
			});
		}

		function selectRun(id, scroll = false) {
			selectedId = id;
			selectedSeq = null;
			replay.on = false;
			stopPlay();
			applyLang();
			if (id && !nodesCache.has(id) && !pendingGet.has(id)) {
				pendingGet.add(id);
				ctx.send({ action: "get", runId: id });
			}
			scheduleRender(false);
			if (scroll) tlEl.scrollTop = tlEl.scrollHeight;
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
				const all = visibleNodes(selectedId);
				if (replay.idx >= all.length - 1) {
					stopPlay();
					scheduleRender();
					return;
				}
				replay.idx += 1;
				selectedSeq = all[replay.idx]?.seq ?? selectedSeq;
				scheduleRender();
			}, Math.max(200, 900 / replay.speed));
		}

		// ---- 事件 ----
		runsEl.addEventListener("click", (e) => {
			const b = e.target.closest("[data-id]");
			if (b) selectRun(b.dataset.id);
		});
		tlEl.addEventListener("click", (e) => {
			const b = e.target.closest("[data-seq]");
			if (b) {
				selectedSeq = Number(b.dataset.seq);
				if (replay.on) {
					const all = visibleNodes(selectedId);
					const i = all.findIndex((x) => x.seq === selectedSeq);
					if (i >= 0) replay.idx = i;
				}
				scheduleRender();
			}
		});
		filtersEl.addEventListener("click", (e) => {
			const b = e.target.closest("[data-f]");
			if (!b) return;
			filters[b.dataset.f] = !filters[b.dataset.f];
			b.classList.toggle("on", filters[b.dataset.f]);
			if (replay.on) replay.idx = 0;
			scheduleRender();
		});
		qEl.addEventListener("input", () => {
			search = qEl.value;
			scheduleRender();
		});
		replayBtn.addEventListener("click", () => {
			if (!selectedId) return;
			replay.on = !replay.on;
			stopPlay();
			if (replay.on) {
				replay.idx = 0;
				const all = visibleNodes(selectedId);
				selectedSeq = all[0]?.seq ?? null;
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
				selectedSeq = visibleNodes(selectedId)[replay.idx]?.seq ?? null;
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
		detailEl.addEventListener("click", (e) => {
			if (!e.target.closest(".act-copy")) return;
			const nodes = nodesCache.get(selectedId ?? "") ?? [];
			const n = nodes.find((x) => x.seq === selectedSeq);
			const txt = n ? `${n.title}\n${n.detail || n.summary || ""}` : "";
			if (!txt) return;
			navigator.clipboard?.writeText(txt).then(
				() => {
					e.target.textContent = `✅ ${t().copied}`;
					setTimeout(scheduleRender, 1200);
				},
				() => {},
			);
		});

		const off = ctx.onData((p) => {
			if (!p || typeof p !== "object") return;
			switch (p.kind) {
				case "state":
					runs = Array.isArray(p.runs) ? p.runs : [];
					activeRunId = p.activeRunId ?? null;
					if (!selectedId && activeRunId) {
						selectRun(activeRunId);
						return;
					}
					if (selectedId && !runs.some((r) => r.id === selectedId)) {
						selectedId = activeRunId ?? runs[0]?.id ?? null;
						selectedSeq = null;
					}
					scheduleRender();
					break;
				case "run_new":
					if (p.run && !runs.some((r) => r.id === p.run.id)) runs.unshift(p.run);
					activeRunId = p.run?.id ?? activeRunId;
					// 正在看实时轮（或还没选）→ 自动跟随新轮。
					if (!selectedId || selectedId === activeRunId || runs.length === 1) selectRun(activeRunId, true);
					else scheduleRender();
					break;
				case "run_update":
					if (p.run) {
						const i = runs.findIndex((r) => r.id === p.run.id);
						if (i >= 0) runs[i] = p.run;
						if (p.run.id === activeRunId && p.run.status !== "running") activeRunId = null;
					}
					scheduleRender();
					break;
				case "nodes": {
					if (!p.runId || !Array.isArray(p.nodes)) break;
					let arr = nodesCache.get(p.runId);
					if (!arr) {
						arr = [];
						nodesCache.set(p.runId, arr);
					}
					arr.push(...p.nodes);
					if (p.runId === selectedId && selectedSeq === null && !replay.on) {
						selectedSeq = p.nodes[p.nodes.length - 1]?.seq ?? selectedSeq;
					}
					scheduleRender();
					break;
				}
				case "node_update": {
					const arr = nodesCache.get(p.runId ?? "");
					const n = arr?.find((x) => x.seq === p.seq);
					if (n && p.patch) Object.assign(n, p.patch);
					scheduleRender();
					break;
				}
				case "detail":
					if (p.runId && Array.isArray(p.nodes)) {
						nodesCache.set(p.runId, p.nodes);
						pendingGet.delete(p.runId);
						if (p.runId === selectedId) {
							if (selectedSeq === null && p.nodes.length) selectedSeq = p.nodes[p.nodes.length - 1].seq;
							scheduleRender(false);
						}
					}
					break;
				case "cleared":
					runs = [];
					nodesCache.clear();
					pendingGet.clear();
					selectedId = null;
					selectedSeq = null;
					activeRunId = null;
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
		ctx.send({ action: "state" }); // 挂载后拉一次（服务端 onAttach 也会主动推，双保险）。

		return () => {
			stopPlay();
			if (raf) cancelAnimationFrame(raf);
			off();
			container.innerHTML = "";
		};
	},
};
