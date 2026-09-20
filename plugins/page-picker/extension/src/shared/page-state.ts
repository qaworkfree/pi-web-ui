/// <reference lib="dom" />
/**
 * 「这一页能不能让 AI 操作」的状态查询契约 + 浮条文案（纯逻辑，可单测）。
 *
 * 为什么需要它：AI 授权的两个入口原来**只挂在拾取确认条上** —— 也就是必须先点一个元素才能
 * 看见「让 AI 操作本页…」。现在拾取态底部就常驻一条细条，于是它得知道「本页授权了没」：
 * 已授权就别再催着去设置页，总开关关着也得当场说清（否则用户点了按钮、模型还是不动，
 * 只会怀疑整个功能坏了）。
 *
 * 纪律：**不装**。查询没回来（undefined）与查询失败（null）是两种状态，前者说「正在查」、
 * 后者说「查不到」，绝不糊成一句「未授权」—— 那会把「worker 挂了」误导成「你得去授权」。
 */

/** background 回给内容脚本的本页授权状态。 */
export interface PageState {
	/** 本页归一后的 origin；拿不到就是空串（不是 http/https 页面）。 */
	origin: string;
	/** 本页在「AI 操作页面」授权表里吗。 */
	authorized: boolean;
	/** 授权表里记的标题（有就用它）。 */
	title?: string;
	/** 「允许 AI 操作页面」总开关 —— 关着时即使授权了也调不动。 */
	aiControl: boolean;
}

/** 底部细条上那块状态 + 主按钮文案（UI 只负责画）。 */
export interface GrantView {
	/** 状态行短文案（细条很短，别写长句）。 */
	status: string;
	/** 状态颜色档。 */
	kind: "ok" | "warn" | "err" | "info";
	/** 主按钮文案。 */
	label: string;
	/** 已经办妥了（授权成功）：按钮不再是「催你去点」的样子。 */
	done: boolean;
	/** 长解释（挂 title/aria 上，鼠标停一下能看到前因后果）。 */
	hint: string;
}

export function grantView(state: PageState | null | undefined): GrantView {
	if (state === undefined) {
		return {
			status: chrome.i18n.getMessage("grant_checking_status"),
			kind: "info",
			label: chrome.i18n.getMessage("grant_checking_label"),
			done: false,
			hint: chrome.i18n.getMessage("grant_checking_hint"),
		};
	}
	if (state === null) {
		return {
			status: chrome.i18n.getMessage("grant_null_status"),
			kind: "info",
			label: chrome.i18n.getMessage("grant_null_label"),
			done: false,
			hint: chrome.i18n.getMessage("grant_null_hint"),
		};
	}
	if (!state.origin) {
		return {
			status: chrome.i18n.getMessage("grant_notHttp_status"),
			kind: "warn",
			label: chrome.i18n.getMessage("grant_notHttp_label"),
			done: false,
			hint: chrome.i18n.getMessage("grant_notHttp_hint"),
		};
	}
	if (!state.authorized) {
		return {
			status: chrome.i18n.getMessage("grant_unauthorized_status"),
			kind: "warn",
			label: chrome.i18n.getMessage("grant_unauthorized_label"),
			done: false,
			hint: chrome.i18n.getMessage("grant_unauthorized_hint", [state.origin]),
		};
	}
	const named = state.title && state.title !== state.origin ? `「${state.title}」` : state.origin;
	if (!state.aiControl) {
		return {
			status: chrome.i18n.getMessage("grant_authorizedSwitchOff_status"),
			kind: "warn",
			label: chrome.i18n.getMessage("grant_authorizedSwitchOff_label"),
			done: true,
			hint: chrome.i18n.getMessage("grant_authorizedSwitchOff_hint", [named]),
		};
	}
	return {
		status: chrome.i18n.getMessage("grant_authorizedOn_status"),
		kind: "ok",
		label: chrome.i18n.getMessage("grant_authorizedOn_label"),
		done: true,
		hint: chrome.i18n.getMessage("grant_authorizedOn_hint", [named]),
	};
}
