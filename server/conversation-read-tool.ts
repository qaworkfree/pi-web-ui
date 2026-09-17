// ---------------------------------------------------------------------------
// conversation-read-tool.ts — 让 AI（含子代理）读取别的对话
// ---------------------------------------------------------------------------
// 背景：用户在左栏有「运行的对话」（含子代理）与「历史对话」，也常想让 AI
// 「结合另一个对话的内容回答」。此前 AI 既不知道别的对话的 id，也没有干净的
// 读取通道（只能用 read/bash 翻转录 jsonl，既难找路径又难解析）。
//
// 本工具提供只读双通道：
//   action=list  → 运行中对话（本标签页的全部 conversation，含子代理）+
//                  历史会话转录（scope=current 仅当前项目，all 跨全部项目）；
//   action=read  → 按 id 读运行中对话的实时消息（含未落盘的），或按 path 读
//                  历史转录（只接受会话列表里的路径，任意文件不给读）。
//
// 转录文本走 transcriptText/formatTranscript 纯函数（有单测）；文件解析走
// parseTranscriptLines（jsonl 逐行，坏行跳过）。输出按条数 + 字符数双封顶，
// 长对话分多次 offset 翻页。跨标签页的实时运行读不到——以落盘历史为准，
// description 里会告诉模型这一点。
//
// 双语约定（issue #91）：definition 走 bilingual(en, zh) 内联双语；per-call
// 返回文本按 lang 取 pick(lang, zh, en, key, vars)，缺表回落英文内联。
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bilingual, pick, type ServerLang } from "./i18n.js";
import type { AgentMessage } from "./serialize.js";

/** 运行中对话的列表行（ClientSession.convs 的轻量视图）。 */
export interface ConversationListEntry {
	id: string;
	title: string;
	cwd: string;
	messageCount: number;
	isStreaming: boolean;
	isSubagent: boolean;
	parentId?: string;
}

/** 历史会话的列表行（SessionInfo 的轻量视图）。 */
export interface HistorySessionEntry {
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	cwd: string;
}

/** 转录消息的最小结构（实时 AgentMessage 与转录文件解析结果的公共面）。 */
export interface TranscriptInputMessage {
	role: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	summary?: string;
	details?: unknown;
	timestamp?: number;
}

/** 由 ClientSession 实现的数据宿主（读它自己的 conversation 体系 + 会话目录）。 */
export interface ConversationReadHost {
	listRunningConversations(): ConversationListEntry[];
	readRunningConversation(
		id: string,
	): { title: string; cwd: string; isSubagent: boolean; messages: TranscriptInputMessage[] } | undefined;
	listHistorySessions(scope: "current" | "all", cwd: string): Promise<HistorySessionEntry[]>;
	/** path 不在会话列表里（越界/手写脏路径）→ undefined，工具转报错。 */
	readHistorySession(path: string): Promise<
		| {
				title: string;
				cwd: string;
				sessionPath: string;
				messages: TranscriptInputMessage[];
		  }
		| undefined
	>;
}

/** AgentMessage → 转录最小结构（角色原样保留，内容不动，格式化延后）。 */
export function toTranscriptInput(m: AgentMessage): TranscriptInputMessage {
	const role = (m as { role?: unknown }).role;
	const r = typeof role === "string" ? role : "unknown";
	const base: TranscriptInputMessage = { role: r };
	const anyM = m as unknown as Record<string, unknown>;
	if (typeof anyM.content !== "undefined") base.content = anyM.content;
	if (typeof anyM.toolName === "string") base.toolName = anyM.toolName;
	if (typeof anyM.isError === "boolean") base.isError = anyM.isError;
	if (typeof anyM.command === "string") base.command = anyM.command;
	if (typeof anyM.output === "string") base.output = anyM.output;
	if (typeof anyM.summary === "string") base.summary = anyM.summary;
	if (typeof anyM.details !== "undefined") base.details = anyM.details;
	if (typeof anyM.timestamp === "number") base.timestamp = anyM.timestamp;
	return base;
}

/** 内容块 → 纯文本：text 拼接；图片占位；具名块（toolCall 等）留名；其余占位。 */
function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: unknown; text?: unknown; name?: unknown };
		if (blk.type === "text" && typeof blk.text === "string") {
			parts.push(blk.text);
		} else if (blk.type === "image") {
			parts.push("[image]");
		} else if (typeof blk.name === "string" && blk.name) {
			parts.push(`[tool call: ${blk.name}]`);
		} else {
			parts.push("[…]");
		}
	}
	return parts.join("\n");
}

/** 附件 aside 的短名（details.name/path），非附件返回空。 */
function attachmentName(details: unknown): string {
	if (!details || typeof details !== "object") return "";
	const d = details as { name?: unknown; path?: unknown };
	if (typeof d.name === "string" && d.name) return d.name;
	if (typeof d.path === "string" && d.path) return d.path.split(/[\\/]/).pop() ?? d.path;
	return "";
}

