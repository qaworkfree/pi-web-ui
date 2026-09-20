/// <reference lib="dom" />
/**
 * 网页元素拾取的数据契约（扩展各模块之间、以及扩展 → pi-webUi 之间的唯一定义）。
 *
 * 设计纪律：
 * - 这份对象是**唯一事实源**：采集器只负责填它，渲染器（to-prompt.ts）只负责读它，
 *   投递层（background）只负责把它送出去。任何一环都不要自己拼 Markdown。
 * - 所有字段除了几个必需项外都是可选的：适配器认不出来就留空，绝不因为拿不到
 *   组件行号或样式就整个拾取失败（降级是常态，见 docs）。
 * - 体积是硬约束：这个对象最终会变成对话上下文，所以「详细度档位」在采集层
 *   就生效（compact / standard / full），而不是渲染时再删。
 */

/** 详细度档位：控制**采集多深**（默认 standard）。 */
export type DetailLevel = "compact" | "standard" | "full";

export const DETAIL_LEVELS: DetailLevel[] = ["compact", "standard", "full"];

export function isDetailLevel(v: unknown): v is DetailLevel {
	return typeof v === "string" && (DETAIL_LEVELS as readonly string[]).includes(v);
}

/**
 * 发送内容的**组成项**（可多选）：一项 = 输出里一类信息。
 *
 * 为什么要有它：档位（compact/standard/full）只能「一起多、一起少」—— 真的使用时往往是
 * 「这次只要源码位置」「这次只要样式」。「上下文预算」应该是可拆的，所以拆成这些开关：
 * 设置页勾选，采集层就只采勾了的（没勾的不采也不渲染，既省体积也省 CPU）。
 */
export const PICK_SECTIONS = ["page", "selector", "locator", "source", "text", "rules", "styles", "skeleton"] as const;

export type PickSection = (typeof PICK_SECTIONS)[number];

export function isPickSection(v: unknown): v is PickSection {
	return typeof v === "string" && (PICK_SECTIONS as readonly string[]).includes(v);
}

export const SECTION_INFO: Record<PickSection, { label: string; hint: string }> = {
	page: { label: chrome.i18n.getMessage("section_page_label"), hint: chrome.i18n.getMessage("section_page_hint") },
	selector: { label: chrome.i18n.getMessage("section_selector_label"), hint: chrome.i18n.getMessage("section_selector_hint") },
	locator: { label: chrome.i18n.getMessage("section_locator_label"), hint: chrome.i18n.getMessage("section_locator_hint") },
	source: { label: chrome.i18n.getMessage("section_source_label"), hint: chrome.i18n.getMessage("section_source_hint") },
	text: { label: chrome.i18n.getMessage("section_text_label"), hint: chrome.i18n.getMessage("section_text_hint") },
	rules: { label: chrome.i18n.getMessage("section_rules_label"), hint: chrome.i18n.getMessage("section_rules_hint") },
	styles: { label: chrome.i18n.getMessage("section_styles_label"), hint: chrome.i18n.getMessage("section_styles_hint") },
	skeleton: { label: chrome.i18n.getMessage("section_skeleton_label"), hint: chrome.i18n.getMessage("section_skeleton_hint") },
};

/** 预设：常用组合（选项页下拉、拾取浮条上的 chip 都是它）。`depth` 决定采集深浅，`sections` 决定要哪几类信息。 */
export interface SectionPreset {
	id: string;
	/** 完整名字（选项页下拉里用）。 */
	label: string;
	/** 短名（拾取浮条上只有一指宽，放不下完整名字）。 */
	short: string;
	hint: string;
	depth: DetailLevel;
	sections: PickSection[];
}

