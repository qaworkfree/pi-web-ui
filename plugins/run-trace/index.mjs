/**
 * run-trace 服务端入口 —— 运行轨迹聚合。
 *
 * 订阅宿主的运行轨迹事件（host.onRunEvent：run_start / message /
 * tool_start / tool_end / turn_* / run_end），把一次 agent 执行聚成
 * 「任务 → 思考 → 工具调用 → 文件改动 → 结果」的时间线节点，广播给
 * 客户端视图（client/entry.mjs）。服务端是唯一事实源：新客户端接入
 * 经 onAttach 主动推送完整状态（kind:"state"）。
 *
 * 内存 + storage.json 双持（最近 30 轮，单轮最多 500 节点，文本封顶），
 * 重启/重载后历史仍在；超限丢最旧（保留每轮首个任务节点）。
 */

const MAX_RUNS = 30;
const MAX_NODES = 500;
const SUMMARY_CAP = 300;
const DETAIL_CAP = 8000;
const TASK_CAP = 500;

/** 疑似写文件的工具名（命中即从参数里抠路径，成功后追加 📝 文件节点）。 */
const WRITE_TOOL_RE = /edit|write|patch|apply|create|save|move|rename|delete|remove|mkdir/i;
/** 只读工具名（写判断优先排除，避免 read→❌ 误判；展示用 📖）。 */
const READONLY_TOOL_RE = /^(read|get|list|glob|grep|search|show|cat|fetch|query)/i;
/** 参数里可能装路径的键。 */
const PATH_KEYS = new Set(["path", "file", "filepath", "filePath", "filename", "fileName", "paths", "files", "dir", "cwd"]);

function cut(s, cap) {
	s = String(s ?? "");
	return s.length <= cap ? s : `${s.slice(0, cap)}\n… [truncated]`;
}

function firstLine(s, cap = 100) {
	const line = String(s ?? "").split("\n")[0] ?? "";
	const t = line.trim();
	return t.length <= cap ? t : `${t.slice(0, cap)}…`;
}

/** 从工具参数 JSON 里抠文件路径（只看一层 + 数组一层，启发式）。 */
export function extractPaths(argsText) {
	const out = [];
	try {
		const args = JSON.parse(String(argsText ?? "null"));
		if (!args || typeof args !== "object") return out;
		const push = (v) => {
			if (typeof v !== "string") return;
			const t = v.trim();
			if (t.length < 1 || t.length > 300) return;
			if (!/[/\\.]/.test(t)) return;
			if (out.length < 10 && !out.includes(t)) out.push(t);
		};
		for (const [k, v] of Object.entries(args)) {
			if (!PATH_KEYS.has(k)) continue;
			if (typeof v === "string") push(v);
			else if (Array.isArray(v)) for (const x of v) push(x);
		}
	} catch {
		/* 参数不可解析——无路径 */
	}
	return out;
}

/** 工具开始节点的标题（一眼看出在干什么）。 */
export function toolHeadline(toolName, argsText) {
	const name = String(toolName ?? "tool");
	if (name === "bash") {
		try {
			const cmd = JSON.parse(String(argsText ?? "{}"))?.command;
			if (cmd) return `bash · ${firstLine(cmd)}`;
		} catch {
			/* fallthrough */
		}
		return "bash";
	}
	const paths = extractPaths(argsText);
	if (paths.length) return `${name} · ${paths[0]}${paths.length > 1 ? ` (+${paths.length - 1})` : ""}`;
	const flat = firstLine(String(argsText ?? "").replace(/^\{|\}$/g, ""), 80);
	return flat ? `${name} · ${flat}` : name;
}

function messageText(message) {
	const parts = [];
	for (const b of message?.content ?? []) {
		if (b?.type === "text" && b.text?.trim()) parts.push(b.text);
	}
	return parts.join("\n");
}