/** 单条转录消息 → 可读文本行（角色标签 + 内容，不截断，截断由 format 统一做）。 */
export function transcriptText(m: TranscriptInputMessage): string {
	switch (m.role) {
		case "bashExecution":
			return `[bash $ ${m.command ?? ""}]\n${m.output ?? ""}`;
		case "branchSummary":
			return `[branch summary]\n${m.summary ?? ""}`;
		case "compactionSummary":
			return `[compaction summary]\n${m.summary ?? ""}`;
		case "toolResult": {
			const head = `[tool result${m.toolName ? ` (${m.toolName})` : ""}${m.isError ? " ERROR" : ""}]`;
			const body = textOfContent(m.content);
			return body ? `${head}\n${body}` : head;
		}
		case "custom": {
			const name = attachmentName(m.details);
			const body = textOfContent(m.content);
			const head = name ? `[attachment: ${name}]` : "[note]";
			return body ? `${head}\n${body}` : head;
		}
		case "user":
		case "assistant":
			return textOfContent(m.content);
		default: {
			const body = textOfContent(m.content);
			return body ? `[${m.role}]\n${body}` : `[${m.role}]`;
		}
	}
}

/** 角色标签（列表行里的序号前缀用）。 */
function roleLabel(m: TranscriptInputMessage): string {
	if (m.role === "toolResult") return `tool result${m.toolName ? ` (${m.toolName})` : ""}`;
	return m.role;
}

function trunc(s: string, cap: number): string {
	return s.length <= cap ? s : `${s.slice(0, cap)}\n… [truncated]`;
}

export interface FormatTranscriptOpts {
	/** 起始下标（0-based， chronological）。缺省 0。 */
	offset?: number;
	/** 最多取多少条。缺省 50，上限 200。 */
	limit?: number;
	/** 单条消息字符封顶。缺省 2000。 */
	perMsgCap?: number;
	/** 全文字符封顶。缺省 20000。 */
	maxChars?: number;
}

export interface FormattedTranscript {
	text: string;
	total: number;
	from: number;
	to: number;
	/** 还有后文没给（to < total 或撞了 maxChars）。 */
	truncated: boolean;
}

/** 转录分页格式化：序号形如 [12/135 user]，尾部带翻页提示位（调用方拼 header）。 */
export function formatTranscript(messages: TranscriptInputMessage[], opts?: FormatTranscriptOpts): FormattedTranscript {
	const total = messages.length;
	const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
	const limit = Math.min(200, Math.max(1, Math.floor(opts?.limit ?? 50)));
	const perMsgCap = Math.max(100, Math.floor(opts?.perMsgCap ?? 2000));
	const maxChars = Math.min(60000, Math.max(1000, Math.floor(opts?.maxChars ?? 20000)));
	const from = Math.min(offset, total);
	const to = Math.min(from + limit, total);
	const lines: string[] = [];
	for (let i = from; i < to; i++) {
		const m = messages[i];
		lines.push(`[${i + 1}/${total} ${roleLabel(m)}]\n${trunc(transcriptText(m).trim(), perMsgCap)}`);
	}
	let text = lines.join("\n\n");
	let truncated = to < total;
	if (text.length > maxChars) {
		text = `${text.slice(0, maxChars)}\n… [truncated]`;
		truncated = true;
	}
	if (total === 0) text = "";
	return { text, total, from, to, truncated };
}

/**
 * 转录 jsonl → 转录消息（message 条目取 message；compaction/branch_summary
 * 取 summary；坏行跳过）。纯函数：文件读取由宿主做，单测直接喂文本。
 */
export function parseTranscriptLines(text: string): TranscriptInputMessage[] {
	const out: TranscriptInputMessage[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let e: {
			type?: unknown;
			message?: {
				role?: unknown;
				content?: unknown;
				toolName?: unknown;
				isError?: unknown;
				details?: unknown;
				timestamp?: unknown;
			};
			summary?: unknown;
		};
		try {
			e = JSON.parse(t);
		} catch {
			continue;
		}
		if (e?.type === "message" && e.message && typeof e.message.role === "string") {
			const msg = e.message;
			const m: TranscriptInputMessage = { role: msg.role as string };
			if (typeof msg.content !== "undefined") m.content = msg.content;
			if (typeof msg.toolName === "string") m.toolName = msg.toolName;
			if (typeof msg.isError === "boolean") m.isError = msg.isError;
			if (typeof msg.details !== "undefined") m.details = msg.details;
			if (typeof msg.timestamp === "number") m.timestamp = msg.timestamp;
			out.push(m);
			continue;
		}
		if ((e?.type === "compaction" || e?.type === "branch_summary") && typeof e.summary === "string") {
			out.push({
				role: e.type === "compaction" ? "compactionSummary" : "branchSummary",
				summary: e.summary,
			});
		}
	}
	return out;
}

