/**
 * builtins/todo.ts — 内置任务标记（复刻 pi-marker-tools）。
 */

import type { ApplyResult, MarkerTool, MarkerOverlay, ParsedToken, MarkerContext } from "../marker.js";

export const TODO_NAMESPACE = "todo";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Todo {
	id: number;
	subject: string;
	status: TodoStatus;
	activeForm?: string;
	blockedBy: number[];
	createdAt: number;
}

export interface TodoState {
	tasks: Todo[];
	nextId: number;
}

export function initTodoState(): TodoState {
	return { tasks: [], nextId: 1 };
}

function findTask(state: TodoState, id: number): Todo | undefined {
	return state.tasks.find((t) => t.id === id && t.status !== "deleted");
}

function parseId(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function formatStatus(s: TodoStatus): string {
	switch (s) {
		case "pending": return "pending";
		case "in_progress": return "in_progress";
		case "completed": return "completed";
		default: return s;
	}
}

export function describeTodos(state: TodoState, includeDeleted = false): string {
	const visible = state.tasks.filter((t) => includeDeleted || t.status !== "deleted");
	if (visible.length === 0) return "[todo] (空)";
	return visible
		.map((t) => {
			const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
			const deps = t.blockedBy.length ? ` ⛓ ${t.blockedBy.join(",")}` : "";
			return `[${formatStatus(t.status)}] #${t.id} ${t.subject}${form}${deps}`;
		})
		.join("\n");
}

export const todoMarker: MarkerTool<TodoState> = {
	name: "todo",
	guidance: [
		"# 内联标记工具（状态类操作请写在回答正文，不要调用工具）",
		"- 标记语法：[[todo:new:<主题>]] 新建；[[todo:set:<id>,completed|in_progress|pending]] 状态；[[todo:remove:<id>]] 删除；[[todo:dep:<id>,blocks=<依赖id,逗号分隔>]] 设依赖。",
		"- 状态变化全部用上面的 [[todo:...]] 内联标记表达，不会中断回答，无需等待返回。",
		"- 想查看/list 当前任务列表时，才用 `markers_list` 工具（读操作走工具）。",
		"- 不要编造不存在的任务 id；id 由 [[todo:new:...]] 分配，首次分配是自增整数。",
	],

	async apply(token: ParsedToken, _ctx: MarkerContext, _state: TodoState): Promise<ApplyResult> {
		const state = _state;
		const op = token.op;
		switch (op) {
			case "new": {
				const subject = token.args[0]?.trim();
				if (!subject) return { applied: false, error: "todo:new 需要一个主题参数 [[todo:new:<主题>]]" };
				const id = state.nextId++;
				state.tasks.push({ id, subject, status: "pending", blockedBy: [], createdAt: Date.now() });
				return { applied: true, feedback: `Created #${id}: ${subject} (pending)` };
			}
			case "set": {
				const id = parseId(token.args[0]);
				if (id === null) return { applied: false, error: `todo:set 的 id 无效: "${token.args[0] ?? ""}"` };
				const status = token.args[1]?.trim() as TodoStatus | undefined;
				if (!status || !(status === "pending" || status === "in_progress" || status === "completed")) {
					return { applied: false, error: `todo:set 状态无效: "${status ?? ""}"，应为 pending|in_progress|completed` };
				}
				const task = findTask(state, id);
				if (!task) return { applied: false, error: `todo:set 任务 #${id} 不存在` };
				const activeForm = token.kwargs["activeForm"];
				const from = task.status;
				if (status === "pending" && from === "completed") {
					return { applied: false, error: `任务 #${id} 已完成，不能置回 pending` };
				}
				if (status === "in_progress" && from === "completed") {
					return { applied: false, error: `任务 #${id} 已完成，不能重新进行中` };
				}
				task.status = status;
				if (status === "in_progress" && activeForm) task.activeForm = activeForm;
				const change = from !== status ? ` (${from} → ${status})` : "";
				return { applied: true, feedback: `Updated #${id}${change}` };
			}
			case "remove": {
				const id = parseId(token.args[0]);
				if (id === null) return { applied: false, error: `todo:remove 的 id 无效: "${token.args[0] ?? ""}"` };
				const task = findTask(state, id);
				if (!task) return { applied: false, error: `todo:remove 任务 #${id} 不存在` };
				task.status = "deleted";
				return { applied: true, feedback: `Deleted #${id}: ${task.subject}` };
			}
			case "dep": {
				const id = parseId(token.args[0]);
				if (id === null) return { applied: false, error: `todo:dep 的 id 无效: "${token.args[0] ?? ""}"` };
				const task = findTask(state, id);
				if (!task) return { applied: false, error: `todo:dep 任务 #${id} 不存在` };
				const depRaw = token.kwargs["blocks"] ?? token.args[1] ?? "";
				const deps = depRaw
					.split(",")
					.map((x) => parseId(x.trim()))
					.filter((x): x is number => x !== null);
				const bad = deps.filter((d) => d === id || !findTask(state, d));
				if (bad.length) return { applied: false, error: `todo:dep 检测到非法依赖 ${bad.join(",")}（不存在或自环）` };
				task.blockedBy = deps;
				return { applied: true, feedback: `#${id} blocks: ${deps.length ? deps.join(",") : "(none)"}` };
			}
			default:
				return { applied: false, error: `todo 未知操作: ${op}` };
		}
	},

	overlay(state: TodoState): MarkerOverlay | undefined {
		if (!state || state.tasks.length === 0) return undefined;
		const visible = state.tasks.filter((t) => t.status !== "deleted");
		if (visible.length === 0) return undefined;
		const done = visible.filter((t) => t.status === "completed").length;
		const lines = visible.map((t) => {
			const mark = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○";
			const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
			return ` ${mark} #${t.id} ${t.subject}${form}`;
		});
		return { tool: "todo", lines: [`${done}/${visible.length} done`, ...lines] };
	},

	init: initTodoState,
};
