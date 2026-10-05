import type { UiApprovalHistoryEntry } from "./protocol.js";

export const APPROVAL_HISTORY_ENTRY_TYPE = "workfree/approval-history";
const LIMIT = 100;
const statuses = new Set(["pending", "approved", "denied", "edited", "cancelled", "interrupted"]);

/** Reuse the session journal: in-memory conversations stay in memory. No params/secrets. */
export function appendApprovalHistory(manager: unknown, entry: UiApprovalHistoryEntry): void {
	const journal = manager as { appendCustomEntry?: (type: string, data: unknown) => void } | undefined;
	journal?.appendCustomEntry?.(APPROVAL_HISTORY_ENTRY_TYPE, {
		id: entry.id,
		toolName: entry.toolName.slice(0, 128),
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		status: entry.status,
		...(entry.scope ? { scope: entry.scope } : {}),
	});
}

/** Latest state per request; stale pending entries after restart are interrupted. */
export function readApprovalHistory(manager: unknown, activeIds: ReadonlySet<string>): UiApprovalHistoryEntry[] {
	const journal = manager as { getEntries?: () => unknown[] } | undefined;
	const rows = journal?.getEntries?.() ?? [];
	const entries = new Map<string, UiApprovalHistoryEntry>();
	for (const raw of rows) {
		const row = raw as { customType?: string; data?: Partial<UiApprovalHistoryEntry> } | undefined;
		const entry = row?.data;
		if (
			row?.customType !== APPROVAL_HISTORY_ENTRY_TYPE ||
			!entry ||
			typeof entry.id !== "string" ||
			typeof entry.toolName !== "string" ||
			typeof entry.createdAt !== "number" ||
			!Number.isFinite(entry.createdAt) ||
			typeof entry.updatedAt !== "number" ||
			!Number.isFinite(entry.updatedAt) ||
			!statuses.has(entry.status ?? "")
		)
			continue;
		entries.set(entry.id, {
			id: entry.id,
			toolName: entry.toolName.slice(0, 128),
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
			status:
				entry.status === "pending" && !activeIds.has(entry.id)
					? "interrupted"
					: (entry.status as UiApprovalHistoryEntry["status"]),
			...(["once", "category", "all"].includes(entry.scope ?? "") ? { scope: entry.scope } : {}),
		});
	}
	return [...entries.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, LIMIT);
}
