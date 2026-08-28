// ---------------------------------------------------------------------------
// 挂起 wake 订阅扫描（retain conversations with pending subagent wakes）
// ---------------------------------------------------------------------------
// 背景：pi-subagents 扩展在后台异步子代理运行结束后，通过持久化的
// wait-subscription 记录唤醒父会话（pi.sendMessage({ triggerTurn: true })）。
// 记录是独立的小 JSON 文件，存放在共享目录
//   <tmp>/pi-subagents-<scope>/wait-subscriptions/<token>.json
// 其中 scope 与 pi-subagents/src/shared/types.ts 的 resolveTempScopeId() 一致：
//   PI_SUBAGENTS_TEMP_ROOT 环境变量优先，否则 uid-N / user-X / home-X / shared。
// 记录的 sessionId 是会话 .jsonl 文件的绝对路径（AgentSession.sessionFile），
// 记录自带 expiresAt（毫秒时间戳），因此任何基于它的保留策略都是自限的：
// 记录过期后即不再触发保留，内存/运行时开销有硬上界。
//
// fail-open / fail-closed 决策：只有「能完整解析为合法 wait-subscription 记录、
// sessionId 匹配且未过期」的文件才算证据（→ fail-closed 保留运行时）。
// 损坏 JSON、格式不符、外部会话的记录一律视为「无证据」（→ fail-open 允许
// 释放）：这些文件无法给出可信的过期时间，若 fail-closed 会造成运行时永久
// 泄漏；而误释放的最坏后果只是本 bug 已知的行为（重开聊天时唤醒）。
// ---------------------------------------------------------------------------
// Scan for pending "wait subscription" records (pi-subagents). A pending record
// means the conversation's session is owed a wake-up turn by a finished
// background subagent run, so its runtime must be kept alive across project /
// conversation switches. See the Chinese block above for the persistence layout
// and the fail-open vs fail-closed rationale.

import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 与 pi-subagents WaitSubscriptionRecord 的必填字段保持一致（结构校验）。 */
interface WaitSubscriptionRecord {
	version: number;
	token: string;
	sessionId: string;
	targetKind: "async" | "foreground";
	runId: string;
	requestedId: string;
	createdAt: number;
	expiresAt: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 严格结构校验：任何字段缺失/类型不符都视为「外部格式」，不算证据。 */
function parseRecord(value: unknown): WaitSubscriptionRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<WaitSubscriptionRecord>;
	if (record.version !== 1
		|| typeof record.token !== "string"
		|| !UUID_RE.test(record.token)
		|| typeof record.sessionId !== "string"
		|| (record.targetKind !== "async" && record.targetKind !== "foreground")
		|| typeof record.runId !== "string"
		|| typeof record.requestedId !== "string"
		|| typeof record.createdAt !== "number"
		|| typeof record.expiresAt !== "number") return undefined;
	return record as WaitSubscriptionRecord;
}

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

/**
 * 复刻 pi-subagents 的临时目录 scope（resolveTempScopeId）：仅在本机
 * 同 uid / 同用户的场景下运行，保持目录一致即可；不可得时退回 "shared"。
 * Mirror of pi-subagents' temp-scope resolution so both sides agree on the
 * shared wait-subscriptions directory without importing pi-subagents.
 */
export function resolveTempScopeId(env: NodeJS.ProcessEnv = process.env): string {
	if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}
	const homedir = env.USERPROFILE ?? env.HOME;
	if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;
	return "shared";
}

/** wait-subscriptions 目录默认位置（与 pi-subagents 的推导一致）。 */
export function resolveSubscriptionsDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	const root = configured
		? path.resolve(configured)
		: path.join(tmpdir(), `pi-subagents-${resolveTempScopeId(env)}`);
	return path.join(path.dirname(path.join(root, "async-subagent-runs")), "wait-subscriptions");
}

export interface PendingWakeScanOptions {
	/** 默认 resolveSubscriptionsDir()。测试可注入临时目录。 */
	subscriptionsDir?: string;
	/** 会话标识 = pi-subagents 记录中的 sessionId = session .jsonl 绝对路径。 */
	sessionId?: string;
	now?: () => number;
}

/**
 * 磁盘扫描：该会话是否还有未过期的 wake 订阅记录。
 * Does the session still have a non-expired wait-subscription record on disk?
 * 任何 I/O / 解析错误都按「无证据」处理（见文件头 fail-open 说明）。
 */
export function hasPendingWaitSubscription(options: PendingWakeScanOptions): boolean {
	const sessionId = options.sessionId;
	if (!sessionId) return false;
	const now = options.now ?? Date.now;
	const dir = options.subscriptionsDir ?? resolveSubscriptionsDir();
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch {
		return false; // 目录缺失 / 不可读 → 无证据
	}
	for (const file of files) {
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(path.join(dir, file), "utf-8"));
		} catch {
			continue; // 损坏 JSON → 无证据（fail-open）
		}
		const record = parseRecord(value);
		if (!record) continue; // 外部格式 → 无证据
		if (record.sessionId !== sessionId) continue; // 别的会话
		if (record.expiresAt <= now()) continue; // 已过期 → 不再保留
		return true;
	}
	return false;
}

/** displaceActive 决策的输入快照（纯数据，便于单测）。 */
export interface DisplacementDecisionInput {
	reviewing: boolean;
	wizardRunning: boolean;
	streaming: boolean;
	openTerminals: number;
	listed: boolean;
	promptedSinceActive: boolean;
	/** 磁盘扫描结果：存在未过期 wake 订阅。 */
	hasPendingWake: boolean;
}

/**
 * 纯函数版置换决策：true = 保留（不得 dispose），false = 调用方可释放。
 * Pure decision core of displaceActive(): true = retain, false = may dispose.
 * 顺序与 displaceActive 保持一致：review/wizard → streaming → terminals →
 * pending wake → listed+continued（「打开后继续过」的会话也保留）。
 */
export function shouldRetainActive(input: DisplacementDecisionInput): boolean {
	if (input.reviewing || input.wizardRunning) return true;
	if (input.streaming) return true;
	if (input.openTerminals > 0) return true;
	if (input.hasPendingWake) return true;
	if (input.listed && input.promptedSinceActive) return true;
	return false;
}
