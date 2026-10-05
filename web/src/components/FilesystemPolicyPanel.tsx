import { useEffect, useState } from "react";
import { FiFolder, FiPlus, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import type { UiFilesystemAction, UiFilesystemPermission, UiFilesystemPolicy } from "../types";

const actionKeys = {
	read: "fsRead",
	create: "fsCreate",
	write: "fsWrite",
	edit: "fsEdit",
	delete: "fsDelete",
	execute: "fsExecute",
} as const;
const decisionKeys = { allow: "approvalRuleActionAllow", ask: "approvalRuleActionAsk", block: "fsBlocked" } as const;
const presetKeys = { blocked: "fsBlocked", "read-only": "fsReadOnly", development: "fsDevelopment" } as const;
export function FilesystemPolicyPanel({ policy, cwd }: { policy: UiFilesystemPolicy | null; cwd: string }) {
	const t = useT();
	const [draft, setDraft] = useState(policy);
	const [preset, setPreset] = useState<keyof typeof presetKeys>("read-only");
	useEffect(() => setDraft(policy), [policy]);
	const permissions = (
		values: Partial<Record<UiFilesystemAction, UiFilesystemPermission>>,
		change: (action: UiFilesystemAction, decision: UiFilesystemPermission) => void,
	) => (
		<div className="set-form-row">
			{(Object.keys(actionKeys) as UiFilesystemAction[]).map((action) => (
				<label className="set-label" key={action}>
					{t(actionKeys[action])}
					<select
						className="set-input"
						aria-label={t(actionKeys[action])}
						value={values[action] ?? "block"}
						onChange={(event) => change(action, event.target.value as UiFilesystemPermission)}
					>
						{(Object.keys(decisionKeys) as UiFilesystemPermission[]).map((decision) => (
							<option key={decision} value={decision}>
								{t(decisionKeys[decision])}
							</option>
						))}
					</select>
				</label>
			))}
		</div>
	);
	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiFolder className="set-section-icon" />
				{t("fsTitle")}
				<button
					type="button"
					className="set-save-btn"
					aria-label={t("authRefresh")}
					title={t("authRefresh")}
					onClick={() => appSend({ type: "get_filesystem_policy" })}
				>
					<FiRefreshCw />
				</button>
			</div>
			<p className="set-hint">{t("fsHint")}</p>
			<p className="set-hint">{t("fsSemantics")}</p>
			<div className="set-card">
				<div className="set-subsection-title">{t("fsProject")}</div>
				<p className="set-hint" style={{ overflowWrap: "anywhere" }}>
					{cwd}
				</p>
				<p className="set-hint">{t("fsProjectHint")}</p>
				<label className="set-label">
					{t("fsProject")}
					<select
						className="set-input"
						aria-label={t("fsProject")}
						value={preset}
						onChange={(event) => setPreset(event.target.value as keyof typeof presetKeys)}
					>
						{(Object.keys(presetKeys) as (keyof typeof presetKeys)[]).map((value) => (
							<option key={value} value={value}>
								{t(presetKeys[value])}
							</option>
						))}
					</select>
				</label>
				<button
					type="button"
					className="set-save-btn"
					disabled={!cwd || !policy}
					onClick={() => {
						if (window.confirm(t("fsProjectConfirm", { path: cwd, preset: t(presetKeys[preset]) })))
							appSend({ type: "apply_project_filesystem_preset", preset });
					}}
				>
					{t("fsApplyProject")}
				</button>
			</div>
			{draft ? (
				<>
					<div className="set-subsection-title">{t("fsDefault")}</div>
					{permissions(draft.defaultPermissions, (action, decision) =>
						setDraft({ ...draft, defaultPermissions: { ...draft.defaultPermissions, [action]: decision } }),
					)}
					<button
						type="button"
						className="set-add-btn"
						onClick={() => setDraft({ ...draft, rules: [...draft.rules, { path: "", permissions: {} }] })}
					>
						<FiPlus />
						{t("fsAddRule")}
					</button>
					{draft.rules.map((rule, index) => (
						<div className="set-card" key={index}>
							<label className="set-label">
								{t("fsPath")}
								<input
									className="set-input"
									placeholder={cwd}
									value={rule.path}
									onChange={(event) =>
										setDraft({
											...draft,
											rules: draft.rules.map((item, i) => (i === index ? { ...item, path: event.target.value } : item)),
										})
									}
								/>
							</label>
							{permissions(rule.permissions, (action, decision) =>
								setDraft({
									...draft,
									rules: draft.rules.map((item, i) =>
										i === index ? { ...item, permissions: { ...item.permissions, [action]: decision } } : item,
									),
								}),
							)}
							<button
								type="button"
								className="set-icon-btn danger"
								title={t("approvalRuleDelete")}
								aria-label={t("approvalRuleDelete")}
								onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}
							>
								<FiTrash2 />
							</button>
						</div>
					))}
					<button
						type="button"
						className="set-save-btn"
						onClick={() =>
							appSend({
								type: "save_filesystem_policy",
								policy: { ...draft, rules: draft.rules.filter((rule) => rule.path.trim()) },
							})
						}
					>
						{t("save")}
					</button>
				</>
			) : (
				<p role="status">{t("loading")}</p>
			)}
		</div>
	);
}
