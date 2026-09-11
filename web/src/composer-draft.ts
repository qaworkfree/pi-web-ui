/**
 * 输入框草稿合并 —— 把「撤回的排队/插队消息」放回输入框时的纯逻辑（便于单测）。
 *
 * 规则：输入框为空（或只有空白）→ 直接填入；否则**追加到末尾**（单个换行分隔），
 * 保留用户正在打的内容，绝不覆盖。
 */

/**
 * @param current  输入框当前内容
 * @param recalled 被撤回的消息原文（空字符串视为无内容，原样返回 current）
 */
export function mergeRecalledDraft(current: string, recalled: string): string {
	if (!recalled) return current;
	if (!current.trim()) return recalled;
	return `${current.replace(/\s+$/, "")}\n${recalled}`;
}
