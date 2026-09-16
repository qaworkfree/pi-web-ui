/**
 * pi-web-ui 插件 SDK（starter，可直接拷进插件目录 vendor）。
 *
 * 用法（插件 index.mjs）：
 *
 *   import { definePlugin, actionHandler } from "./sdk/index.mjs";
 *
 *   export default definePlugin({
 *     async activate(host) {
 *       host.ui.register({
 *         slot: "composer.actions",
 *         id: "tone",
 *         label: "语气",
 *         kind: "select",
 *         action: "demo:tone",
 *         value: "short",
 *         options: [
 *           { value: "short", label: "简短" },
 *           { value: "full", label: "详细" },
 *         ],
 *       });
 *     },
 *   });
 *
 * 用法（插件 client/entry.mjs）：
 *
 *   import { defineView } from "./sdk/index.mjs";
 *
 *   export default defineView({
 *     mount(el, ctx) {
 *       const off = ctx.onAction("demo:tone", (itemId, value) => {
 *         el.textContent = `语气：${value}`;
 *       });
 *       return () => off();
 *     },
 *   });
 *
 * 零依赖、纯 ESM，直接拷走就能用（renderer 插件的裸 ESM 约束同样满足）。
 */

/** 服务端入口校验 + 原样返回（拼错 activate / 忘写 deactivate 在加载期就报错）。 */
export function definePlugin(def) {
	if (!def || typeof def !== "object") throw new Error("[sdk] definePlugin 需要一个对象");
	if (typeof def.activate !== "function") throw new Error("[sdk] 插件缺 activate(host) 方法");
	if (def.deactivate !== undefined && typeof def.deactivate !== "function") {
		throw new Error("[sdk] deactivate 必须是函数");
	}
	return def;
}

/** 视图入口：mount(el, ctx) 必填，cleanup/其他字段可选；同样做一次形状校验。 */
export function defineView(view) {
	if (!view || typeof view !== "object") throw new Error("[sdk] defineView 需要一个对象");
	if (typeof view.mount !== "function") throw new Error("[sdk] 视图缺 mount(el, ctx) 方法");
	if (view.cleanup !== undefined && typeof view.cleanup !== "function") {
		throw new Error("[sdk] cleanup 必须是函数");
	}
	return view;
}

/** fenced-code 渲染器入口：{ renderers: { lang: (code, ctx) => HTMLElement | null } }。 */
export function defineRenderer(renderers) {
	if (!renderers || typeof renderers !== "object") throw new Error("[sdk] defineRenderer 需要 { lang: fn } 对象");
	for (const [lang, fn] of Object.entries(renderers)) {
		if (typeof fn !== "function") throw new Error(`[sdk] renderer "${lang}" 不是函数`);
	}
	return { renderers };
}

/**
 * onUiAction 分发：一份表代替一串 if（key 是完整 action 名）。
 *   import { actionHandler, onUiAction } from "./sdk/index.mjs";
 *   onUiAction("my-plugin:tone", actionHandler({ "my-plugin:tone": (value) => {...} }));
 */
export function actionHandler(map) {
	if (!map || typeof map !== "object") throw new Error("[sdk] actionHandler 需要 { action: fn } 对象");
	return (itemId, value) => {
		const fn = map[itemId];
		if (typeof fn === "function") return fn(value);
	};
}

/**
 * 浏览器侧动作注册（client/entry.mjs 用）：包一层 window.__piWebUiHost.onUiAction。
 *  select 切选项时 handler 收到 (itemId, value)；宿主桥还没装好时返回空操作。
 */
export function onUiAction(action, handler) {
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.onUiAction === "function") return bridge.onUiAction(action, handler);
	} catch {
		/* 非浏览器/桥未就绪 */
	}
	return () => {};
}

/** 读设置（host.getSettings 薄封装：缺 key 回 fallback，不抛错）。 */
export function getSetting(host, key, fallback) {
	try {
		const v = host?.getSettings?.()?.[key];
		return v === undefined ? fallback : v;
	} catch {
		return fallback;
	}
}

/** 下拉条目构造器（value 必填，label 缺省回落 value）。 */
export function selectOptions(list) {
	return (Array.isArray(list) ? list : [])
		.map((x) => (typeof x === "string" ? { value: x, label: x } : x))
		.filter((x) => x && typeof x.value === "string" && x.value)
		.slice(0, 32);
}
