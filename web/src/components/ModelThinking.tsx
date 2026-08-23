import { memo, useEffect, useMemo, useState } from "react";
import { FiCpu, FiSearch, FiZap } from "react-icons/fi";
import type { ModelInfo, UiState } from "../types";
import { Dropdown, DropdownItem } from "./Dropdown";
import { useT } from "../i18n";

/** Messages this component sends (a subset shared by TopBar and ChatInput). */
export type ModelThinkingMsg =
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	| { type: "set_thinking"; level: string };

const THINKING_VALUES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below keeps
 *  both toolbars idle during streaming. */
interface Props {
	state: Pick<UiState, "model" | "thinkingLevel" | "availableThinkingLevels"> | null;
	models: ModelInfo[];
	modelsLoading: boolean;
	send: (msg: ModelThinkingMsg) => boolean;
	/** Opens the custom-model config modal (App-level state). */
	onManageModels: () => void;
	/** Compact triggers for narrow toolbars (mobile input row). */
	compact?: boolean;
}

/** Model picker + thinking-level picker. Rendered in the top bar on desktop
 * and in the input row on mobile — same dropdowns, different trigger styles. */
export const ModelThinking = memo(function ModelThinking({ state, models, modelsLoading, send, onManageModels, compact = false }: Props) {
	const t = useT();
	const model = state?.model;
	// snapshot model.id is the bare id; list ids are "provider/id".
	const currentModelId = model ? `${model.provider}/${model.id}` : null;
	const [modelOpen, setModelOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	// Model dropdown filter — the list can be long (all providers × models),
	// so a type-to-filter box sits above it. Reset when the dropdown closes.
	const [modelFilter, setModelFilter] = useState("");
	useEffect(() => {
		if (!modelOpen) setModelFilter("");
	}, [modelOpen]);
	const filteredModels = useMemo(() => {
		const q = modelFilter.trim().toLowerCase();
		if (!q) return models;
		return models.filter(
			(m) =>
				m.name.toLowerCase().includes(q) ||
				m.provider.toLowerCase().includes(q) ||
				m.id.toLowerCase().includes(q),
		);
	}, [models, modelFilter]);
	// Local loading flag for the model dropdown (list arrives via props.models).
	const [reqLoading, setReqLoading] = useState(false);

	// Model-supported thinking levels (snapshot). The SDK clamps any request
	// outside this set — unsupported levels must be disabled, not silently
	// snapped (that's what made the level look "impossible to change").
	// Empty/absent → unknown, keep everything enabled.
	const supportedThinking =
		state?.availableThinkingLevels && state.availableThinkingLevels.length > 0
			? new Set(state.availableThinkingLevels)
			: null;
	const thinkingLevels: {
		value: string;
		label: string;
		supported: boolean;
	}[] = THINKING_VALUES.map((v) => ({
		value: v,
		label: t(`thinking.${v}`),
		supported: supportedThinking ? supportedThinking.has(v) : true,
	}));
	const thinkingLabel = (level: string): string =>
		thinkingLevels.find((l) => l.value === level)?.label ?? level;

	// Lazily fetch the model list when the dropdown opens for the first time.
	useEffect(() => {
		if (modelOpen && models.length === 0 && !reqLoading && !modelsLoading) {
			setReqLoading(true);
			send({ type: "list_models" });
		}
	}, [modelOpen, models.length, reqLoading, modelsLoading, send]);
	useEffect(() => {
		if (models.length > 0) setReqLoading(false);
	}, [models.length]);

	return (
		<>
			<Dropdown
				trigger={
					<>
						<FiCpu />
						<span className="chip-model">
							{model ? model.name : t("selectModel")}
						</span>
						{!compact && model?.vision && (
							<span className="chip-vision" title={t("vision")}>
								🖼
							</span>
						)}
						{!compact && model && (
							<span className="chip-sub">{model.provider}</span>
						)}
					</>
				}
				open={modelOpen}
				onOpenChange={setModelOpen}
				menuClassName="dd-menu-model"
			>
				<div className="dd-header">{t("availableModels")}</div>
				<div className="dd-search-row">
					<FiSearch />
					<input
						className="dd-search"
						type="text"
						placeholder={t("searchModels")}
						value={modelFilter}
						onChange={(e) => setModelFilter(e.target.value)}
					/>
				</div>
				{/* Scrollable model list (middle band) — the header/search above
				    and the footer below stay fixed while this scrolls. */}
				<div className="dd-model-scroll">
					{(reqLoading || modelsLoading) && (
						<div className="dd-loading">{t("loading")}</div>
					)}
					{models.length === 0 &&
						!reqLoading &&
						!modelsLoading && (
							<div className="dd-loading">{t("noModels")}</div>
						)}
					{filteredModels.length === 0 && models.length > 0 && (
						<div className="dd-loading">{t("noModelMatches")}</div>
					)}
					{filteredModels.map((m) => (
						<DropdownItem
							key={m.id}
							active={currentModelId === m.id}
							onClick={() => {
								if (currentModelId !== m.id) {
									send({ type: "set_model", modelId: m.id });
								}
								setModelOpen(false);
							}}
						>
							<span className="dd-model-cell">
								<span className="dd-model-name">{m.name}</span>
								<span className="dd-model-meta">
									<span className="dd-model-provider">{m.provider}</span>
									{(m.reasoning || m.vision) && (
										<span className="dd-model-badges">
											{m.reasoning && (
													<span className="dd-model-badge">{t("reasoning")}</span>
											)}
											{m.vision && (
													<span className="dd-model-badge">{t("vision")}</span>
												)}
											</span>
										)}
									</span>
								</span>
							</DropdownItem>
						))}
					</div>
					{/* Fixed footer — refresh / manage never scroll away. */}
					<div className="dd-footer">
						<button
							type="button"
							className="dd-refresh"
							onClick={() => send({ type: "list_models" })}
						>
							{t("refreshModels")}
						</button>
						<button
							type="button"
							className="dd-refresh"
							onClick={() => {
								setModelOpen(false);
								onManageModels();
							}}
						>
							{t("manageModels")}
						</button>
					</div>
				</Dropdown>

			<Dropdown
				trigger={
					<>
						<FiZap />
						<span className="chip-sub">
							{t("thinkingChip", {
								level: state ? thinkingLabel(state.thinkingLevel) : "—",
							})}
						</span>
					</>
				}
				open={thinkingOpen}
				onOpenChange={setThinkingOpen}
			>
				<div className="dd-header">{t("thinkingLevel")}</div>
				{thinkingLevels.map((l) => (
					<DropdownItem
						key={l.value}
						active={state?.thinkingLevel === l.value}
						disabled={!l.supported}
						title={l.supported ? undefined : t("thinkingUnsupported")}
						onClick={() => {
							if (state?.thinkingLevel !== l.value) {
								send({ type: "set_thinking", level: l.value });
							}
							setThinkingOpen(false);
						}}
					>
						{l.label}
					</DropdownItem>
				))}
			</Dropdown>
		</>
	);
});
