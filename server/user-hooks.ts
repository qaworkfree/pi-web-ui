import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import type { UiUserHook, UserHookEvent } from "./protocol.js";

/**
 * 用户钩子（Hooks）：在代理生命周期的固定事件点运行用户配置的 shell 命令
 * （对标 Claude Code 的 hooks）。配置存 `<dataDir>/user-hooks.json`，设置页
 * 「Hooks」区编辑；对 AI 不可见，模型既看不到钩子列表也不能改它。
 *
 * 事件与语义：
 * - `pre-tool`   工具执行前。blocking 钩子退出码 2 = 拒绝本次调用（stderr/stdout
 *                第一行作为给模型的理由）；其他非零码 = 记一条 warning 但放行
 *                （fail-open：坏钩子不能瘫痪代理）。非 blocking = 观察（并行、不等）。
 * - `post-tool`  工具执行后，观察（结果预览只给前 2KB）。
 * - `prompt-submit` 用户消息发出前。blocking 退出码 2 = 拦下这条消息（通知用户）。
 * - `turn-end`   一轮生成结束（usage/耗时已知）。观察。
 *
 * 安全口径：命令以服务进程身份运行（与终端面板同级权限），不经过文件系统策略
 * ——这是用户自己写的自动化，和在终端里敲命令同责。离线模式下继承服务进程的
 * 黑洞代理环境（PI_WEB_OFFLINE 时由调用方传入 env）。
 */

export const USER_HOOK_EVENTS: readonly UserHookEvent[] = ["pre-tool", "post-tool", "prompt-submit", "turn-end"];

const TIMEOUT_DEFAULT_MS = 10_000;
const TIMEOUT_MIN_MS = 1_000;
const TIMEOUT_MAX_MS = 120_000;
const OUTPUT_CAP = 64 * 1024;

export function normalizeUserHook(raw: unknown): UiUserHook | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const event = typeof r.event === "string" && (USER_HOOK_EVENTS as string[]).includes(r.event) ? r.event : null;
	const command = typeof r.command === "string" ? r.command.trim() : "";
	if (!event || !command) return null;
	const tools = Array.isArray(r.tools)
		? r.tools.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim())
		: [];
	const timeoutRaw = typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) ? r.timeoutMs : TIMEOUT_DEFAULT_MS;
	return {
		id: typeof r.id === "string" && r.id.trim() ? r.id.trim() : `hook-${Math.random().toString(36).slice(2, 10)}`,
		enabled: r.enabled !== false,
		event: event as UserHookEvent,
		tools,
		command,
		timeoutMs: Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.round(timeoutRaw))),
		blocking: r.blocking === true,
		...(typeof r.label === "string" && r.label.trim() ? { label: r.label.trim() } : {}),
	};
}

export function normalizeUserHooks(raw: unknown): UiUserHook[] {
	if (!Array.isArray(raw)) return [];
	const out: UiUserHook[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		const hook = normalizeUserHook(item);
		if (!hook || seen.has(hook.id)) continue;
		seen.add(hook.id);
		out.push(hook);
	}
	return out.slice(0, 50);
}

/** 匹配某事件（pre/post 还要匹配工具名；tools 空 或 含 "*" = 全部工具）。 */
export function matchUserHooks(hooks: UiUserHook[], event: UserHookEvent, toolName?: string): UiUserHook[] {
	return hooks.filter((h) => {
		if (!h.enabled || h.event !== event) return false;
		if (event !== "pre-tool" && event !== "post-tool") return true;
		if (!h.tools || h.tools.length === 0 || h.tools.includes("*")) return true;
		return toolName !== undefined && h.tools.some((t) => t.toLowerCase() === toolName.toLowerCase());
	});
}

export interface UserHookRunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** 运行一个钩子命令：shell 执行、JSON 负载从 stdin 进、输出各截 64KB、超时杀。 */
export function runUserHook(
	hook: UiUserHook,
	payload: Record<string, unknown>,
	opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<UserHookRunResult> {
	return new Promise((resolvePromise) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({ code, stdout: stdout.slice(0, OUTPUT_CAP), stderr: stderr.slice(0, OUTPUT_CAP), timedOut });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(hook.command, {
				shell: true,
				cwd: opts.cwd,
				env: { ...(opts.env ?? process.env), PI_HOOK_EVENT: hook.event, PI_HOOK_ID: hook.id },
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			stderr = String((error as Error).message ?? error);
			finish(null);
			return;
		}
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			finish(null);
		}, hook.timeoutMs ?? TIMEOUT_DEFAULT_MS);
		child.stdout?.on("data", (chunk) => (stdout += chunk));
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => {
			stderr += String(error.message ?? error);
			finish(null);
		});
		child.on("close", (code) => finish(code));
		try {
			child.stdin?.write(JSON.stringify(payload));
			child.stdin?.end();
		} catch {
			/* 钩子可以不读 stdin；EPIPE 不算失败 */
		}
	});
}

/** blocking 钩子的拒绝理由：stderr 优先，其次 stdout，都空给默认文案；只取首行、截 300 字。 */
export function hookDenialReason(result: UserHookRunResult): string {
	const text = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/, 1)[0] ?? "";
	return text.slice(0, 300);
}

/** Persistent store for `<dataDir>/user-hooks.json` (mtime-cached like approval rules). */
export class UserHooksStore {
	private readonly filePath: string;
	private cache: UiUserHook[] | null = null;
	private cachedMtime = 0;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "user-hooks.json");
	}

	list(): UiUserHook[] {
		try {
			if (!existsSync(this.filePath)) return (this.cache = []);
			const mtime = statSync(this.filePath).mtimeMs;
			if (this.cache && mtime === this.cachedMtime) return this.cache;
			this.cache = normalizeUserHooks(JSON.parse(readFileSync(this.filePath, "utf8")));
			this.cachedMtime = mtime;
			return this.cache;
		} catch {
			return this.cache ?? [];
		}
	}

	save(hooks: unknown): UiUserHook[] {
		const normalized = normalizeUserHooks(hooks);
		writeJsonAtomicSync(this.filePath, normalized);
		this.cache = normalized;
		try {
			this.cachedMtime = statSync(this.filePath).mtimeMs;
		} catch {
			this.cachedMtime = 0;
		}
		return normalized;
	}
}