/** 大小写不敏感子串（空 query 全匹配）。 */
function matchesHay(hay: string, q: string): boolean {
	return q === "" || hay.toLowerCase().includes(q);
}

export function filterRunning(list: ConversationListEntry[], query: string): ConversationListEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return list;
	return list.filter((c) => matchesHay(c.id, q) || matchesHay(c.title, q) || matchesHay(c.cwd, q));
}

export function filterHistory(list: HistorySessionEntry[], query: string): HistorySessionEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return list;
	return list.filter((s) => matchesHay(s.path, q) || matchesHay(s.name ?? "", q) || matchesHay(s.firstMessage, q));
}

/** 短 id/路径展示（列表行里路径太长只留尾部）。 */
export function shortPath(p: string, keep = 48): string {
	return p.length <= keep ? p : `…${p.slice(p.length - keep)}`;
}

export function makeConversationReadTool(host: ConversationReadHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	return defineTool({
		name: "conversation_read",
		label: "Read another conversation",
		description: bilingual(
			'Read ANOTHER conversation\'s messages: a running conversation of this client (including subagents — use its conversation id like "c3", see action=list) or a persisted history session transcript (use its file path). ' +
				'Use it when the user references another chat (a quoted conversation, a pasted conversation id, or "see the other chat about X"). ' +
				"action=list shows running conversations (id, title, project, streaming state) plus history sessions; action=read returns one transcript paged (offset/limit, capped chars — re-call with a larger offset for the rest). " +
				"Only sessions from the session list can be read (arbitrary file paths are refused). " +
				"Live runs in OTHER browser tabs are not readable here — they appear in history once persisted.",
			"读取**另一个对话**的消息：本客户端的运行中对话（含子代理——用 action=list 查 conversation id，如 c3）或已落盘的历史会话转录（用它的文件 path）。" +
				"用户引用了别的对话（引用 chip、粘过来的对话 id、“看看之前那个关于 X 的对话”）时用它。" +
				"action=list 列运行中对话（id、标题、项目、是否进行中）与历史会话；action=read 取某一份转录（offset/limit 翻页、字符封顶——后文用更大的 offset 再取）。" +
				"只能读会话列表里的转录（任意文件路径会被拒绝）。" +
				"其他浏览器标签页里的实时运行在这里读不到——它们落盘后会出现在历史里。",
		),
		promptSnippet: "read another conversation's messages (running incl. subagents, or history transcript)",
		parameters: Type.Object({
			action: Type.Optional(
				Type.String({
					description:
						'list = show running conversations + history sessions; read = fetch one transcript. Default "list".',
				}),
			),
			scope: Type.Optional(
				Type.String({
					description: 'list only: "current" = this project, "all" = every project. Default "all".',
				}),
			),
			query: Type.Optional(
				Type.String({ description: "list only: case-insensitive filter over id/title/path/first message." }),
			),
			id: Type.Optional(
				Type.String({ description: 'read only: running conversation id (e.g. "c3"), from action=list.' }),
			),
			path: Type.Optional(Type.String({ description: "read only: history session file path, from action=list." })),
			offset: Type.Optional(Type.Number({ description: "read only: first message index (0-based). Default 0." })),
			limit: Type.Optional(Type.Number({ description: "read only: max messages to return (1-200). Default 50." })),
			maxChars: Type.Optional(Type.Number({ description: "read only: max characters (1000-60000). Default 20000." })),
		}),
		execute: async (_id, p, _signal, _onUpdate, ctx) => {
			const action = (p.action ?? "list").trim().toLowerCase();
			if (action === "list") {
				const scopeRaw = (p.scope ?? "all").trim().toLowerCase();
				if (scopeRaw !== "current" && scopeRaw !== "all") {
					return text(
						pick(
							getLang(),
							`scope 非法：${p.scope}（只能是 current 或 all）。`,
							`Invalid scope: ${p.scope} (must be "current" or "all").`,
							"convread.list.bad.scope",
							{ "p.scope": p.scope },
						),
					);
				}
				const scope = scopeRaw as "current" | "all";
				const query = typeof p.query === "string" ? p.query : "";
				const running = filterRunning(host.listRunningConversations(), query);
				const history = filterHistory(await host.listHistorySessions(scope, ctx.cwd), query);
				const L = getLang();
				const runLines = running.map(
					(c) =>
						`- ${c.id} · ${c.title} · ${c.isSubagent ? (L === "zh" ? "子代理" : "subagent") : L === "zh" ? "对话" : "chat"}${
							c.isStreaming ? (L === "zh" ? "（进行中）" : " (streaming)") : ""
						} · ${c.messageCount} msgs · ${c.cwd}`,
				);
				const histLines = history.map(
					(s) =>
						`- ${shortPath(s.path)} · ${s.name || s.firstMessage || (L === "zh" ? "（空对话）" : "(empty)")}${
							s.messageCount ? ` · ${s.messageCount} msgs` : ""
						}`,
				);
				const head =
					L === "zh"
						? `运行中对话（${running.length}）+ 历史会话（${history.length}，scope=${scope}）：`
						: `Running conversations (${running.length}) + history sessions (${history.length}, scope=${scope}):`;
				const runHead = L === "zh" ? "【运行中】" : "[running]";
				const histHead = L === "zh" ? "【历史】" : "[history]";
				const empty = L === "zh" ? "（无）" : "(none)";
				const tail =
					L === "zh"
						? `读某一份：conversation_read(action="read", id="c…") 或 conversation_read(action="read", path="…")，长转录用 offset/limit 翻页。`
						: `To read one: conversation_read(action="read", id="c…") or conversation_read(action="read", path="…"); page long transcripts with offset/limit.`;
				return text(
					`${head}\n${runHead}\n${runLines.join("\n") || empty}\n${histHead}\n${histLines.join("\n") || empty}\n${tail}`,
					{ running, history, scope },
				);
			}
			if (action === "read") {
				const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : undefined;
				const path = typeof p.path === "string" && p.path.trim() ? p.path.trim() : undefined;
				if ((id && path) || (!id && !path)) {
					return text(
						pick(
							getLang(),
							`action=read 需要且只需要 id 或 path 其中之一（id 读运行中对话，path 读历史转录）。`,
							`action=read needs exactly one of id or path (id = running conversation, path = history transcript).`,
							"convread.read.bad.args",
						),
					);
				}
				const opts = { offset: p.offset, limit: p.limit, maxChars: p.maxChars };
				if (id) {
					const found = host.readRunningConversation(id);
					if (!found) {
						return text(
							pick(
								getLang(),
								`未找到运行中对话 ${id}（可能已关闭；用 action=list 看当前列表，落盘的可按 path 读历史）。`,
								`Running conversation ${id} not found (may be closed; use action=list for the current list, or read persisted ones by path).`,
								"convread.read.id.not.found",
								{ id },
							),
						);
					}
					const f = formatTranscript(found.messages, opts);
					const L = getLang();
					const head =
						L === "zh"
							? `对话「${found.title}」（id=${id}${found.isSubagent ? "，子代理" : ""}，${found.cwd}，共 ${f.total} 条，${f.from + 1}-${f.to}）：`
							: `Conversation "${found.title}" (id=${id}${found.isSubagent ? ", subagent" : ""}, ${found.cwd}, ${f.total} messages, showing ${f.from + 1}-${f.to}):`;
					const more =
						f.truncated && f.total > 0
							? L === "zh"
								? `\n…还有后文（offset=${f.to} 再取）。`
								: `\n…more below (re-call with offset=${f.to}).`
							: "";
					const emptyNote = f.total === 0 ? (L === "zh" ? "（该对话暂无消息）" : "(no messages yet)") : "";
					return text(`${head}\n${f.text || emptyNote}${more}`, {
						id,
						title: found.title,
						total: f.total,
						from: f.from,
						to: f.to,
					});
				}
				const found = await host.readHistorySession(path!);
				if (!found) {
					return text(
						pick(
							getLang(),
							`读不到历史会话 ${path}（不在会话列表里：只能读 action=list 列出的转录路径）。`,
							`Cannot read history session ${path} (not in the session list: only transcripts from action=list can be read).`,
							"convread.read.path.not.found",
							{ path },
						),
					);
				}
				const f = formatTranscript(found.messages, opts);
				const L = getLang();
				const head =
					L === "zh"
						? `历史会话「${found.title || found.sessionPath}」（${found.cwd}，共 ${f.total} 条，${f.from + 1}-${f.to}）：`
						: `History session "${found.title || found.sessionPath}" (${found.cwd}, ${f.total} messages, showing ${f.from + 1}-${f.to}):`;
				const more =
					f.truncated && f.total > 0
						? L === "zh"
							? `\n…还有后文（offset=${f.to} 再取）。`
							: `\n…more below (re-call with offset=${f.to}).`
						: "";
				const emptyNote = f.total === 0 ? (L === "zh" ? "（该会话暂无消息）" : "(no messages yet)") : "";
				return text(`${head}\n${f.text || emptyNote}${more}`, {
					path: found.sessionPath,
					title: found.title,
					total: f.total,
					from: f.from,
					to: f.to,
				});
			}
			return text(
				pick(
					getLang(),
					`action 非法：${p.action}（只能是 list 或 read）。`,
					`Invalid action: ${p.action} (must be "list" or "read").`,
					"convread.bad.action",
					{ "p.action": p.action },
				),
			);
		},
	});
}
