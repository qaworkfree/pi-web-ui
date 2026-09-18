/**
 * 顶栏「放不下的自动进 ⋯」的核心纯函数（方案 A：手机端与桌面端渲染同一份 slot 数据）。
 *
 * 为什么是纯函数：
 *   - 顶栏宽度是**实测**出来的（ResizeObserver + offsetWidth），逻辑放进组件里就没法
 *     穷举断言；这里只吃「每个条目的实测宽度 + 容器可用宽度」，同输入必同输出。
 *   - 桌面/手机只有宽度不同，没有第二套数据 —— 「设置里看到的顺序 == 界面上看到的顺序」
 *     这个 issue #146 的不变量在手机上同样成立（旧版手机端是 CSS `display:none` 硬藏
 *     一整组 + 另一个硬编码的「⋯」面板，那条不变量是断的，见本文件的历史注释于 TopBar）。
 *
 * 丢弃策略：按**视觉顺序从尾部**丢（右先于左）。理由：
 *   - 尾部丢弃不重排任何剩余条目 → 关掉宽度一档再打开，条目位置不会跳来跳去（单调）。
 *   - 用户明确要「全部入口都在」：被丢的条目不是消失，而是落到同一个「⋯」菜单里，
 *     并且能一键点回。想改变谁先被丢，就在设置面板「界面布局」里把它往前调 ——
 *     顺序是用户可控的，这里不需要第二套优先级概念。
 */

export interface TopbarFitItem {
	/** 条目的全局 id（`host:*` / `<pluginId>:*`）。 */
	id: string;
	/** 实测宽度（`offsetWidth`）。0 = 当前断点下被 CSS 藏起来的条目（见下）。 */
	width: number;
}

/**
 * 算出要退进溢出菜单的条目 id 集合（空集 = 全部放得下）。
 *
 * @param items     视觉顺序的条目（start 段 → center 段 → end 段），必须与界面上一致。
 * @param available 流容器的可用宽度（`clientWidth`）。
 * @param gap       条目间距（容器的 `columnGap`，px）。
 * @param reserve   「⋯」按钮自身宽度 + 它与前一个条目之间的间距（px）。
 */
export function fitTopbar(items: TopbarFitItem[], available: number, gap: number, reserve: number): Set<string> {
	const drop = new Set<string>();
	// 没测到宽度（未挂载 / jsdom / display:none 的容器）时**全保留**：
	// 拿不到数据就把顶栏清空是最糟的降级（与 TopBar 里 uiPrimary 缺省时的口径一致）。
	if (!Number.isFinite(available) || available <= 0) return drop;
	const budget = Math.max(0, available - Math.max(0, reserve));
	let acc = 0;
	// 一旦某个条目放不下，它后面的条目（有宽度的）一律跟着进溢出：
	// 跳过式的「抽空隙塞」会让剩余条目在宽度变化时反复换位。
	let overflowing = false;
	for (const it of items) {
		// 该断点下没有宽度 = CSS 藏起来的条目（桌面端的 ☰/📁 抽屉开关等）：
		// 既不占宽度、也不该被丢进溢出菜单（那会给落地页一个点了没用的入口）。
		if (!(it.width > 0)) continue;
		const need = it.width + gap;
		if (overflowing || acc + need > budget) {
			overflowing = true;
			drop.add(it.id);
			continue;
		}
		acc += need;
	}
	return drop;
}
