import { useT } from "../i18n";
import type { UiApprovalHistoryEntry } from "../types";

const statusKeys = {
	pending: "approvalHistoryPending",
	approved: "approvalHistoryApproved",
	denied: "approvalHistoryDenied",
	edited: "approvalHistoryEdited",
	cancelled: "approvalHistoryCancelled",
	interrupted: "approvalHistoryInterrupted",
} as const;
const scopeKeys = {
	once: "toolApprovalApprove",
	category: "toolApprovalAllowCategory",
	all: "toolApprovalAllowConversation",
} as const;
export function ApprovalActivity({ entries }: { entries: readonly UiApprovalHistoryEntry[] }) {
	const t = useT();
	if (!entries.length) return null;
	return (
		<details className="approval-history">
			<summary>
				{t("approvalHistoryTitle")} ({entries.length})
			</summary>
			<p className="set-hint">{t("approvalHistoryHint")}</p>
			<ol>
				{entries.map((entry) => (
					<li className="approval-history-row" key={entry.id}>
						<code>{entry.toolName}</code>
						<span>{t(statusKeys[entry.status])}</span>
						{entry.scope && <span className="set-hint">{t(scopeKeys[entry.scope])}</span>}
						<time dateTime={new Date(entry.updatedAt).toISOString()}>{new Date(entry.updatedAt).toLocaleString()}</time>
					</li>
				))}
			</ol>
		</details>
	);
}
