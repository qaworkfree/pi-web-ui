// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { TopBar } from "../../web/src/components/TopBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ChatState } from "../../web/src/use-chat.js";

/**
 * 顶栏左右面板按钮（`.panel-toggle`，手机端 ≤768px 才显示）的**视图门禁**。
 *
 * 为什么断言「不在非 chat 视图渲染」而不是「点了没反应」：
 *   抽屉节点 `.panel-drawer` 是 chat 视图面板树（`.view-pane`）的子节点，非 chat
 *   视图整棵 `display:none`（App.tsx），所以按钮在那些视图里点了只会拉出一层
 *   `.drawer-backdrop` 遮罩、抽屉永远不出现 —— 而按钮本身是顶栏直接子项，仍在
 *   屏幕上（手机端还会和终端面板自己的 `.term-side-toggle` 并排成两个 ☰）。
 *   用户可见的现象是「切到终端页左上角多出两个三横线按钮，顶栏那个无效」，
 *   这个组件级断言就是它的最小回归面。
 *
 * 零 token / 零端口：真 jsdom + 真 React 渲染，只断言 DOM 结构与回调。
 */

// TopBar 只读 chat 的这几个字段（其余快照流内容用不到），stub 到「已连接」即可。
const chatStub = {
	status: "open",
	ready: true,
	state: null,
	activeConversationId: "",
	terminals: [],
	bgServers: [],
	tabs: undefined,
	update: null,
	updatesAll: [],
} as unknown as ChatState;

let root: Root | null = null;

/**
 * 一条宿主内置顶栏条目（issue #146 的 slot 结构子集）：只用到 id / source / label / kind。
 * `uiPrimary` 不给 = 「没接线」，此时宿主入口一律可见（见 TopBar 的 hostOn）；给了就按它判可见。
 */
const hostEntry = (id: string, hidden = false) => ({
	id,
	source: "host" as const,
	slot: "topbar.primary" as const,
	label: id,
	kind: "action" as const,
	order: 100,
	hidden,
	userOverrides: [],
	arrangedBy: [],
});

function mount(
	view: "chat" | "terminal" | "git" | "plugin:demo-mailbox",
	uiPrimary?: unknown[],
	uiOverflow?: unknown[],
) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const opened: ("left" | "right")[] = [];
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(TopBar, {
					chat: chatStub,
					...(uiPrimary ? { uiPrimary } : {}),
					...(uiOverflow ? { uiOverflow } : {}),
					terminal: {
						create: () => {},
						close: () => {},
						register: () => () => {},
						restart: () => {},
						select: () => {},
					},
					view,
					plugins: [],
					onViewChange: () => {},
					onOpenPanel: (side: "left" | "right") => opened.push(side),
					onOpenSettings: () => {},
					onOpenBgTasks: () => {},
					onOpenGlobalSearch: () => {},
					sound: { enabled: false, volume: 0.5, kinds: {} },
					onSoundChange: () => {},
					onSoundPreview: () => {},
					themes: [],
					theme: null,
					onThemeChange: () => {},
				} as unknown as Parameters<typeof TopBar>[0]),
			),
		);
	});
	return { container, opened };
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("TopBar 面板抽屉按钮的视图门禁", () => {
	it("chat 视图：保留左右两个按钮，点击按对应侧打开抽屉", () => {
		const { container, opened } = mount("chat");
		const toggles = Array.from(container.querySelectorAll<HTMLButtonElement>("button.panel-toggle"));
		expect(toggles.length).toBe(2);
		expect(toggles[0].title).toBeTruthy(); // 文案随语言包变，只验证「有可访问名称」
		expect(toggles[1].title).not.toBe(toggles[0].title);
		act(() => toggles[0].click());
		act(() => toggles[1].click());
		expect(opened).toEqual(["left", "right"]);
	});

	// 这三个视图里抽屉节点都是 display:none 的（App.tsx 的 .view-pane.hidden）→
	// 按钮点不出抽屉，只会留下遮罩；终端视图还额外有自己面板的 ☰，就是用户看到的两个。
	for (const view of ["terminal", "git", "plugin:demo-mailbox"] as const) {
		it(`${view} 视图：不渲染面板抽屉按钮`, () => {
			const { container, opened } = mount(view);
			expect(container.querySelectorAll("button.panel-toggle").length).toBe(0);
			expect(opened).toEqual([]);
		});
	}

	// 布局页/插件 arrange 把内置入口藏了 → 主栏按钮消失，但它必须能从「⋯」溢出菜单点回来
	// （issue #146：隐藏 ≠ 失去入口；否则用户一旦手滑藏了就会得到一个点了没反应的按钮，
	//  这与设置面板「界面布局」页的承诺不符）。
	it("隐藏 host:files / host:history 时不渲染对应按钮", () => {
		const { container, opened } = mount("chat", [hostEntry("host:chat", false)]);
		expect(container.querySelectorAll("button.panel-toggle").length).toBe(0);
		expect(opened).toEqual([]);
	});

	it("隐藏的内置入口出现在溢出菜单里，点它仍能打开对应面板", () => {
		const { container, opened } = mount(
			"chat",
			[hostEntry("host:chat")],
			[hostEntry("host:files"), hostEntry("host:history")],
		);
		const more = container.querySelector<HTMLButtonElement>(".plugin-topbar-more > button");
		expect(more).toBeTruthy();
		act(() => more!.click());
		// issue #162：菜单 portal 到 document.body（fixed），不在 container 里 —— 查全局。
		// 且不再挂在会被 .view-switch/.topbar-actions 裁剪的容器下。
		const menu = document.querySelector(".plugin-topbar-menu");
		expect(menu?.parentElement).toBe(document.body);
		expect(menu?.classList.contains("portal")).toBe(true);
		const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".plugin-topbar-menu [role=menuitem]"));
		expect(items.length).toBe(2);
		act(() => items[0]!.click());
		expect(opened).toEqual(["right"]);
		// 菜单点完即关；再开一次点另一条 → 打开左栏
		act(() => more!.click());
		const items2 = Array.from(document.querySelectorAll<HTMLButtonElement>(".plugin-topbar-menu [role=menuitem]"));
		act(() => items2[1]!.click());
		expect(opened).toEqual(["right", "left"]);
	});
});
