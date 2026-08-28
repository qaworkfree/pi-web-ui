import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	hasPendingWaitSubscription,
	shouldRetainActive,
} from "../../server/wait-subscription-scan.js";

const SESSION_FILE = "/root/.pi/agent/sessions/--proj--/2026-01-01T00-00-00Z_session.jsonl";
const NOW = 1_000_000;
const TOKEN = "0ffbdaf3-c196-4e88-8ae2-0674b2586335";

function record(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		token: TOKEN,
		sessionId: SESSION_FILE,
		targetKind: "async",
		runId: "run-1",
		requestedId: "run-1",
		createdAt: NOW - 1000,
		expiresAt: NOW + 60_000,
		...overrides,
	};
}

const dirs: string[] = [];
function makeDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-web-ui-waitsub-"));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function writeRecord(dir: string, value: unknown, file = `${TOKEN}.json`): void {
	writeFileSync(path.join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
}

describe("hasPendingWaitSubscription", () => {
	it("不存在目录 → 无证据", () => {
		expect(hasPendingWaitSubscription({
			subscriptionsDir: path.join(makeDir(), "missing", "wait-subscriptions"),
			sessionId: SESSION_FILE,
			now: () => NOW,
		})).toBe(false);
	});

	it("空目录 → 无证据", () => {
		expect(hasPendingWaitSubscription({
			subscriptionsDir: makeDir(),
			sessionId: SESSION_FILE,
			now: () => NOW,
		})).toBe(false);
	});

	it("匹配且未过期 → 有挂起订阅（保留会话）", () => {
		const dir = makeDir();
		writeRecord(dir, record());
		expect(hasPendingWaitSubscription({
			subscriptionsDir: dir,
			sessionId: SESSION_FILE,
			now: () => NOW,
		})).toBe(true);
	});

	it("匹配但已过期 → 无挂起订阅", () => {
		const dir = makeDir();
		writeRecord(dir, record({ expiresAt: NOW - 1 }));
		expect(hasPendingWaitSubscription({
			subscriptionsDir: dir,
			sessionId: SESSION_FILE,
			now: () => NOW,
		})).toBe(false);
	});

	it("其它会话的未过期记录 → 无挂起订阅", () => {
		const dir = makeDir();
		writeRecord(dir, record({ sessionId: "/other/session.jsonl" }));
		expect(hasPendingWaitSubscription({
			subscriptionsDir: dir,
			sessionId: SESSION_FILE,
			now: () => NOW,
		})).toBe(false);
	});

	it("损坏 JSON → 视为无证据（fail-open）", () => {
		const dir = makeDir();
		writeRecord(dir, "{ not json !!!", "corrupt.json");
		expect(hasPendingWaitSubscription({
			subscriptionsDir: dir,
			sessionId: SESSION_FILE,
			now: () => NOW,
		})).toBe(false);
	});

	it("格式不符（version 缺失等）→ 视为无证据", () => {
		const dir = makeDir();
		writeRecord(dir, { hello: "world" }, "foreign.json");
		expect(hasPendingWaitSubscription({
			subscriptionsDir: dir,
			sessionId: SESSION_FILE,
			now: () => NOW,
		})).toBe(false);
	});

	it("非 .json 文件被忽略", () => {
		const dir = makeDir();
		writeRecord(dir, record(), "notes.txt");
		expect(hasPendingWaitSubscription({
			subscriptionsDir: dir,
			sessionId: SESSION_FILE,
			now: () => NOW,
		})).toBe(false);
	});
});

describe("shouldRetainActive（置换决策）", () => {
	const base = {
		reviewing: false,
		wizardRunning: false,
		streaming: false,
		openTerminals: 0,
		listed: false,
		promptedSinceActive: false,
		hasPendingWake: false,
	};

	it("默认可置换（返回 null）", () => {
		expect(shouldRetainActive(base)).toBe(false);
	});

	it("reviewing / streaming / 终端打开 → 保留", () => {
		expect(shouldRetainActive({ ...base, reviewing: true })).toBe(true);
		expect(shouldRetainActive({ ...base, wizardRunning: true })).toBe(true);
		expect(shouldRetainActive({ ...base, streaming: true })).toBe(true);
		expect(shouldRetainActive({ ...base, openTerminals: 1 })).toBe(true);
	});

	it("listed + promptedSinceActive → 保留（原有行为）", () => {
		expect(shouldRetainActive({ ...base, listed: true, promptedSinceActive: true })).toBe(true);
	});

	it("有未过期 wake 订阅 → 保留（本修复的核心行为）", () => {
		expect(shouldRetainActive({ ...base, hasPendingWake: true })).toBe(true);
	});
});
