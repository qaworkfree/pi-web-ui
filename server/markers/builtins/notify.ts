/**
 * builtins/notify.ts — 纯提醒标记。
 */

import type { ApplyResult, MarkerTool, ParsedToken, MarkerContext } from "../marker.js";

export const notifyMarker: MarkerTool<never> = {
	name: "notify",
	guidance: [
		"- [[notify:<级别>:<内容>]] 仅向用户显示一个非打断性提醒，不会进入正文。级别为 info|warning|success|error。",
	],
	async apply(token: ParsedToken, ctx: MarkerContext): Promise<ApplyResult> {
		const level = token.op || token.kwargs["level"] || "info";
		const text = token.kwargs["text"] || token.args.join(" ") || "";
		if (!text) return { applied: false, error: "notify 需要内容" };
		const safe = (level === "warning" || level === "error" ? level : "info") as "info" | "warning" | "error";
		ctx.notify(text, safe);
		return { applied: true, feedback: "notified" };
	},
	overlay: undefined,
	init: () => undefined as never,
};
