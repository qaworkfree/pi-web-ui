/**
 * notes 插件客户端入口（`client/entry.mjs`）—— 两件事：
 *
 *   1. **模块顶层代码**（插件 bundle 被 import 时执行；view:true 的插件在浏览器 attach 后
 *      会被宿主立刻 import，所以刷新页面后浮窗能按上次的状态自己回来）：
 *      建共享数据客户端 → 建全局浮窗 → 等宿主动作桥就绪 → 注册顶栏动作与快捷键 →
 *      订偏好变更（语言/提示音）。
 *   2. **默认导出 mount(el, ctx)**：完整视图（宿主 🧩 tab 里的「📌 笔记」），挂一份
 *      非紧凑布局的同一套界面。
 *
 * 提醒的「到点提示」全部在这里收口（data.mjs 只负责把没送达过的提醒交出来）：
 * 站内通知条 / 桌面通知 / 提示音 / 自动展开浮窗 —— 四个开关都在浮窗设置里，存 localStorage。
 *
 * ⚠ 顶层代码必须**可重入**：`plugins_reload`（装/卸/改插件）会让宿主丢掉旧 bundle 缓存并用
 * `?e=<epoch>` 重新 import —— 同一页里同一个模块会执行第二遍，而**旧那一份的浮窗 DOM、
 * 长轮询、订阅都不会自己消失**。所以顶层把运行时挂在 `window.__piNotesRuntime`，新一轮
 * import 先 `destroy()` 掉上一轮（拆浮窗、停轮询、注销动作/快捷键/订阅），再把新的放上去。
 */
import { createDataClient } from "./data.mjs";
import { createNotesApp } from "./app.mjs";
import { createPanel } from "./panel.mjs";
import { detectLang, makeT } from "./i18n.mjs";
import { ensureStyles } from "./styles.mjs";
import { loadPrefs, onPrefs } from "./prefs.mjs";

ensureStyles();

// ---------------------------------------------------------------- 上一轮实例的收尾
const RUNTIME_KEY = "__piNotesRuntime";
const previous = globalThis[RUNTIME_KEY];
if (previous?.destroy) {
	try {
		previous.destroy();
	} catch (err) {
		console.warn("[notes] 清理上一轮实例失败：", err);
	}
}

// ---------------------------------------------------------------- 语言
function currentLang() {
	const prefs = loadPrefs();
	return prefs.lang === "auto" ? detectLang() : prefs.lang;
}

let lang = currentLang();
let t = makeT(lang);

// ---------------------------------------------------------------- 数据
/** 所有界面共用一个数据客户端（一条长轮询、一份 store 镜像）。 */
const data = createDataClient({
	importMetaUrl: import.meta.url,
	onFired: (fresh) => onReminderFired(fresh),
});
data.start();

// ---------------------------------------------------------------- 浮窗
const panel = createPanel({
	data,
	t,
	onOpenView: () => openView(),
	onNotify: (text) => toast(text),
});

/** 切到插件的完整视图（宿主动作桥 v6+ 的 setView；桥没就绪就退化成展开浮窗）。 */
function openView() {
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (typeof bridge?.setView === "function") {
			bridge.setView("plugin:notes");
			return;
		}
	} catch {
		/* 桥未就绪 */
	}
	panel.show();
}

// ---------------------------------------------------------------- 提示
/** 站内通知条（宿主 API v8 的 notifyAction；带一个「查看」按钮）。 */
async function toast(text, withAction = true) {
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (typeof bridge?.notifyAction !== "function") return;
		const actions = withAction ? [{ id: "open", label: t("notify.view") }] : [];
		const picked = await bridge.notifyAction({ text, actions });
		if (picked === "open") panel.show();
	} catch {
		/* 宿主桥未就绪：界面上的角标仍会更新 */
	}
}

let audioCtx = null;
/** 一声短提示音（WebAudio，无资源文件）。浏览器要求先有用户交互，失败就静默跳过。 */
function beep() {
	try {
		const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
		if (!Ctx) return;
		audioCtx = audioCtx ?? new Ctx();
		if (audioCtx.state === "suspended") void audioCtx.resume();
		const now = audioCtx.currentTime;
		for (const [freq, at] of [
			[880, 0],
			[1320, 0.16],
		]) {
			const osc = audioCtx.createOscillator();
			const gain = audioCtx.createGain();
			osc.frequency.value = freq;
			osc.type = "sine";
			gain.gain.setValueAtTime(0.0001, now + at);
			gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.18);
			osc.connect(gain).connect(audioCtx.destination);
			osc.start(now + at);
			osc.stop(now + at + 0.2);
		}
	} catch {
		/* 被自动播放策略拦下：跳过 */
	}
}

/** 桌面通知（Windows 上刻意**不带 tag**：同 tag 会被静默替换掉，见 AGENTS.md 的坑）。 */
function desktopNotify(title, body) {
	try {
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
		const n = new Notification(title, { body });
		n.onclick = () => {
			try {
				window.focus();
			} catch {
				/* ignore */
			}
			panel.show();
			n.close();
		};
	} catch {
		/* 不支持就算了 */
	}
}

