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

/** Model picker + thinking-level picker. Rendered in the composer toolbar
 * inside the input box (ChatInput .composer-tools). Menus open upward because
 * the input bar sits at the bottom of the window. */
export const ModelThinking = memo(function ModelThinking({ state, models, modelsLoading, send, onManageModels, compact = false }: Props) {
	const t = useT();
	const model = state?.model;
	// snapshot model.id is the bare id; list ids are "provider/id".
	const currentModelId = model ? `${model.provider}/${model.id}` : null;
	const [modelOpen, setModelOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	// Model dropdown filter — the list can be long (all providers × models),
	// so a type-to-filter box sits above it, plus a provider sidebar on the
	// left that narrows the list to one service. Reset both when the dropdown
	// closes.
	const [modelFilter, setModelFilter] = useState("");
	const [providerFilter, setProviderFilter] = useState<string | null>(null);
	useEffect(() => {
		if (!modelOpen) {
			setModelFilter("");
			setProviderFilter(null);
		}
	}, [modelOpen]);
	// Unique providers (sorted, with model counts) for the sidebar filter.
	const providers = useMemo(() => {
		const counts = new Map<string, number>();
		for (const m of models) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
		return [...counts.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([name, count]) => ({ name, count }));
	}, [models]);
	const filteredModels = useMemo(() => {
		let list = models;
		if (providerFilter) list = list.filter((m) => m.provider === providerFilter);
		const q = modelFilter.trim().toLowerCase();
		if (!q) return list;
		return list.filter(
			(m) =>
				m.name.toLowerCase().includes(q) ||
				m.provider.toLowerCase().includes(q) ||
				m.id.toLowerCase().includes(q),
		);
	}, [models, modelFilter, providerFilter]);
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
				direction="up"
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
				{/* Scrollable middle band — provider sidebar (left) + model list
				    (right). The header/search above and footer below stay fixed. */}
				<div className="dd-model-body">
					{providers.length > 1 && (
						<div className="dd-provider-col">
							<div className="dd-provider-head">{t("providers")}</div>
							<button
								type="button"
								className={`dd-provider-item ${providerFilter === null ? "active" : ""}`}
								onClick={() => setProviderFilter(null)}
							>
								<span>{t("allProviders")}</span>
							</button>
							{providers.map((p) => (
								<button
									type="button"
									key={p.name}
									className={`dd-provider-item ${providerFilter === p.name ? "active" : ""}`}
									onClick={() =>
										setProviderFilter(providerFilter === p.name ? null : p.name)
									}
									title={`${p.name} · ${p.count}`}
								>
									<span className="dd-provider-name">{p.name}</span>
									<span className="dd-provider-count">{p.count}</span>
								</button>
							))}
						</div>
					)}
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
				direction="up"
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
