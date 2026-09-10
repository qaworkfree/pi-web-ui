/**
 * 实测当前平台 `.messages` 滚动容器每侧的 gutter 宽度，写入 CSS 变量
 * `--msgs-gutter`。
 *
 * 背景：`.messages` 是滚动容器，带 `scrollbar-gutter: stable both-edges`，
 * 内容盒在左右各被扣掉一个 gutter（= 滚动条的占位宽度）——只有把这条 gutter
 * 从 padding 里减掉，消息列边缘才能与容器外（无滚动条、无 gutter）的输入框列
 * 对齐（见 styles.css 顶部「中央列几何」）。gutter 宽度无法用 CSS 读取，只能
 * JS 实测。
 *
 * 探针必须与 `.messages` 的滚动条设置逐项一致，否则量到的是另一套滚动条：
 * 全局 `* { scrollbar-width: thin }` / `::-webkit-scrollbar` 只在真实滚动容器
 * 上生效，而 `overflow-y: auto` + `scrollbar-gutter: stable both-edges` 这组合
 * 才会把滚动条变成"占位"型（classic）；用 `overflow-y: scroll` 量到的是叠加层
 * 滚动条（Windows 上实测 0px，与实际 10px 的占位宽度不符，正是历史上"输入框与
 * 消息列差一条 20px"的根因）。
 *
 * 必须在首帧前调用（main.tsx 在 createRoot().render 之前），避免初始布局
 * 用占位值造成一次性闪动。gutter 由 `stable` 保证恒定，与内容/滚动位置无关；
 * CSS px 不随页面 zoom 变化，无需重复测量。
 */
export function installScrollbarGutterVar(): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	const probe = document.createElement("div");
	probe.style.cssText =
		"position:fixed;top:-9999px;left:0;width:100px;height:100px;overflow-y:auto;scrollbar-gutter:stable both-edges;visibility:hidden;pointer-events:none;";
	document.body.appendChild(probe);
	// both-edges 在左右各留一条等宽 gutter → offset-client 是 2 × gutter。
	// 叠加层滚动条平台（macOS 触控）stable 不预留，量到 0，同样正确。
	const gutter = (probe.offsetWidth - probe.clientWidth) / 2;
	document.body.removeChild(probe);
	root.style.setProperty("--msgs-gutter", `${gutter}px`);
}