/** 提醒到点/补送：一次把四条通道走完（各自看开关）。 */
function onReminderFired(fresh) {
	const prefs = loadPrefs();
	const list = Array.isArray(fresh) ? fresh : [];
	if (!list.length) return;
	const text =
		list.length === 1
			? `⏰ ${t("notify.title")}：${list[0].text}`
			: `⏰ ${t("notify.many", { n: list.length })}：${list.map((p) => p.text).join("；")}`;
	if (prefs.toast) void toast(text);
	if (prefs.desktop && !document.hasFocus()) desktopNotify(t("notify.title"), list.map((p) => p.text).join("\n"));
	if (prefs.sound) beep();
	// 页面在前台就顺手展开浮窗（前台时桌面通知不会弹，别让提醒只留个角标）；
	// 页面在后台不抢焦点，交给桌面通知。
	if (prefs.autoOpen && !document.hidden) panel.show();
}

// ---------------------------------------------------------------- 宿主动作桥
/** 这一轮注册出去的东西（重载时逐个注销，别让宿主的处理器表越堆越多）。 */
const teardown = [];

/** 等桥就绪（宿主先挂 App 再 import 插件 bundle，但按需加载时可能抢先一步）。 */
function whenBridge(fn, tries = 40) {
	const bridge = globalThis.window?.__piWebUiHost;
	if (bridge && typeof bridge === "object") {
		fn(bridge);
		return;
	}
	if (tries <= 0) return;
	const timer = setTimeout(() => whenBridge(fn, tries - 1), 250);
	teardown.push(() => clearTimeout(timer));
}

whenBridge((bridge) => {
	// 顶栏 📌 按钮（manifest.ui.topbar 声明的 notes:toggle）
	try {
		const off = bridge.onUiAction?.("notes:toggle", () => panel.toggle());
		if (typeof off === "function") teardown.push(off);
	} catch {
		/* ignore */
	}
	// 快捷键：Ctrl/Cmd+Alt+N 唤起浮窗并把光标放进快速输入（避开浏览器占用的 Ctrl+Shift+N）
	try {
		const off = bridge.shortcuts?.register?.("ctrl+alt+n", () => panel.show());
		if (typeof off === "function") teardown.push(off);
	} catch {
		/* ignore */
	}
});

// ---------------------------------------------------------------- 偏好（语言切换等）
/**
 * 语言变化时统一刷新（浮窗重建紧凑 app、完整视图就地重挂）。
 * 只有**真的换语言**才重建界面：偏好里的通知开关也会触发 onPrefs，勾一个复选框
 * 就把正在打字的面板重建一遍（连带丢掉未落盘的输入）是不可接受的。
 */
function applyLang(next) {
	if (next === lang) return;
	lang = next;
	t = makeT(lang);
	panel.refreshLabels(t);
	remountView();
}

/** 就地重挂完整视图（用保存下来的 cleanup，别把 ResizeObserver/订阅漏在那儿）。 */
function remountView() {
	if (!viewApp) return;
	const { container, cleanup } = viewApp;
	viewApp = null;
	try {
		cleanup();
	} catch {
		/* ignore */
	}
	mountInto(container);
}

const offPrefs = onPrefs(() => applyLang(currentLang()));

/** 主应用切语言时会改 documentElement.lang → auto 模式下跟着换文案。 */
let langObserver = null;
try {
	langObserver = new MutationObserver(() => {
		if (loadPrefs().lang !== "auto") return;
		applyLang(detectLang());
	});
	langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
} catch {
	/* 没有 MutationObserver（极老浏览器）就不跟随 */
}

// ---------------------------------------------------------------- 完整视图
let viewApp = null;

function mountInto(container) {
	ensureStyles();
	// `.plugin-view` 是 flex 拉伸的滚动容器，百分比高度在个别布局下不可靠 —— 实测高度写死，
	// 并用 ResizeObserver 跟随。**注意不能写 0**：视图被切走时容器是 display:none，
	// clientHeight 为 0，这时写下去会把高度锁成 0（切回来也回不来）。
	const applyHeight = () => {
		try {
			const h = container.clientHeight;
			if (h > 0) container.style.height = `${h}px`;
		} catch {
			/* ignore */
		}
	};
	applyHeight();
	let ro = null;
	try {
		ro = new ResizeObserver(applyHeight);
		ro.observe(container);
	} catch {
		/* 没有 ResizeObserver 就只在挂载时定一次高 */
	}
	const app = createNotesApp({ root: container, data, t, compact: false });
	const cleanup = () => {
		try {
			ro?.disconnect();
		} catch {
			/* ignore */
		}
		if (viewApp?.app === app) viewApp = null;
		app.destroy();
	};
	viewApp = { app, container, ro, cleanup };
	void data.refresh();
	return cleanup;
}

// 注册这一轮的运行时（下一轮 import 会先调它的 destroy）
globalThis[RUNTIME_KEY] = {
	data,
	panel,
	destroy() {
		for (const off of teardown.splice(0)) {
			try {
				off();
			} catch {
				/* ignore */
			}
		}
		try {
			offPrefs();
		} catch {
			/* ignore */
		}
		try {
			langObserver?.disconnect();
		} catch {
			/* ignore */
		}
		try {
			data.stop();
		} catch {
			/* ignore */
		}
		panel.destroy();
	},
};

export default {
	mount(container) {
		return mountInto(container);
	},
};