export const SECTION_PRESETS: SectionPreset[] = [
	{
		id: "lean",
		label: chrome.i18n.getMessage("preset_lean_label"),
		short: chrome.i18n.getMessage("preset_lean_short"),
		hint: chrome.i18n.getMessage("preset_lean_hint"),
		depth: "compact",
		sections: ["page", "selector", "source", "text"],
	},
	{
		id: "standard",
		label: chrome.i18n.getMessage("preset_standard_label"),
		short: chrome.i18n.getMessage("preset_standard_short"),
		hint: chrome.i18n.getMessage("preset_standard_hint"),
		depth: "standard",
		sections: ["page", "selector", "source", "text", "rules", "styles", "skeleton"],
	},
	{
		id: "full",
		label: chrome.i18n.getMessage("preset_full_label"),
		short: chrome.i18n.getMessage("preset_full_short"),
		hint: chrome.i18n.getMessage("preset_full_hint"),
		depth: "full",
		sections: [...PICK_SECTIONS],
	},
	{
		id: "source",
		label: chrome.i18n.getMessage("preset_source_label"),
		short: chrome.i18n.getMessage("preset_source_short"),
		hint: chrome.i18n.getMessage("preset_source_hint"),
		depth: "standard",
		sections: ["selector", "source"],
	},
	{
		id: "styles",
		label: chrome.i18n.getMessage("preset_styles_label"),
		short: chrome.i18n.getMessage("preset_styles_short"),
		hint: chrome.i18n.getMessage("preset_styles_hint"),
		depth: "standard",
		sections: ["selector", "rules", "styles"],
	},
	{
		id: "text",
		label: chrome.i18n.getMessage("preset_text_label"),
		short: chrome.i18n.getMessage("preset_text_short"),
		hint: chrome.i18n.getMessage("preset_text_hint"),
		depth: "compact",
		sections: ["selector", "text", "skeleton"],
	},
];

/**
 * 档位 → 内容项。
 *
 * 两个用途：① 兼容老设置（老版本只存了 `detail`，没有 `sections`）；
 * ② 老载荷（没带 sections 的）渲染时按档位推。所以 compact/standard/full 必须各自有对应组合。
 */
export function sectionsForDepth(depth: DetailLevel): PickSection[] {
	const id = depth === "compact" ? "lean" : depth === "full" ? "full" : "standard";
	const preset = SECTION_PRESETS.find((p) => p.id === id);
	return preset ? [...preset.sections] : [...SECTION_PRESETS[1].sections];
}

/** 任意来源的数组/字符串数组 → 干净的 section 列表（去重、只留认识的项）。
 *  空数组（或全都认不出）→ 回落标准组合 —— 一项都不发比多发更让人意外。 */
export function normalizeSections(raw: unknown): PickSection[] {
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
	const out: PickSection[] = [];
	for (const item of list) {
		const v = typeof item === "string" ? item.trim() : item;
		if (isPickSection(v) && !out.includes(v)) out.push(v);
	}
	return out.length > 0 ? out : sectionsForDepth("standard");
}

/** 当前勾选项对应的预设（与任何预设都不一致时返回 undefined → UI 显示「自定义」）。 */
export function presetForSections(sections: PickSection[]): SectionPreset | undefined {
	const key = [...sections].sort().join(",");
	return SECTION_PRESETS.find((p) => [...p.sections].sort().join(",") === key);
}

export const DETAIL_LABELS: Record<DetailLevel, string> = {
	compact: chrome.i18n.getMessage("detail_compact"),
	standard: chrome.i18n.getMessage("detail_standard"),
	full: chrome.i18n.getMessage("detail_full"),
};

export function presetShortLabel(sections: PickSection[]): string {
	return presetForSections(sections)?.short ?? chrome.i18n.getMessage("preset_custom");
}

/**
 * 勾 / 取消勾一项 → 新的组合。
 *
 * 返回值一律按 `PICK_SECTIONS` 排 —— 顺序会进存储、也用来比对「是不是某个预设」，
 * 乱序会让比较结果飘（这条规则只能有一份实现，选项页与浮条都走它）。
 */
export function applySectionToggle(sections: PickSection[], key: PickSection, on: boolean): PickSection[] {
	const set = new Set(sections);
	if (on) set.add(key);
	else set.delete(key);
	return PICK_SECTIONS.filter((k) => set.has(k));
}

/**
 * Alt+1~6 → 第几个预设（0 = 不是这个组合键）。
 *
 * 为什么用 `code` 优先：macOS 上 Alt(Option)+数字会打出 ¡™£ 这类字符，`key` 不再是数字，
 * 但 `code` 仍然是 `Digit1`；反过来的布局（AZERTY）也靠 key 兜底。
 */
export function presetHotkeyIndex(e: {
	key?: string;
	code?: string;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
}): number {
	if (!e.altKey || e.ctrlKey || e.metaKey) return 0;
	const byCode = /^Digit([1-9])$/.exec(e.code ?? "");
	const digit = byCode ? Number(byCode[1]) : /^[1-9]$/.test(e.key ?? "") ? Number(e.key) : 0;
	return digit >= 1 && digit <= SECTION_PRESETS.length ? digit : 0;
}