export default {
	activate(host) {
		/** runId → run（插入序即时间序）。 */
		const runs = new Map();
		let saveTimer = null;

		const persist = () => {
			if (saveTimer) return;
			saveTimer = setTimeout(() => {
				saveTimer = null;
				try {
					host.storage.set("runs", [...runs.values()].slice(-MAX_RUNS));
				} catch (err) {
					host.log("persist failed:", err?.message ?? err);
				}
			}, 2000);
		};

		// 恢复历史（坏数据丢弃，不炸激活）。
		try {
			const saved = host.storage.get("runs", []);
			if (Array.isArray(saved)) {
				for (const r of saved.slice(-MAX_RUNS)) {
					if (r && typeof r.id === "string" && Array.isArray(r.nodes)) {
						if (r.status === "running") {
							r.status = "stopped";
							r.endedAt ??= r.startedAt;
						}
						runs.set(r.id, r);
					}
				}
			}
		} catch (err) {
			host.log("restore failed:", err?.message ?? err);
		}

		const summaryOf = (r) => ({
			id: r.id,
			conversationId: r.conversationId,
			task: r.task,
			startedAt: r.startedAt,
			endedAt: r.endedAt,
			status: r.status,
			counts: { ...r.counts },
			nodeCount: r.nodes.length,
			truncated: !!r.truncated,
		});

		const pushNodes = (r, nodes) => {
			for (const n of nodes) {
				if (r.nodes.length >= MAX_NODES) {
					// 掐尾保头：第 2 个起丢最旧（首节点永远是任务）。
					r.nodes.splice(1, 1);
					r.truncated = true;
				}
				n.seq = r.nextSeq++;
				r.nodes.push(n);
			}
			host.broadcast({ kind: "nodes", runId: r.id, nodes });
			persist();
		};

		const pushState = (to) => {
			const payload = {
				kind: "state",
				runs: [...runs.values()].map(summaryOf).reverse(),
				activeRunId: [...runs.values()].reverse().find((r) => r.status === "running")?.id ?? null,
			};
			if (to) host.sendTo(to, payload);
			else host.broadcast(payload);
		};

		const newRun = (conversationId, task) => {
			const startedAt = Date.now();
			const r = {
				id: `${conversationId ?? "conv"}-${startedAt}`,
				conversationId,
				task: cut(task || "（继续执行）", TASK_CAP),
				startedAt,
				endedAt: null,
				status: "running",
				turn: 0,
				nextSeq: 0,
				counts: { thinking: 0, tools: 0, files: 0, texts: 0 },
				nodes: [],
			};
			runs.set(r.id, r);
			// 超限：丢最旧的已结束轮（运行中的永远保留）。
			const done = [...runs.values()].filter((x) => x.status !== "running");
			while (runs.size > MAX_RUNS && done.length) {
				const oldest = done.shift();
				if (oldest && oldest.id !== r.id) runs.delete(oldest.id);
				else break;
			}
			return r;
		};

		/** runId → 未配对的 tool_start（toolCallId → { run, node }）。 */
		const pendingTools = new Map();
		let currentRunId = null;

		const offRun = host.onRunEvent((ev) => {
			try {
				switch (ev.type) {
					case "run_start": {
						const r = newRun(ev.conversationId, ev.task);
						currentRunId = r.id;
						host.broadcast({ kind: "run_new", run: summaryOf(r) });
						pushNodes(r, [
							{
								kind: "task",
								t: ev.at,
								title: "🧭 任务",
								summary: cut(r.task, SUMMARY_CAP),
								detail: r.task,
							},
						]);
						break;
					}
					case "message": {
						const r = runs.get(currentRunId ?? "");
						if (!r || r.status !== "running") break;
						const m = ev.message;
						if (!m) break;
						if (m.role === "assistant") {
							const nodes = [];
							for (const b of m.content ?? []) {
								if (b?.type === "thinking" && b.thinking?.trim()) {
									r.counts.thinking += 1;
									nodes.push({
										kind: "thinking",
										t: ev.at,
										title: "💭 思考",
										summary: cut(b.thinking.trim(), SUMMARY_CAP),
										detail: cut(b.thinking, DETAIL_CAP),
									});
								} else if (b?.type === "text" && b.text?.trim()) {
									r.counts.texts += 1;
									nodes.push({
										kind: "text",
										t: ev.at,
										title: "💬 回答",
										summary: cut(b.text.trim(), SUMMARY_CAP),
										detail: cut(b.text, DETAIL_CAP),
									});
								}
								// toolCall 块跳过——工具节点由 tool_start/tool_end 成对产生（含参数/耗时）。
							}
							if (nodes.length) pushNodes(r, nodes);
						} else if (m.role === "user") {
							const text = messageText(m).trim() || "(附件/空消息)";
							pushNodes(r, [
								{
									kind: "task",
									t: ev.at,
									title: "🧭 追问",
									summary: cut(text, SUMMARY_CAP),
									detail: cut(text, DETAIL_CAP),
								},
							]);
						} else if (m.role === "compactionSummary" || m.role === "branchSummary") {
							const text = messageText(m).trim();
							if (text) {
								pushNodes(r, [
									{
										kind: "text",
										t: ev.at,
										title: m.role === "compactionSummary" ? "🗜️ 上下文压缩" : "🌿 分支摘要",
										summary: cut(text, SUMMARY_CAP),
										detail: cut(text, DETAIL_CAP),
									},
								]);
							}
						}
						// toolResult / bashExecution / custom：已有 tool_end 节点，不重复。
						break;
					}
					case "tool_start": {
						const r = runs.get(currentRunId ?? "");
						if (!r || r.status !== "running") break;
						r.counts.tools += 1;
						const readonly = READONLY_TOOL_RE.test(String(ev.toolName ?? ""));
						const headline = toolHeadline(ev.toolName, ev.argsText);
						const node = {
							kind: "tool",
							t: ev.at,
							title: `${readonly ? "📖" : "🔧"} ${headline}`,
							headline,
							args: cut(String(ev.argsText ?? "null"), DETAIL_CAP),
							summary: "执行中…",
							detail: cut(String(ev.argsText ?? "null"), DETAIL_CAP),
							tool: ev.toolName,
							running: true,
						};
						pushNodes(r, [node]);
						if (ev.toolCallId) pendingTools.set(ev.toolCallId, { runId: r.id, seq: node.seq });
						break;
					}
					case "tool_end": {
						const pend = ev.toolCallId ? pendingTools.get(ev.toolCallId) : undefined;
						if (ev.toolCallId) pendingTools.delete(ev.toolCallId);
						const r = runs.get(pend?.runId ?? currentRunId ?? "");
						if (!r) break;
						const node = r.nodes.find((n) => n.seq === pend?.seq);
						const secs =
							ev.durationMs !== undefined ? ` · ${(ev.durationMs / 1000).toFixed(1)}s` : "";
						const preview = cut(String(ev.resultText ?? ""), DETAIL_CAP).trim();
						const patch = {
							running: false,
							error: !!ev.isError,
							dur: ev.durationMs,
							summary: cut(
								ev.isError ? `❌ 失败${secs}` : preview ? `${preview.slice(0, 200)}${secs}` : `完成${secs}`,
								SUMMARY_CAP,
							),
							detail: preview || "(无输出)",
						};
						if (node) {
							Object.assign(node, patch);
							// 标题保留开始时的 headline（参数原文已被结果预览覆盖）。
							node.title = `${ev.isError ? "❌" : "✅"} ${node.headline ?? ev.toolName}`;
							host.broadcast({ kind: "node_update", runId: r.id, seq: node.seq, patch: { ...patch, title: node.title } });
						}
						// 文件改动：写类工具成功 → 追加 📝 节点（参数里抠路径）。
						const toolName = String(ev.toolName ?? "");
						if (!ev.isError && WRITE_TOOL_RE.test(toolName) && !READONLY_TOOL_RE.test(toolName)) {
							const files = extractPaths(node?.args);
							if (files.length) {
								r.counts.files += files.length;
								pushNodes(r, [
									{
										kind: "file",
										t: ev.at,
										title: `📝 改动 ${files.length} 个文件`,
										summary: files.slice(0, 3).join("、") + (files.length > 3 ? `（等 ${files.length} 个）` : ""),
										detail: files.join("\n"),
										files,
										tool: toolName,
										dur: ev.durationMs,
									},
								]);
							}
						}
						persist();
						break;
					}
					case "turn_start": {
						const r = runs.get(currentRunId ?? "");
						if (!r || r.status !== "running") break;
						r.turn += 1;
						pushNodes(r, [
							{ kind: "turn", t: ev.at, title: `—— 第 ${r.turn} 轮 ——`, summary: "", detail: "" },
						]);
						break;
					}
					case "turn_end":
						break; // 轮次结束无信息量，不占节点（回放节奏靠 turn_start）。
					case "run_end": {
						const r = runs.get(currentRunId ?? "");
						if (!r) break;
						const stopped = ev.stopReason === "aborted";
						r.status = stopped ? "stopped" : "done";
						r.endedAt = ev.at;
						const secs = ((r.endedAt - r.startedAt) / 1000).toFixed(1);
						pushNodes(r, [
							{
								kind: "result",
								t: ev.at,
								title: stopped ? "⏹️ 已停止" : "🏁 完成",
								summary: `用时 ${secs}s · 💭${r.counts.thinking} 🔧${r.counts.tools} 📝${r.counts.files} 💬${r.counts.texts}`,
								detail:
									`任务：${r.task}\n用时：${secs}s\n` +
									`思考 ${r.counts.thinking} · 工具 ${r.counts.tools} · 文件改动 ${r.counts.files} · 回答 ${r.counts.texts}` +
									(ev.stopReason ? `\nstopReason：${ev.stopReason}` : ""),
							},
						]);
						host.broadcast({ kind: "run_update", run: summaryOf(r) });
						if ([...runs.values()].every((x) => x.status !== "running")) currentRunId = null;
						persist();
						break;
					}
					default:
						break;
				}
			} catch (err) {
				host.log("run event failed:", err?.message ?? err);
			}
		});

		const offMsg = host.onMessage((payload, from) => {
			const msg = payload ?? {};
			try {
				switch (msg.action) {
					case "state":
						pushState(from);
						break;
					case "get": {
						const r = runs.get(String(msg.runId ?? ""));
						if (r && from) host.sendTo(from, { kind: "detail", runId: r.id, nodes: r.nodes });
						break;
					}
					case "clear":
						runs.clear();
						pendingTools.clear();
						currentRunId = null;
						try {
							host.storage.delete("runs");
						} catch {
							/* 无存档 */
						}
						host.broadcast({ kind: "cleared" });
						pushState();
						break;
					default:
						break;
				}
			} catch (err) {
				host.log("message failed:", err?.message ?? err);
			}
		});

		const offAttach = host.onAttach((clientId) => {
			try {
				pushState(clientId);
			} catch (err) {
				host.log("attach push failed:", err?.message ?? err);
			}
		});

		host.log(`activated; restored ${runs.size} runs`);
		return () => {
			offRun();
			offMsg();
			offAttach();
			if (saveTimer) clearTimeout(saveTimer);
		};
	},
};
