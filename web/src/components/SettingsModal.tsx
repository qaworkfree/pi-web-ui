import { useEffect, useRef, useState } from "react";
import {
	FiCpu,
	FiEye,
	FiPackage,
	FiPlus,
	FiSettings,
	FiTerminal,
	FiTrash2,
	FiX,
	FiZap,
} from "react-icons/fi";
import type {
	ClientMessage,
	CommandDef,
	UiExtensionInfo,
	UiSettingsState,
	UiSkillInfo,
} from "../types";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";

/** Minimal terminal-tab bridge (same shape SCMPanel uses). */
interface SettingsTerminalBridge {
	create: (meta: {
		id: string;
		conversationId: string;
		title: string;
		cwd: string;
		cols: number;
		rows: number;
		running: boolean;
		exitCode: number | null;
		command?: CommandDef;
	}) => void;
	restart: (id: string) => void;
}

interface SettingsModalProps {
	chat: {
		settings: UiSettingsState | null;
		terminals: {
			id: string;
			title: string;
			conversationId: string;
			running: boolean;
			exitCode: number | null;
			command?: CommandDef;
		}[];
		state?: { cwd: string; conversationId: string } | null;
		activeConversationId?: string | null;
	};
	send: (msg: ClientMessage) => boolean;
	terminal: SettingsTerminalBridge;
	/** Switch the top-level view to the terminal (uninstall runs there). */
	onSwitchToTerminal: () => void;
	onClose: () => void;
}

/** A row with an enable/disable switch (skill / extension). */
function ToggleRow({
	title,
	subtitle,
	enabled,
	onToggle,
	action,
}: {
	title: string;
	subtitle: string;
	enabled: boolean;
	onToggle: () => void;
	/** Optional extra control rendered left of the switch (e.g. uninstall). */
	action?: React.ReactNode;
}) {
	const t = useT();
	return (
		<div className="set-row">
			<div className="set-row-info">
				<div className="set-row-name">{title}</div>
				{subtitle && <div className="set-row-desc">{subtitle}</div>}
			</div>
			{action}
			<button
				type="button"
				className={`set-switch ${enabled ? "on" : ""}`}
				role="switch"
				aria-checked={enabled}
				title={enabled ? t("settingsEnabled") : t("settingsDisabled")}
				onClick={onToggle}
			>
				<span className="set-switch-knob" />
			</button>
		</div>
	);
}

