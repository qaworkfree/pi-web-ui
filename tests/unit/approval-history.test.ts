import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ClientSession } from "../../server/agent-service.js";
import { vi } from "vitest";
import { appendApprovalHistory, readApprovalHistory } from "../../server/approval-history.js";
import type { UiApprovalHistoryEntry } from "../../server/protocol.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const entry: UiApprovalHistoryEntry = {
	id: "request-1",
	toolName: "bash",
	createdAt: 1,
	updatedAt: 2,
	status: "pending",
};
describe("conversation approval journal", () => {
	it("records the real approval bridge, automatic allowances and cancellation in the owning conversation", async () => {
		const first = SessionManager.inMemory();
		const second = SessionManager.inMemory();
		const cs = Object.assign(Object.create(ClientSession.prototype) as object, {
			disposed: false,
			activeId: "c1",
			approvalSeq: 0,
			pendingApprovals: new Map(),
			convs: new Map([
				["c1", { id: "c1", session: { sessionManager: first }, title: "First" }],
				["c2", { id: "c2", session: { sessionManager: second }, title: "Second" }],
			]),
			settingsSvc: { current: { toolApprovalEnabled: true }, push: vi.fn() },
			emit: vi.fn(),
			flushSnapshot: vi.fn(),
		}) as unknown as ClientSession;
		const approved = cs.askApproval("call-1", "bash", { apiKey: "private-key" }, undefined, undefined, "c1");
		const covered = cs.askApproval("call-2", "write", {}, undefined, undefined, "c1");
		const cancelled = cs.askApproval("call-3", "edit", {}, undefined, undefined, "c2");
		const pending = readApprovalHistory(
			first,
			new Set(
				first
					.getEntries()
					.filter((row) => row.type === "custom")
					.map((row) => (row as { data: UiApprovalHistoryEntry }).data.id),
			),
		);
		expect(pending).toHaveLength(2);
		expect(pending.every((row) => row.status === "pending")).toBe(true);
		const id = pending.find((row) => row.toolName === "bash")!.id;
		expect(cs.resolveToolApproval(id, "approve", undefined, undefined, "all")).toBe(true);
		expect((await approved).decision).toBe("approve");
		expect((await covered).decision).toBe("approve");
		expect(readApprovalHistory(first, new Set()).every((row) => row.status === "approved")).toBe(true);
		cs.cancelPendingApprovals();
		expect((await cancelled).decision).toBe("deny");
		expect(readApprovalHistory(second, new Set())[0].status).toBe("cancelled");
		expect(JSON.stringify(first.getEntries())).not.toContain("private-key");
	});
	it("replays latest state without copying parameters or secrets", () => {
		const manager = SessionManager.inMemory();
		appendApprovalHistory(manager, { ...entry, params: { apiKey: "private-key" } } as UiApprovalHistoryEntry);
		expect(readApprovalHistory(manager, new Set([entry.id]))).toEqual([entry]);
		appendApprovalHistory(manager, { ...entry, status: "approved", updatedAt: 3, scope: "once" });
		expect(readApprovalHistory(manager, new Set())).toEqual([
			{ ...entry, status: "approved", updatedAt: 3, scope: "once" },
		]);
		expect(JSON.stringify(manager.getEntries())).not.toContain("private-key");
		expect(SessionManager.inMemory().getEntries()).toEqual([]);
	});
	it("marks pending approvals interrupted after restart instead of showing an actionable phantom", () => {
		const manager = SessionManager.inMemory();
		appendApprovalHistory(manager, entry);
		expect(readApprovalHistory(manager, new Set())[0].status).toBe("interrupted");
	});
	it("persists with the existing session and isolates other conversations", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-web-approval-journal-"));
		dirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "openai-completions",
			provider: "local",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		appendApprovalHistory(manager, { ...entry, status: "denied" });
		const file = manager.getSessionFile();
		expect(file).toBeDefined();
		expect(readFileSync(file!, "utf8")).toContain("workfree/approval-history");
		expect(readApprovalHistory(SessionManager.open(file!), new Set())[0].status).toBe("denied");
		expect(readApprovalHistory(SessionManager.inMemory(), new Set())).toEqual([]);
	});
	it("bounds the activity list and ignores invalid journal entries", () => {
		const manager = SessionManager.inMemory();
		for (let i = 0; i < 110; i++)
			appendApprovalHistory(manager, { ...entry, id: String(i), createdAt: i, status: "cancelled" });
		manager.appendCustomEntry("workfree/approval-history", { id: "bad", status: "grant-everything" });
		expect(readApprovalHistory(manager, new Set())).toHaveLength(100);
		expect(readApprovalHistory(manager, new Set())[0].id).toBe("109");
	});
});
