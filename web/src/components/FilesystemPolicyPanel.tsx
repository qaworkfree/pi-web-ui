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

/** Mirror of the server's PROJECT_FILESYSTEM_PRESETS (project-filesystem-policy.ts). */
const PRESET_SHAPES: Record<keyof typeof presetKeys, Record<UiFilesystemAction, UiFilesystemPermission>> = {
	blocked: { read: "block", create: "block", write: "block", edit: "block", delete: "block", execute: "block" },
	"read-only": { read: "allow", create: "block", write: "block", edit: "block", delete: "block", execute: "block" },
	development: { read: "allow", create: "allow", write: "allow", edit: "allow", delete: "ask", execute: "ask" },
};

const normalizeRulePath = (path: string): string =>
	path
		.replace(/[\\/]+$/, "")
		.replaceAll("\\", "/")
		.toLowerCase();

/**
 * Which preset the current project's rule corresponds to: "none" when no rule
 * covers the project root exactly, "custom" when a rule exists but matches no
 * preset shape. Lets the panel SHOW the effective state instead of always
 * defaulting the dropdown to Read only (previous behavior, confusing).
 */
export function detectProjectPreset(
	policy: UiFilesystemPolicy | null,
	cwd: string,
): keyof typeof presetKeys | "custom" | "none" {
	if (!policy || !cwd) return "none";
	const target = normalizeRulePath(cwd);
	const rule = policy.rules.find((candidate) => normalizeRulePath(candidate.path) === target);
	if (!rule) return "none";
	for (const [preset, shape] of Object.entries(PRESET_SHAPES) as [
		keyof typeof presetKeys,
		typeof PRESET_SHAPES.blocked,
	][]) {
		if (
			(Object.keys(shape) as UiFilesystemAction[]).every(
				(action) => (rule.permissions[action] ?? "block") === shape[action],
			)
		)
			return preset;
	}
	return "custom";
}
export function FilesystemPolicyPanel({ policy, cwd }: { policy: UiFilesystemPolicy | null; cwd: string }) {
	const t = useT();
	const [draft, setDraft] = useState(policy);
	const current = detectProjectPreset(policy, cwd);
	// Start the preset dropdown on the project's EFFECTIVE preset (fall back to
	// read-only only when no preset-shaped rule exists).
	const [preset, setPreset] = useState<keyof typeof presetKeys>(
		current === "custom" || current === "none" ? "read-only" : current,
	);
	useEffect(() => setDraft(policy), [policy]);
	useEffect(() => {
		if (current !== "custom" && current !== "none") setPreset(current);
	}, [current]);
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
				{/* Effective state for THIS project, so the user can tell at a glance
				    whether the folder is blocked (the shipped default) or already set. */}
				<p className="set-hint fs-current-preset">
					{t("fsCurrentPreset", {
						preset:
							current === "none"
								? t("fsCurrentNone")
								: current === "custom"
									? t("fsCurrentCustom")
									: t(presetKeys[current]),
					})}
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