export function describeSections(sections: PickSection[]): string {
	const names = sections.map((k) => SECTION_INFO[k].label).join(" / ");
	const matched = presetForSections(sections);
	const namesPart = names.length > 0 ? names : chrome.i18n.getMessage("describeSections_empty");
	const presetPart = matched
		? chrome.i18n.getMessage("describeSections_presetPart", [matched.label])
		: chrome.i18n.getMessage("describeSections_custom");
	return chrome.i18n.getMessage("describeSections_template", [namesPart, String(sections.length), presetPart]);
}

/** 源码定位：理想情况下告诉 AI「改哪个文件的哪一行」。 */
export interface SourceRef {
	/** 线索来源（说明可信度：react/vue 的行号比 css 的规则命中更硬）。 */
	kind: "react" | "vue" | "css" | "unknown";
	/** 源文件路径（dev server 的路径，如 /src/components/Card.tsx）。 */
	file?: string;
	line?: number;
	column?: number;
	/** 组件名（react/vue）。 */
	component?: string;
	/** 组件调用链，从被选组件往上（react）：["Card", "SettingsPage"]。 */
	chain?: string[];
}

/** 命中的 CSS 规则（哪条规则命中了这个元素、来自哪个文件的哪一行）。 */
export interface MatchedRule {
	file?: string;
	/** 源文件行号（Vite dev 下可从 <style data-vite-dev-id> 反推，见 capture/styles.ts）。 */
	line?: number;
	selector: string;
	/** 该规则里**真正生效且值得看**的声明，如 "display:flex;gap:8px"。 */
	declarations?: string;
}

export interface ElementRect {
	/** 相对视口的 CSS 像素。 */
	x: number;
	y: number;
	w: number;
	h: number;
	/** 占视口宽/高的百分比 —— 百分比比裸 px 有用（AI 不知道你的屏多宽）。 */
	vwPct: number;
	vhPct: number;
}

export interface ElementSnapshot {
	tag: string;
	id?: string;
	classes: string[];
	/** 首选定位串（短且唯一）。 */
	selector: string;
	/** 完整 XPath（selector 失效或需要精确定位时用）。 */
	xpath?: string;
	/** 人类可读的 DOM 路径（body > div#root > main > section.card）。 */
	domPath?: string;
	/** 开标签的摘要，如 <section class="card card--active">。 */
	tagSummary?: string;
	/** innerText（已按档位截断）。 */
	text?: string;
	/** 结构骨架（子节点折叠成 …）。 */
	htmlSkeleton?: string;
	rect: ElementRect;
	/** 计算样式子集（只放与默认值/继承值不同的，见 capture/styles.ts）。 */
	styles?: Record<string, string>;
	matchedRules?: MatchedRule[];
	source?: SourceRef;
}

export interface PickedElement {
	snapshot: ElementSnapshot;
	/** 用户为这个元素写的一句话（价值极高，原样带给 AI）。 */
	note?: string;
	/**
	 * 元素截图，`data:image/png;base64,…`。
	 * **不进 Markdown 正文**（base64 混在文本里毫无用处还撑爆上下文），
	 * 投递时转成对话附件（走 attachments.imageData 这条已有通路）。
	 */
	shot?: string;
}

export interface PageContext {
	url: string;
	title: string;
	viewport: { w: number; h: number; dpr: number };
	/** 疑似框架（"react" / "vue" / "unknown"），让 AI 知道该按哪套约定找代码。 */
	framework?: string;
	colorScheme?: "light" | "dark";
}

/** 一次拾取的完整载荷（可能含多个元素）。 */
export interface PickPayload {
	/** 幂等 id（每次拾取一个）—— 投递失败重试时不重复注入。 */
	id: string;
	pickedAt: string;
	page: PageContext;
	elements: PickedElement[];
	/** 用户在浮条上写的整体说明（对所有元素生效）。 */
	note?: string;
	detail: DetailLevel;
	/** 本次发送包含哪几类信息（可多选；旧载荷没有这个字段时按 `detail` 推）。 */
	sections?: PickSection[];
}

/** 生成拾取 id（时间戳 + 随机后缀，够用且可读）。 */
export function makePickId(now: number = Date.now(), rand: () => number = Math.random): string {
	return `pick-${now.toString(36)}-${Math.floor(rand() * 1e6)
		.toString(36)
		.padStart(4, "0")}`;
}
