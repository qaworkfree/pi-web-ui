/**
 * builtins/rename.ts — 重命名当前对话标记。
 *
 * 需求：加个重命名当前对话 marker。
 *
 * 语法（唯一写法）：
 *   [[conv:rename:<新标题>]]        重命名当前对话
 *
 * 持久化：通过宿主回调直接改对话标题（内存 + 磁盘 transcript session_info），
 *         不需要额外状态。
 */

import type { ApplyResult, MarkerTool, ParsedToken, MarkerContext } from "../marker.js";

export const RENAME_NAMESPACE = "conv";

function extractTitle(token: ParsedToken): string {
	// args[0] 是主标题；kwargs 兼容 text/name/title
	const fromArgs = token.args.join(" ").trim();
	const fromKw = (token.kwargs["text"] ?? token.kwargs["name"] ?? token.kwargs["title"] ?? "").trim();
	if (fromArgs && fromKw) return `${fromArgs} ${fromKw}`.trim();
	return fromArgs || fromKw;
}

export const renameMarker: MarkerTool<never> = {
	name: "conv",
	guidance: ["- 重命名当前对话：[[conv:rename:<新标题>]]（在了解了用户需求后尽早重命名对话）"],

	async apply(token: ParsedToken, ctx: MarkerContext): Promise<ApplyResult> {
		if (token.op !== "rename") {
			return { applied: false, error: `conv 未知操作: ${token.op}（当前仅支持 conv:rename）` };
		}
		const title = extractTitle(token);
		if (!title) return { applied: false, error: "conv:rename 需要一个标题参数 [[conv:rename:<新标题>]]" };
		if (title.length > 80) return { applied: false, error: "标题过长（最多 80 字）" };
		if (!ctx.renameConversation) return { applied: false, error: "当前环境不支持重命名" };
		try {
			ctx.renameConversation(title);
			ctx.notify(`已重命名为：${title}`, "info", `Renamed to: ${title}`);
			return { applied: true, feedback: `renamed to "${title}"` };
		} catch (e) {
			return { applied: false, error: `重命名失败: ${(e as Error).message ?? String(e)}` };
		}
	},
	overlay: undefined,
	init: () => undefined as never,
};