export function SettingsModal({
	chat,
	send,
	terminal,
	onSwitchToTerminal,
	onClose,
}: SettingsModalProps) {
	const t = useT();
	const settings = chat.settings;

	// Prompt draft — local while typing; re-synced from the server on each push
	// UNLESS the textarea is focused (an echo must not clobber mid-edit text).
	const [promptDraft, setPromptDraft] = useState("");
	const [promptMode, setPromptMode] = useState<"append" | "replace">("append");
	const promptFocus = useRef(false);
	// Vision-bridge prompt draft — same local-edit/re-sync pattern as above.
	const [vbPromptDraft, setVbPromptDraft] = useState("");
	const [vbPromptMode, setVbPromptMode] = useState<"append" | "replace">("append");
	const vbPromptFocus = useRef(false);
	// Goal-review prompt is an independent draft: it does not change the main
	// agent system prompt and is only used by the isolated reviewer.
	const [reviewPromptDraft, setReviewPromptDraft] = useState("");
	const reviewPromptFocus = useRef(false);
	const [presetName, setPresetName] = useState("");
	// Two-step uninstall confirm: which extension id is awaiting confirmation.
	const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);

	useEffect(() => {
		if (!settings) return;
		setPromptMode(settings.promptMode);
		if (promptFocus.current) return;
		// append: show the user's own text; replace: prefill the built-in
		// default prompt so the user sees exactly what they would replace.
		setPromptDraft(
			promptMode === "append" || settings.customSystemPrompt
				? settings.customSystemPrompt
				: settings.defaultSystemPrompt || "",
		);
		setVbPromptMode(settings.visionBridgePromptMode);
		if (vbPromptFocus.current) return;
		setVbPromptDraft(
			vbPromptMode === "append" || settings.visionBridgePrompt
				? settings.visionBridgePrompt
				: settings.visionBridgeDefaultPrompt || "",
		);
		if (!reviewPromptFocus.current) setReviewPromptDraft(settings.reviewPrompt);
	}, [settings, promptMode, vbPromptMode]);

	if (!settings) return null;

	const disabledSkills = new Set(settings.disabledSkills);
	const disabledExts = new Set(settings.disabledExtensions);

	const setPartial = (patch: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		terminalToolsEnabled?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
	}) => send({ type: "set_settings", ...patch });

	const toggleSkill = (s: UiSkillInfo) => {
		const next = new Set(disabledSkills);
		if (next.has(s.name)) next.delete(s.name);
		else next.add(s.name);
		setPartial({ disabledSkills: [...next] });
	};

	const toggleExtension = (e: UiExtensionInfo) => {
		const next = new Set(disabledExts);
		if (next.has(e.id)) next.delete(e.id);
		else next.add(e.id);
		setPartial({ disabledExtensions: [...next] });
	};

	/** Uninstall a `pi install`-ed package: run `pi remove npm:<pkg>` in a
	 *  VISIBLE terminal tab (same reuse pattern as SCM write ops) so the user
	 *  sees exactly what happened. On exit the App watcher sends
	 *  extensions_reload to re-discover the list. */
	const runUninstall = (pkgName: string) => {
		setConfirmUninstall(null);
		const title = `${t("uninstallTitle")} ${pkgName}`;
		const cmd: CommandDef = {
			name: title,
			command: `pi remove npm:${pkgName}`,
			cwd: "${pwd}",
		};
		const existing = chat.terminals.find((tm) => tm.title === title);
		if (existing) {
			terminal.restart(existing.id);
			send({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
		} else {
			terminal.create({
				id: randomUuid(),
				conversationId: chat.activeConversationId || chat.state?.conversationId || "",
				title,
				cwd: chat.state?.cwd ?? "",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		onSwitchToTerminal();
		onClose();
	};

	const toggleReviewSkill = (s: UiSkillInfo) => {
		const disabled = new Set(
			settings.reviewSkills.filter((x) => !x.enabled).map((x) => x.name),
		);
		if (disabled.has(s.name)) disabled.delete(s.name);
		else disabled.add(s.name);
		setPartial({ reviewDisabledSkills: [...disabled] });
	};

	const savePrompt = () => {
		// In replace mode, a draft identical to the built-in default means the
		// user didn't actually modify it — store empty so the server falls back
		// to the default (and switching to append later never duplicates it).
		const text =
			promptMode === "replace" &&
			settings.defaultSystemPrompt &&
			promptDraft === settings.defaultSystemPrompt
				? ""
				: promptDraft;
		setPartial({ promptMode, customSystemPrompt: text });
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
				<button
					type="button"
					className="modal-close"
					aria-label={t("close")}
					onClick={onClose}
				>
					<FiX />
				</button>
				<div className="modal-head">
					<FiSettings className="modal-head-icon" />
					<h2>{t("settingsTitle")}</h2>
				</div>
				<p className="modal-desc">{t("settingsDesc")}</p>

				{/* Scrollable body — head/desc above and the actions bar below stay
				    fixed; only these sections scroll. */}
				<div className="modal-body">

				{/* ---- system prompt -------------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiZap className="set-section-icon" />
						{t("settingsSystemPrompt")}
					</div>
					<div className="set-mode-row">
						<label className="set-field-label">{t("settingsPromptMode")}</label>
						<select
							className="set-select"
							value={promptMode}
							onChange={(e) => {
								const mode = e.target.value as "append" | "replace";
								setPromptMode(mode);
								setPartial({ promptMode: mode });
							}}
						>
							<option value="append">{t("promptModeAppend")}</option>
							<option value="replace">{t("promptModeReplace")}</option>
						</select>
					</div>
					<textarea
						className="set-prompt-input"
						rows={6}
						placeholder={t("promptPlaceholder")}
						value={promptDraft}
						onFocus={() => (promptFocus.current = true)}
						onBlur={() => {
							promptFocus.current = false;
							savePrompt();
						}}
						onChange={(e) => setPromptDraft(e.target.value)}
					/>
					<p className="set-hint">
						{promptMode === "append" ? t("promptAppendHint") : t("promptReplaceHint")}
					</p>
				</div>

				{/* ---- terminal tools ------------------------------------------ */}
				<div className="set-section">
					<div className="set-section-title">
						<FiTerminal className="set-section-icon" />
						{t("settingsTerminalTools")}
					</div>
					<ToggleRow
						title={t("terminalToolsEnabled")}
						subtitle={t("settingsTerminalToolsDesc")}
						enabled={settings.terminalToolsEnabled}
						onToggle={() =>
							setPartial({ terminalToolsEnabled: !settings.terminalToolsEnabled })
						}
					/>
					{!settings.terminalToolsEnabled && (
						<p className="set-hint">{t("terminalToolsOffHint")}</p>
					)}
				</div>

				{/* ---- skills --------------------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiCpu className="set-section-icon" />
						{t("settingsSkills")}
						<span className="set-count">{settings.skills.length}</span>
					</div>
					{settings.skills.length === 0 ? (
						<p className="set-empty">{t("noSkills")}</p>
					) : (
						<div className="set-list">
							{settings.skills.map((s) => (
								<ToggleRow
									key={s.name}
									title={s.name}
									subtitle={s.description}
									enabled={s.enabled}
									onToggle={() => toggleSkill(s)}
								/>
							))}
						</div>
					)}
				</div>

				{/* ---- extensions ------------------------------------------------ */}
				<div className="set-section">
					<div className="set-section-title">
						<FiPackage className="set-section-icon" />
						{t("settingsExtensions")}
						<span className="set-count">{settings.extensions.length}</span>
					</div>
					{settings.extensions.length === 0 ? (
						<p className="set-empty">{t("noExtensions")}</p>
					) : (
						<div className="set-list">
							{settings.extensions.map((e) => {
								const pkgName = e.id.startsWith("npm:") ? e.id.slice(4) : null;
								return (
									<ToggleRow
										key={e.id}
										title={e.name}
										subtitle={e.path}
										enabled={e.enabled}
										onToggle={() => toggleExtension(e)}
										action={
											pkgName ? (
												confirmUninstall === e.id ? (
													<button
														type="button"
														className="set-uninstall confirm"
														title={t("uninstallConfirmHint")}
														onClick={() => runUninstall(pkgName)}
													>
														{t("uninstallConfirm")}
													</button>
												) : (
													<button
														type="button"
														className="set-uninstall"
														title={t("uninstallHint")}
														onClick={() => setConfirmUninstall(e.id)}
													>
														<FiTrash2 />
														{t("uninstallExt")}
													</button>
												)
											) : undefined
										}
									/>
								);
							})}
						</div>
					)}
				</div>

				{/* ---- goal review ----------------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiZap className="set-section-icon" />
						{t("settingsReview")}
						<span className="set-count">{settings.reviewSkills.length}</span>
					</div>
					<p className="set-hint">{t("settingsReviewDesc")}</p>
					<textarea
						className="set-prompt-input"
						rows={5}
						placeholder={t("reviewPromptPlaceholder")}
						value={reviewPromptDraft}
						onFocus={() => (reviewPromptFocus.current = true)}
						onBlur={() => {
							reviewPromptFocus.current = false;
							setPartial({ reviewPrompt: reviewPromptDraft });
						}}
						onChange={(e) => setReviewPromptDraft(e.target.value)}
					/>
					<p className="set-hint">{t("reviewPromptHint")}</p>
					<div className="set-field-label">{t("settingsReviewSkills")}</div>
					{settings.reviewSkills.length === 0 ? (
						<p className="set-empty">{t("noSkills")}</p>
					) : (
						<div className="set-list">
							{settings.reviewSkills.map((s) => (
								<ToggleRow
									key={`review-${s.name}`}
									title={s.name}
									subtitle={s.description}
									enabled={s.enabled}
									onToggle={() => toggleReviewSkill(s)}
								/>
							))}
						</div>
					)}
				</div>

				{/* ---- presets --------------------------------------------------- */}
				{/* ---- vision bridge ---------------------------------------------- */}
				<div className="set-section">
					<div className="set-section-title">
						<FiEye className="set-section-icon" />
						{t("settingsVisionBridge")}
					</div>
					<ToggleRow
						title={t("visionBridgeEnabled")}
						subtitle={t("settingsVisionBridgeDesc")}
						enabled={settings.visionBridgeEnabled}
						onToggle={() =>
							setPartial({ visionBridgeEnabled: !settings.visionBridgeEnabled })
						}
					/>
					{!settings.visionBridgeEnabled && (
						<p className="set-hint">{t("visionBridgeOffHint")}</p>
					)}
					{settings.visionBridgeEnabled && (
						<div className="set-mode-row">
							<label className="set-field-label">
								{t("visionBridgeModel")}
							</label>
							<select
								className="set-select"
								value={settings.visionBridgeModel ?? ""}
								onChange={(e) =>
									setPartial({ visionBridgeModel: e.target.value || null })
								}
							>
								<option value="">{t("visionBridgeAuto")}</option>
								{settings.visionModels.map((m) => (
									<option
										key={`${m.provider}/${m.id}`}
										value={`${m.provider}/${m.id}`}
									>
										{m.label}
									</option>
								))}
							</select>
						</div>
					)}
					{settings.visionBridgeEnabled && (
						<div className="set-mode-row">
							<label className="set-field-label">
								{t("visionBridgePromptMode")}
							</label>
							<select
								className="set-select"
								value={vbPromptMode}
								onChange={(e) => {
									const mode = e.target.value as "append" | "replace";
									setVbPromptMode(mode);
									setPartial({ visionBridgePromptMode: mode });
								}}
							>
								<option value="append">{t("promptModeAppend")}</option>
								<option value="replace">{t("promptModeReplace")}</option>
							</select>
						</div>
					)}
					{settings.visionBridgeEnabled && (
						<textarea
							className="set-prompt-input"
							rows={4}
							placeholder={t("visionBridgePromptPlaceholder")}
							value={vbPromptDraft}
							onFocus={() => (vbPromptFocus.current = true)}
							onBlur={() => {
								vbPromptFocus.current = false;
								// Same contract as the system prompt: an unmodified copy of
								// the built-in default is stored as empty (use default).
								const text =
									vbPromptMode === "replace" &&
									settings.visionBridgeDefaultPrompt &&
									vbPromptDraft === settings.visionBridgeDefaultPrompt
										? ""
										: vbPromptDraft;
								setPartial({
									visionBridgePromptMode: vbPromptMode,
									visionBridgePrompt: text,
								});
							}}
							onChange={(e) => setVbPromptDraft(e.target.value)}
						/>
					)}
					{settings.visionBridgeEnabled && (
						<p className="set-hint">
							{vbPromptMode === "append"
								? t("visionBridgePromptAppendHint")
								: t("visionBridgePromptReplaceHint")}
						</p>
					)}
					{settings.visionBridgeEnabled &&
						(settings.visionModels.length === 0 ? (
							<p className="set-hint">{t("visionBridgeNoModels")}</p>
						) : (
							<p className="set-hint">
								{t("visionBridgeCurrent", {
									model:
										settings.visionBridgeModel ??
										t("visionBridgeAuto"),
								})}
							</p>
						))}
				</div>
				<div className="set-section">
					<div className="set-section-title">
						<FiSettings className="set-section-icon" />
						{t("settingsPresets")}
						<span className="set-count">{settings.presets.length}</span>
					</div>
					<div className="set-preset-save">
						<input
							className="set-input"
							placeholder={t("presetNamePlaceholder")}
							value={presetName}
							onChange={(e) => setPresetName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && presetName.trim()) {
									send({ type: "save_preset", name: presetName.trim() });
									setPresetName("");
								}
							}}
						/>
						<button
							type="button"
							className="set-save-btn"
							disabled={!presetName.trim()}
							onClick={() => {
								send({ type: "save_preset", name: presetName.trim() });
								setPresetName("");
							}}
						>
							<FiPlus /> {t("saveAsPreset")}
						</button>
					</div>
					{settings.presets.length === 0 ? (
						<p className="set-empty">{t("noPresets")}</p>
					) : (
						<div className="set-list">
							{settings.presets.map((p) => (
								<div className="set-row" key={p.name}>
									<div className="set-row-info">
										<div className="set-row-name">{p.name}</div>
										<div className="set-row-desc">
											{p.promptMode === "replace"
												? t("promptModeReplace")
												: t("promptModeAppend")}
											{p.disabledSkills.length > 0 &&
												` · ${t("settingsSkills")} ${p.disabledSkills.length}`}
											{p.disabledExtensions.length > 0 &&
												` · ${t("settingsExtensions")} ${p.disabledExtensions.length}`}
										</div>
									</div>
									<div className="set-row-actions">
										<button
											type="button"
											className="dd-refresh"
											onClick={() => send({ type: "apply_preset", name: p.name })}
										>
											{t("applyPreset")}
										</button>
										<button
											type="button"
											className="set-icon-btn danger"
											title={t("deletePreset")}
											onClick={() => send({ type: "delete_preset", name: p.name })}
										>
											<FiTrash2 />
										</button>
									</div>
								</div>
							))}
						</div>
					)}
				</div>
				</div>

				<div className="modal-actions">
					<button type="button" className="dd-refresh" onClick={onClose}>
						{t("close")}
					</button>
				</div>
			</div>
		</div>
	);
}
