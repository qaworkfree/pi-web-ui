import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	UserHooksStore,
	hookDenialReason,
	matchUserHooks,
	normalizeUserHooks,
	runUserHook,
} from "../../server/user-hooks.js";
import type { UiUserHook } from "../../server/protocol.js";

const temp = mkdtempSync(join(tmpdir(), "user-hooks-test-"));
afterAll(() => {
	// Windows：被超时杀掉的子进程可能仍短暂持有 cwd 句柄 —— 清理尽力而为。
	try {
		rmSync(temp, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

const hook = (over: Partial<UiUserHook>): UiUserHook => ({
	id: "h1",
	enabled: true,
	event: "pre-tool",
	tools: [],
	command: "node -v",
	timeoutMs: 10_000,
	blocking: true,
	...over,
});

describe("normalizeUserHooks", () => {
	it("drops invalid entries, dedupes ids, clamps timeout, caps the list", () => {
		const out = normalizeUserHooks([
			{ event: "pre-tool", command: "echo hi", timeoutMs: 1 },
			{ event: "pre-tool", command: "echo hi", timeoutMs: 999_999, id: "big" },
			{ event: "nope", command: "echo hi" },
			{ event: "pre-tool", command: "   " },
			null,
			{ event: "turn-end", command: "echo done", id: "dup" },
			{ event: "turn-end", command: "echo done2", id: "dup" },
		]);
		expect(out).toHaveLength(3);
		expect(out[0].timeoutMs).toBe(1_000);
		expect(out.find((h) => h.id === "big")?.timeoutMs).toBe(120_000);
		expect(out.filter((h) => h.id === "dup")).toHaveLength(1);
		expect(normalizeUserHooks("junk")).toEqual([]);
	});
});

describe("matchUserHooks", () => {
	it("matches event + tool list (empty or * = all; case-insensitive)", () => {
		const hooks = [
			hook({ id: "all" }),
			hook({ id: "bash-only", tools: ["Bash"] }),
			hook({ id: "star", tools: ["*"] }),
			hook({ id: "off", enabled: false }),
			hook({ id: "other-event", event: "post-tool" }),
		];
		const ids = matchUserHooks(hooks, "pre-tool", "bash").map((h) => h.id);
		expect(ids).toEqual(["all", "bash-only", "star"]);
		expect(matchUserHooks(hooks, "post-tool", "write").map((h) => h.id)).toEqual(["other-event"]);
		// 非工具事件不按工具过滤
		expect(
			matchUserHooks([hook({ id: "t", event: "turn-end", tools: ["bash"] })], "turn-end").map((h) => h.id),
		).toEqual(["t"]);
	});
});

describe("runUserHook", () => {
	it("pipes the JSON payload via stdin and captures stdout", async () => {
		const script = join(temp, "echo-tool.cjs");
		writeFileSync(
			script,
			"let b='';process.stdin.on('data',(d)=>b+=d).on('end',()=>{process.stdout.write(JSON.parse(b).tool);});",
		);
		const result = await runUserHook(hook({ command: `node "${script}"` }), { tool: "bash" }, { cwd: temp });
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("bash");
		expect(result.timedOut).toBe(false);
	});

	it("exit code 2 surfaces as a denial with the stderr reason", async () => {
		const script = join(temp, "deny.cjs");
		writeFileSync(script, "console.error('not in business hours');process.exit(2);");
		const result = await runUserHook(hook({ command: `node "${script}"` }), {}, { cwd: temp });
		expect(result.code).toBe(2);
		expect(hookDenialReason(result)).toBe("not in business hours");
	});

	it("kills the command at timeoutMs and reports timedOut", async () => {
		const script = join(temp, "hang.cjs");
		writeFileSync(script, "setTimeout(()=>{}, 60000);");
		const result = await runUserHook(hook({ command: `node "${script}"`, timeoutMs: 1_000 }), {}, { cwd: temp });
		expect(result.timedOut).toBe(true);
	}, 15_000);
});

describe("UserHooksStore", () => {
	it("persists normalized hooks and reloads them", () => {
		const store = new UserHooksStore(temp);
		expect(store.list()).toEqual([]);
		const saved = store.save([{ event: "turn-end", command: "echo done", timeoutMs: 5 }]);
		expect(saved).toHaveLength(1);
		expect(saved[0].timeoutMs).toBe(1_000);
		const fresh = new UserHooksStore(temp);
		expect(fresh.list()).toEqual(saved);
	});
});
