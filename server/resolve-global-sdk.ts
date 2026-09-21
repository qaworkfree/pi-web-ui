/**
 * resolve-global-sdk — 可选的「优先用全局/祖先那份 pi SDK」解析钩子（issue #260）。
 *
 * 背景：pi-web-ui 依赖 `@earendil-works/pi-coding-agent`，而 npm 全局安装会把依赖
 * **嵌在** `<npm root -g>/pi-web-ui/node_modules/`（不 hoist，实测），Node 又「嵌套优先于
 * 祖先」—— 于是用户 `npm i -g @earendil-works/pi-coding-agent@latest` 改的是全局那份，
 * 服务加载的仍是自带那份，表现为「升了 0.86.1，横幅和 /api/health 还显示 0.85.1」。
 *
 * 本模块把解析顺序反过来，但**只在显式开启时**：
 *
 *   PI_WEB_SDK=global   → 祖先链上存在一份版本**更新**的 SDK 时，把裸标识符重定向到它；
 *                         否则原样不动（同版本也不折腾 —— 没意义）。
 *   （缺省 / 其它值）    → 什么都不做，用自带副本。
 *
 * 为什么默认关：服务运行的 SDK 版本会变成「用户机器上装了什么」，同一个 pi-web-ui 版本在
 * 不同机器上跑不同 SDK，报 bug 时无法复现；自带副本可复现、且是 CI 覆盖的那一份。
 *
 * 为什么只做「必须更新」这一道门：仓库没有 semver 依赖，手写完整范围解析容易出错，
 * 「祖先那份比自带那份新」是保守且够用的判据（旧的 / 同版本的都不采用）。
 *
 * 安全约定：整个注册流程包在 try/catch 里，任何异常都退回默认解析 —— 这个模块**绝不允许**
 * 让服务起不来。它必须在任何 SDK 静态 import **之前**被加载（`--import <本文件>`，
 * 或前台启动时在 import 服务入口之前先 import 它）。
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { compareVersions, sdkCopies, type SdkCopy } from "./sdk-origin.js";

const PKG = "@earendil-works/pi-coding-agent";

/**
 * 该用哪一份对外解析（纯函数，便于单测）。
 * `copies` 按 Node 的解析顺序（[0] = 自带的、实际会被用到的），返回 null = 保持默认。
 */
export function pickGlobalSdk(copies: SdkCopy[], mode: string | undefined): SdkCopy | null {
	if ((mode ?? "bundled").trim().toLowerCase() !== "global") return null;
	const bundled = copies[0];
	// 只考虑祖先链上的副本，且必须是**更新**的（旧的或同版本都不折腾）。
	return copies.slice(1).find((c) => !bundled || compareVersions(c.version, bundled.version) > 0) ?? null;
}

/** 注册钩子；返回实际选中的副本（null = 没启用 / 没找到可用的）。 */
export function registerGlobalSdkPreference(mode = process.env.PI_WEB_SDK, fromFile = import.meta.url): SdkCopy | null {
	try {
		const copies = sdkCopies(fromFile);
		const chosen = pickGlobalSdk(copies, mode);
		if (!chosen) return null;
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier !== PKG) return nextResolve(specifier, context);
				// 以目标副本的 package.json 为父重新解析：Node 从那里往上找，
				// 第一个命中的就是它自己 —— 等价于「从那个包内部 import 自己」。
				try {
					return nextResolve(specifier, { ...context, parentURL: pathToFileURL(chosen.path).href });
				} catch {
					return nextResolve(specifier, context);
				}
			},
		});
		return chosen;
	} catch {
		// 钩子注册失败（Node 太老 / 环境怪异）→ 静默退回默认解析，绝不影响启动。
		return null;
	}
}

// ---- 副作用：被 `--import` 加载时立刻生效 --------------------------------
const used = registerGlobalSdkPreference();
if (used) {
	console.log(`[pi-web-ui] PI_WEB_SDK=global → using the pi SDK at ${used.path} (v${used.version})`);
}
