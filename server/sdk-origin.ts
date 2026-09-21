/**
 * sdk-origin — 本进程实际加载的是哪一份 pi SDK，以及被它遮蔽的副本（issue #260）。
 *
 * 背景：npm 全局安装会把依赖**嵌在** `<npm root -g>/pi-web-ui/node_modules/`（不 hoist，
 * 实测），而 Node 的解析顺序是「嵌套优先于祖先」。于是用户按更新面板/README 的提示
 * `npm i -g @earendil-works/pi-coding-agent@latest` 升级全局那份时，服务实际加载的
 * 仍是自带副本 —— 表现为「升了 0.86.1，横幅和 /api/health 还显示 0.85.1」。
 *
 * 这里把「所有能被解析到的副本」按 Node 的顺序算出来（[0] = 生效的那份），
 * 让启动横幅与健康检查说实话，而不是让用户去猜。
 *
 * 纯函数 + 零副作用，便于单测（见 tests/unit/sdk-origin.test.ts）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@earendil-works/pi-coding-agent";

export interface SdkCopy {
	/** package.json 的绝对路径。 */
	path: string;
	/** 该副本的版本号。 */
	version: string;
}

/** 从某个文件出发，逐级向上查找 `<dir>/node_modules/<pkg>/package.json`。
 *  `fromFile` 收 URL（`import.meta.url`）或普通文件路径（便于单测）。 */
export function sdkCopies(fromFile: string = import.meta.url): SdkCopy[] {
	const out: SdkCopy[] = [];
	let dir = dirname(fromFile.startsWith("file:") ? fileURLToPath(fromFile) : fromFile);
	for (;;) {
		const pj = join(dir, "node_modules", PKG, "package.json");
		if (existsSync(pj)) {
			try {
				const version = JSON.parse(readFileSync(pj, "utf8")).version;
				if (typeof version === "string" && version) out.push({ path: pj, version });
			} catch {
				// 坏 JSON：跳过这一份，不影响其它候选（best-effort，同 process-utils 的口径）
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return out;
}

/** 点分版本号比较（够用即可：只比数字段，缺位当 0）。 */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
		const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
		if (na !== nb) return na < nb ? -1 : 1;
	}
	return 0;
}

/**
 * 启动横幅要打印的一行（不含前缀），以及是否需要提示「你升的不是服务在用的那份」。
 * `effective` 为空时（没找到副本）返回空串，调用方照旧只打印版本号。
 */
export function sdkOriginNote(copies: SdkCopy[], effectiveVersion: string): string | null {
	const shadowed = copies.slice(1);
	const newer = shadowed.filter((c) => compareVersions(c.version, effectiveVersion) > 0);
	if (newer.length === 0) return null;
	return `a newer pi SDK is installed elsewhere (${newer.map((c) => `v${c.version}`).join(", ")}) but pi-web-ui runs its own bundled copy (v${effectiveVersion}).`;
}
