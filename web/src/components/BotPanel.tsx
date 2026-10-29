import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
	FiAnchor,
	FiCamera,
	FiCircle,
	FiCornerUpLeft,
	FiEdit2,
	FiFlag,
	FiPlay,
	FiRotateCw,
	FiSave,
	FiSquare,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import type { UiBotAction, UiBotConfig, UiBotRouteOp } from "../types";
import type { ChatState } from "../use-chat";

type BotTab = "fishing" | "hunt";
const TAB_KEY = "pi-web.botTab";
const LOG_KEY = "pi-web.botLogWarn";

function readTab(): BotTab {
	try {
		return localStorage.getItem(TAB_KEY) === "hunt" ? "hunt" : "fishing";
	} catch {
		return "fishing";
	}
}

function readFlag(key: string): boolean {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}

function storeFlag(key: string, on: boolean): void {
	try {
		localStorage.setItem(key, on ? "1" : "0");
	} catch {
		/* private mode: not remembered */
	}
}

/** Seconds → "m:ss" / "h:mm:ss". */
function formatElapsed(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Wall clock that ticks once a second while `active` (elapsed timers); frozen otherwise. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [active]);
	return now;
}

/** A settings group that folds away (the open/closed choice is remembered per group). */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
	const key = `pi-web.botSec.${id}`;
	const [open, setOpen] = useState(() => {
		try {
			return localStorage.getItem(key) !== "0";
		} catch {
			return true;
		}
	});
	return (
		<details
			className="bot-section"
			open={open}
			onToggle={(e) => {
				const next = e.currentTarget.open;
				setOpen(next);
				storeFlag(key, next);
			}}
		>
			<summary>{title}</summary>
			<div className="bot-section-body">{children}</div>
		</details>
	);
}

/**
 * BOT tab: drives the local game-control controller (server/game-bot.ts). Two sub-tabs share one controller:
 * Fishing (auto-fishing with a scripted fight + anti-AFK; the spot is picked on a screenshot) and Hunt (walk a
 * saved route tile by tile, fight the Pokemon near ours, catch shinies; routes are recorded and catalogued by
 * name). The settings both modes use sit in the side column, grouped, with one Save. Offered only when the server
 * has PI_WEB_GAME_CONTROL configured; settings and routes stay in the private data folders.
 */
export function BotPanel({ chat }: { chat: ChatState }) {
	const t = useT();
	const state = chat.botState;
	const shot = chat.botShot;
	const [tab, setTabState] = useState<BotTab>(readTab);
	const [draft, setDraft] = useState<UiBotConfig | null>(null);
	const [pickPet, setPickPet] = useState(false); // a screenshot click sets the Pokemon spot instead of the fishing spot
	const [routeName, setRouteName] = useState("");
	const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [warnOnly, setWarnOnly] = useState(() => readFlag(LOG_KEY));
	const config = draft ?? state?.config ?? null;
	const hunt = state?.hunt ?? null;
	const recording = hunt?.recording ?? null;
	const huntRunning = Boolean(hunt?.running);
	const now = useNow(huntRunning || Boolean(recording));

	useEffect(() => {
		appSend({ type: "bot_command", action: "status" });
		if (!chat.botShot) appSend({ type: "bot_command", action: "screenshot" });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once on open
	}, []);

	useEffect(() => {
		if (tab === "hunt" && chat.bot) appSend({ type: "bot_route", op: "list" });
	}, [tab, chat.bot]);

	if (!chat.bot) {
		return (
			<div className="bot-panel">
				<p className="bot-muted">{t("botUnavailable")}</p>
			</div>
		);
	}

	const setTab = (next: BotTab) => {
		setTabState(next);
		try {
			localStorage.setItem(TAB_KEY, next);
		} catch {
			/* private mode: the tab just is not remembered */
		}
	};
	const run = (action: UiBotAction) => appSend({ type: "bot_command", action });
	const route = (op: UiBotRouteOp, name?: string, newName?: string) =>
		appSend({
			type: "bot_route",
			op,
			...(name !== undefined ? { name } : {}),
			...(newName !== undefined ? { newName } : {}),
		});
	const save = (partial: Partial<UiBotConfig>) => appSend({ type: "bot_save_config", config: partial });
	const edit = (patch: Partial<UiBotConfig>) => config && setDraft({ ...config, ...patch });
	const saveDraft = () => {
		if (draft) save(draft);
		setDraft(null);
	};
	// Ball per shiny species: the table rows (name, hotkey) in order; "*" (any other species) is edited separately.
	const shinyRows: [string, string][] = Object.entries(config?.shinyBalls ?? {}).filter(([n]) => n !== "*");
	const setShinyRows = (rows: [string, string][], other = config?.shinyBalls?.["*"] ?? "") => {
		const next: Record<string, string> = {};
		for (const [n, k] of rows) if (n !== "*") next[n] = k;
		if (other) next["*"] = other;
		edit({ shinyBalls: next });
	};
	const setShinyRow = (i: number, name: string, key: string) =>
		setShinyRows(shinyRows.map((r, j) => (j === i ? [name, key] : r)));

	const pickSpot = (e: MouseEvent<HTMLImageElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		const x = Math.round(((e.clientX - r.left) / r.width) * 1000);
		const y = Math.round(((e.clientY - r.top) / r.height) * 1000);
		save(pickPet ? { petSpot: { x, y } } : { spot: { x, y } });
	};

	const spot = state?.config.spot ?? null;
	const petSpot = state?.config.petSpot ?? null;
	const routes = state?.routes ?? [];
	const huntRoute = state?.config.huntRoute ?? "";
	const selectedRoute = routes.find((r) => r.name === huntRoute) ?? null;
	const fishingRunning = Boolean(state?.fishing || state?.antiIdle);
	const nextMin =
		state?.antiIdle && state.antiIdleNext
			? Math.max(0, (state.antiIdleNext - Date.now() / 1000) / 60).toFixed(1)
			: null;
	const allLogs = [...(state?.logs ?? [])].reverse();
	const logs = warnOnly ? allLogs.filter((l) => l.level !== "info") : allLogs;
	const lureActive = state?.lure.active ?? null;
	const lureLabel = lureActive === null ? t("botLureUnknown") : lureActive ? t("botLureOn") : t("botLureOff");
	const lureClass = lureActive === null ? "unknown" : lureActive ? "on" : "off";

	// Phase pill: the controller's phase word → label + colour (unknown phases show as they are).
	const phase = recording ? "recording" : (state?.phase ?? "idle");
	const phaseLabel: Record<string, string> = {
		idle: t("botPhaseIdle"),
		walking: t("botPhaseWalking"),
		fighting: t("botPhaseFighting"),
		stuck: t("botPhaseStuck"),
		paused: t("botPhasePaused"),
		recovering: t("botPhaseRecovering"),
		reviving: t("botPhaseRecovering"),
		recording: t("botPhaseRecording"),
	};
	const phaseClass =
		phase === "stuck" || state?.halted
			? "off"
			: phase === "paused" || phase === "recovering" || phase === "reviving" || phase === "recording"
				? "unknown"
				: phase === "idle"
					? ""
					: "on";
	const phasePill = (
		<span className={`bot-badge bot-phase ${phaseClass}`}>
			{state?.halted ? t("botHalted") : (phaseLabel[phase] ?? phase)}
		</span>
	);

	const statusCard = (
		<div className="bot-card">
			<div className="bot-card-head">
				<h3>{t("botStatus")}</h3>
				{phasePill}
			</div>
			{state?.reason && <p>{state.reason}</p>}
			{state?.error && <p className="bot-warn">{state.error}</p>}
			<p className="bot-muted">
				{t("botStats", {
					casts: state?.stats.casts ?? 0,
					bites: state?.stats.bites ?? 0,
					challenges: state?.stats.challenges ?? 0,
					fights: state?.stats.fights ?? 0,
					shinies: state?.stats.shinies ?? 0,
					llm: state?.stats.llm ?? 0,
				})}
			</p>
			{state?.lastResult && <p className="bot-muted">{state.lastResult}</p>}
		</div>
	);

	// Why Start is greyed out (the first reason that applies).
	const huntBlocked = fishingRunning
		? t("botHuntBusy")
		: recording
			? t("botHuntWhyRecording")
			: !huntRoute
				? t("botHuntWhyRoute")
				: selectedRoute && !selectedRoute.walkable
					? t("botHuntNotWalkable")
					: "";
	const stepPct = hunt && hunt.steps > 0 ? Math.min(100, Math.round((hunt.step / hunt.steps) * 100)) : 0;

	const huntCard = (
		<div className={`bot-card bot-hunt-card${hunt?.stuck ? " stuck" : ""}`}>
			<div className="bot-card-head">
				<h3>{t("botHuntRun")}</h3>
				{phasePill}
			</div>
			<p className="bot-hunt-route">
				<span className="bot-muted">{t("botHuntRoute")}</span>{" "}
				<strong>{huntRoute || t("botHuntNoRouteSelected")}</strong>
				{selectedRoute && (
					<span className="bot-muted">
						{" "}
						· {t("botHuntRouteShort", { waypoints: selectedRoute.waypoints, steps: selectedRoute.steps })}
					</span>
				)}
			</p>
			{hunt?.stuck && <p className="bot-alert">{t("botHuntStuck")}</p>}
			<div className="bot-row">
				{huntRunning ? (
					<>
						{hunt?.stuck && (
							<button type="button" className="btn primary" onClick={() => run("hunt_resume")}>
								<FiRotateCw /> {t("botHuntResume")}
							</button>
						)}
						<button type="button" className="btn" onClick={() => run("hunt_back")}>
							<FiCornerUpLeft /> {hunt?.stuck ? t("botHuntBack") : t("botHuntTurn")}
						</button>
						<button type="button" className="btn danger" onClick={() => run("hunt_stop")}>
							<FiSquare /> {t("botStop")}
						</button>
					</>
				) : (
					<button
						type="button"
						className="btn primary"
						disabled={Boolean(huntBlocked)}
						onClick={() => run("hunt_start")}
					>
						<FiPlay /> {t("botStart")}
					</button>
				)}
			</div>
			{!huntRunning && huntBlocked && <p className="bot-muted">{huntBlocked}</p>}
			{huntRunning && hunt && (
				<div className="bot-progress-wrap">
					<div
						className="bot-progress"
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={hunt.steps}
						aria-valuenow={hunt.step}
					>
						<span style={{ width: `${stepPct}%` }} />
					</div>
					<p className="bot-muted">
						{hunt.steps > 0 && t("botHuntTiles", { n: hunt.step, total: hunt.steps })}
						{hunt.waypoints > 0 && <> · {t("botHuntProgress", { n: hunt.waypoint, total: hunt.waypoints })}</>}
						{hunt.startedAt > 0 && <> · {t("botHuntElapsed", { time: formatElapsed(now / 1000 - hunt.startedAt) })}</>}
					</p>
				</div>
			)}
			{state?.reason && <p className="bot-muted">{state.reason}</p>}
			<p className="bot-muted">
				{t("botHuntStats", { fights: state?.stats.fights ?? 0, shinies: state?.stats.shinies ?? 0 })}
			</p>
			{state?.lastResult && <p className="bot-muted">{state.lastResult}</p>}
			{state?.error && <p className="bot-warn">{state.error}</p>}
			<details className="bot-help">
				<summary>{t("botHuntHow")}</summary>
				<p className="bot-muted">{t("botHuntRunHint")}</p>
			</details>
		</div>
	);

	const routesCard = (
		<div className="bot-card">
			<div className="bot-card-head">
				<h3>{t("botHuntRoutes")}</h3>
				<span className="bot-muted">{routes.length}</span>
			</div>
			{recording ? (
				<div className="bot-rec-panel">
					<p className="bot-rec-line">
						<span className="bot-rec-dot" aria-hidden="true" />
						{t("botHuntRecording", {
							name: recording.name,
							tiles: recording.tiles,
							waypoints: recording.waypoints,
							time: formatElapsed(now / 1000 - recording.startedAt),
						})}
					</p>
					<p className="bot-muted">{t("botHuntGoRecord")}</p>
					<div className="bot-row">
						<button type="button" className="btn primary" onClick={() => route("record_stop")}>
							<FiSquare /> {t("botHuntStopRecord")}
						</button>
						<button type="button" className="btn" onClick={() => route("record_waypoint")}>
							<FiFlag /> {t("botHuntAddWaypoint")}
						</button>
						<button type="button" className="btn" onClick={() => route("record_cancel")}>
							<FiX /> {t("botHuntCancelRecord")}
						</button>
					</div>
				</div>
			) : (
				<div className="bot-rec-new">
					<span className="bot-muted">{t("botHuntRecorder")}</span>
					<div className="bot-row bot-rec-row">
						<input
							className="bot-rec-name"
							value={routeName}
							maxLength={48}
							placeholder={t("botHuntRouteName")}
							aria-label={t("botHuntRouteName")}
							onChange={(e) => setRouteName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && routeName.trim() && !huntRunning && !fishingRunning) {
									route("record_start", routeName.trim());
								}
							}}
						/>
						<button
							type="button"
							className="btn primary"
							disabled={!routeName.trim() || huntRunning || fishingRunning}
							onClick={() => route("record_start", routeName.trim())}
						>
							<FiCircle /> {t("botHuntRecord")}
						</button>
					</div>
					{routes.some((r) => r.name.toLowerCase() === routeName.trim().toLowerCase()) && (
						<p className="bot-warn">{t("botHuntReRecord")}</p>
					)}
					<details className="bot-help">
						<summary>{t("botHuntRecordHow")}</summary>
						<p className="bot-muted">{t("botHuntRecordHint")}</p>
						<label className="bot-field">
							<span>{t("botHuntMarkKey")}</span>
							<input
								key={state?.config.routeMarkKey ?? ""}
								defaultValue={state?.config.routeMarkKey ?? ""}
								placeholder="f9"
								onBlur={(e) => {
									if (e.target.value !== (state?.config.routeMarkKey ?? "")) save({ routeMarkKey: e.target.value });
								}}
							/>
						</label>
					</details>
				</div>
			)}
			{routes.length === 0 ? (
				<p className="bot-muted">{t("botHuntNoRoutes")}</p>
			) : (
				<ul className="bot-routes">
					{routes.map((r) => (
						<li key={r.name} className={r.name === huntRoute ? "selected" : ""}>
							{r.thumb ? (
								<img className="bot-route-thumb" src={`data:image/jpeg;base64,${r.thumb}`} alt="" />
							) : (
								<span className="bot-route-thumb" aria-hidden="true" />
							)}
							<div className="bot-route-main">
								{renaming?.name === r.name ? (
									<input
										autoFocus
										value={renaming.value}
										maxLength={48}
										aria-label={t("botHuntRename")}
										onChange={(e) => setRenaming({ name: r.name, value: e.target.value })}
										onKeyDown={(e) => {
											if (e.key === "Enter" && renaming.value.trim()) {
												route("rename", r.name, renaming.value.trim());
												setRenaming(null);
											}
											if (e.key === "Escape") setRenaming(null);
										}}
									/>
								) : (
									<strong className="bot-route-name">{r.name}</strong>
								)}
								<span className="bot-muted">
									{t("botHuntRouteInfo", {
										waypoints: r.waypoints,
										steps: r.steps,
										date: r.updated ? new Date(r.updated * 1000).toLocaleString() : "—",
									})}
								</span>
							</div>
							<div className="bot-route-actions">
								{!r.walkable && (
									<span className="bot-badge unknown" title={t("botHuntNotWalkable")}>
										{t("botHuntOldBadge")}
									</span>
								)}
								{r.name === huntRoute ? (
									<span className="bot-badge on">{t("botHuntSelected")}</span>
								) : (
									<button
										type="button"
										className="btn"
										disabled={huntRunning || !r.walkable}
										onClick={() => route("select", r.name)}
									>
										{t("botHuntUse")}
									</button>
								)}
								{renaming?.name === r.name ? (
									<button
										type="button"
										className="btn"
										disabled={!renaming.value.trim()}
										onClick={() => {
											route("rename", r.name, renaming.value.trim());
											setRenaming(null);
										}}
									>
										<FiSave /> {t("botSave")}
									</button>
								) : (
									<button
										type="button"
										className="btn"
										title={t("botHuntRename")}
										aria-label={t("botHuntRename")}
										disabled={huntRunning || Boolean(recording)}
										onClick={() => setRenaming({ name: r.name, value: r.name })}
									>
										<FiEdit2 />
									</button>
								)}
								{confirmDelete === r.name ? (
									<button
										type="button"
										className="btn danger"
										onClick={() => {
											route("delete", r.name);
											setConfirmDelete(null);
										}}
										onBlur={() => setConfirmDelete(null)}
									>
										<FiTrash2 /> {t("botHuntDeleteConfirm")}
									</button>
								) : (
									<button
										type="button"
										className="btn"
										title={t("botHuntDelete")}
										aria-label={t("botHuntDelete")}
										disabled={huntRunning || Boolean(recording)}
										onClick={() => setConfirmDelete(r.name)}
									>
										<FiTrash2 />
									</button>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);

	return (
		<div className="bot-panel">
			<div className="bot-head">
				<h2>{t("botTitle")}</h2>
				<span className="bot-muted">{t("botSafety")}</span>
			</div>
			<div className="set-subtabs bot-tabs" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "fishing"}
					className={`set-subtab${tab === "fishing" ? " active" : ""}`}
					onClick={() => setTab("fishing")}
				>
					<FiAnchor /> {t("botTabFishing")}
					{fishingRunning && <span className="bot-badge on">{t("botRunning")}</span>}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "hunt"}
					className={`set-subtab${tab === "hunt" ? " active" : ""}`}
					onClick={() => setTab("hunt")}
				>
					<FiFlag /> {t("botTabHunt")}
					{huntRunning && (
						<span className={`bot-badge ${hunt?.stuck ? "off" : "on"}`}>
							{hunt?.stuck ? t("botPhaseStuck") : t("botRunning")}
						</span>
					)}
					{recording && <span className="bot-badge unknown">{t("botHuntRecBadge")}</span>}
				</button>
			</div>
			<div className="bot-body">
				{tab === "fishing" ? (
					<section className="bot-shot">
						{shot ? (
							<div className="bot-shot-frame">
								<img
									src={`data:image/jpeg;base64,${shot.data}`}
									width={shot.width}
									height={shot.height}
									alt=""
									onClick={pickSpot}
								/>
								{spot && <span className="bot-spot" style={{ left: `${spot.x / 10}%`, top: `${spot.y / 10}%` }} />}
								{petSpot && (
									<span className="bot-spot pet" style={{ left: `${petSpot.x / 10}%`, top: `${petSpot.y / 10}%` }} />
								)}
							</div>
						) : (
							<p className="bot-muted">{t("botNoShot")}</p>
						)}
						<div className="bot-row">
							<button type="button" className="btn" onClick={() => run("screenshot")}>
								<FiCamera /> {t("botRefreshShot")}
							</button>
							<select
								className="bot-select"
								value={pickPet ? "pet" : "fish"}
								onChange={(e) => setPickPet(e.target.value === "pet")}
								aria-label={t("botPickTarget")}
							>
								<option value="fish">{t("botPickFishing")}</option>
								<option value="pet">{t("botPickPet")}</option>
							</select>
							<span className="bot-muted">
								{t("botSpot")}: {spot ? `${spot.x}, ${spot.y}` : t("botSpotNone")} · {t("botPetSpot")}:{" "}
								{petSpot ? `${petSpot.x}, ${petSpot.y}` : t("botSpotNone")}
							</span>
							{petSpot && (
								<button type="button" className="btn" onClick={() => save({ petSpot: null })}>
									<FiX /> {t("botPetSpotClear")}
								</button>
							)}
						</div>
						<p className="bot-muted">{pickPet ? t("botPetSpotHint") : t("botSpotHint")}</p>

						<div className="bot-under">
							<div className="bot-card">
								<h3>
									{t("botFishing")} + {t("botAntiIdle")}
								</h3>
								<div className="bot-row">
									{fishingRunning ? (
										<button type="button" className="btn danger" onClick={() => run("stop")}>
											<FiSquare /> {t("botStop")}
										</button>
									) : (
										<button
											type="button"
											className="btn primary"
											disabled={!spot || huntRunning || Boolean(recording)}
											onClick={() => run("start")}
										>
											<FiPlay /> {t("botStart")}
										</button>
									)}
									{nextMin !== null && <span className="bot-muted">{t("botNextRoutine", { min: nextMin })}</span>}
								</div>
								{(huntRunning || recording) && !fishingRunning && <p className="bot-muted">{t("botFishingBusy")}</p>}
								{state?.antiIdleLast && <p className="bot-muted">{state.antiIdleLast}</p>}
								{config && (
									<div className="bot-row bot-lure-row">
										<span>{t("botLure")}</span>
										<select
											className="bot-select"
											value={state?.config.lure ?? ""}
											onChange={(e) => {
												save({ lure: e.target.value });
												if (draft) setDraft({ ...draft, lure: e.target.value });
											}}
										>
											<option value="">{t("botLureNone")}</option>
											{Object.keys(config.lureKeys).map((name) => (
												<option key={name} value={name}>
													{name} ({config.lureKeys[name]})
												</option>
											))}
										</select>
										<span className={`bot-badge ${lureClass}`}>{lureLabel}</span>
										<button
											type="button"
											className="btn"
											disabled={!state?.config.lure}
											onClick={() => run("lure_attach")}
										>
											<FiAnchor /> {t("botLureAttach")}
										</button>
										<button
											type="button"
											className="btn"
											disabled={!state?.config.lure}
											onClick={() => run("lure_detach")}
										>
											<FiX /> {t("botLureDetach")}
										</button>
									</div>
								)}
							</div>
							{statusCard}
						</div>
					</section>
				) : (
					<section className="bot-shot bot-hunt">
						{huntCard}
						{routesCard}
					</section>
				)}

				<section className="bot-side">
					{config && (
						<div className="bot-card bot-settings">
							<div className="bot-card-head bot-save-bar">
								<h3>{t("botSettings")}</h3>
								{draft ? (
									<span className="bot-row">
										<span className="bot-warn">{t("botUnsaved")}</span>
										<button type="button" className="btn" onClick={() => setDraft(null)}>
											<FiX /> {t("botDiscard")}
										</button>
										<button type="button" className="btn primary" onClick={saveDraft}>
											<FiSave /> {t("botSave")}
										</button>
									</span>
								) : null}
							</div>
							<Section id="fight" title={t("botSecFight")}>
								<p className="bot-muted">{t("botPokemonHint")}</p>
								<label className="bot-field">
									<span>{t("botPokemonSlot")}</span>
									<input
										type="number"
										min={1}
										max={6}
										value={config.pokemonSlot}
										onChange={(e) => edit({ pokemonSlot: Number(e.target.value) })}
									/>
								</label>
								<label className="bot-field">
									<span>{t("botMoves")}</span>
									<input
										value={config.moves.join(",")}
										onChange={(e) => edit({ moves: e.target.value.split(",").map((m) => m.trim()) })}
									/>
								</label>
								<label className="bot-field">
									<span>{t("botFightTimeout")}</span>
									<input
										type="number"
										min={10}
										max={600}
										value={config.fightTimeoutS}
										onChange={(e) => edit({ fightTimeoutS: Number(e.target.value) })}
									/>
								</label>
								<label className="bot-check">
									<input type="checkbox" checked={config.attack} onChange={(e) => edit({ attack: e.target.checked })} />
									<span>{t("botAttack")}</span>
								</label>
								{tab === "hunt" && <p className="bot-muted">{t("botAttackHunt")}</p>}
							</Section>
							<Section id="balls" title={t("botSecBalls")}>
								<label className="bot-field">
									<span>{t("botBallPrimary")}</span>
									<input
										value={config.ballPrimary}
										placeholder="shift+1"
										onChange={(e) => edit({ ballPrimary: e.target.value })}
									/>
								</label>
								<label className="bot-field">
									<span>{t("botBallSecondary")}</span>
									<input
										value={config.ballSecondary}
										placeholder="shift+2"
										onChange={(e) => edit({ ballSecondary: e.target.value })}
									/>
								</label>
								<p className="bot-muted">{t("botBallHint")}</p>
								<div className="bot-balls">
									<span className="bot-balls-title">{t("botShinyBalls")}</span>
									{shinyRows.map(([name, key], i) => (
										<div className="bot-ball-row" key={i}>
											<input
												value={name}
												placeholder={t("botShinyBallsSpecies")}
												aria-label={t("botShinyBallsSpecies")}
												onChange={(e) => setShinyRow(i, e.target.value, key)}
											/>
											<input
												value={key}
												placeholder="shift+8"
												aria-label={t("botShinyBallsKey")}
												onChange={(e) => setShinyRow(i, name, e.target.value)}
											/>
											<button
												type="button"
												className="btn"
												title={t("botShinyBallsRemove")}
												aria-label={t("botShinyBallsRemove")}
												onClick={() => setShinyRows(shinyRows.filter((_, j) => j !== i))}
											>
												<FiX />
											</button>
										</div>
									))}
									<div className="bot-ball-row">
										<span className="bot-muted">{t("botShinyBallsOther")}</span>
										<input
											value={config.shinyBalls["*"] ?? ""}
											placeholder="shift+8"
											aria-label={t("botShinyBallsOther")}
											onChange={(e) => setShinyRows(shinyRows, e.target.value)}
										/>
									</div>
									<div>
										<button type="button" className="btn" onClick={() => setShinyRows([...shinyRows, ["", ""]])}>
											{t("botShinyBallsAdd")}
										</button>
									</div>
								</div>
								<p className="bot-muted">{t("botShinyBallsHint")}</p>
								<label className="bot-field">
									<span>{t("botClearBall")}</span>
									<input
										value={config.clearBall}
										placeholder="shift+5"
										onChange={(e) => edit({ clearBall: e.target.value })}
									/>
								</label>
								<p className="bot-muted">{t("botClearBallHint")}</p>
							</Section>
							<Section id="alarm" title={t("botSecAlarm")}>
								<label className="bot-check">
									<input
										type="checkbox"
										checked={config.alarmOn}
										onChange={(e) => edit({ alarmOn: e.target.checked })}
									/>
									<span>{t("botAlarmOn")}</span>
								</label>
								<label className="bot-field">
									<span>{t("botAlarmKeys")}</span>
									<input
										value={config.alarmKeys}
										placeholder="ctrl+l"
										onChange={(e) => edit({ alarmKeys: e.target.value })}
									/>
								</label>
								<label className="bot-field">
									<span>{t("botAlarmIgnore")}</span>
									<input value={config.alarmIgnore} onChange={(e) => edit({ alarmIgnore: e.target.value })} />
								</label>
								<p className="bot-muted">{t("botAlarmHint")}</p>
							</Section>
							{tab === "fishing" && (
								<Section id="fishing" title={t("botFishingSettings")}>
									<label className="bot-field">
										<span>{t("botRodKey")}</span>
										<input value={config.rodKey} onChange={(e) => edit({ rodKey: e.target.value })} />
									</label>
									{config.lure && (
										<label className="bot-field">
											<span>
												{t("botLureKey")} ({config.lure})
											</span>
											<input
												value={config.lureKeys[config.lure] ?? ""}
												placeholder="ctrl+shift+1"
												onChange={(e) => edit({ lureKeys: { ...config.lureKeys, [config.lure]: e.target.value } })}
											/>
										</label>
									)}
									<p className="bot-muted">{t("botLureHint")}</p>
									<label className="bot-field">
										<span>{t("botAntiIdleRange")}</span>
										<span className="bot-pair">
											<input
												type="number"
												min={0.5}
												max={30}
												step={0.5}
												value={config.antiIdle.min}
												onChange={(e) => edit({ antiIdle: { ...config.antiIdle, min: Number(e.target.value) } })}
											/>
											<input
												type="number"
												min={0.5}
												max={30}
												step={0.5}
												value={config.antiIdle.max}
												onChange={(e) => edit({ antiIdle: { ...config.antiIdle, max: Number(e.target.value) } })}
											/>
										</span>
									</label>
									<label className="bot-field">
										<span>{t("botAntiIdleModes")}</span>
										<input
											value={config.antiIdle.modes}
											onChange={(e) => edit({ antiIdle: { ...config.antiIdle, modes: e.target.value } })}
										/>
									</label>
								</Section>
							)}
							<Section id="advanced" title={t("botSecAdvanced")}>
								<label className="bot-field">
									<span>{t("botWindowTitle")}</span>
									<input value={config.windowTitle} onChange={(e) => edit({ windowTitle: e.target.value })} />
								</label>
								<label className="bot-check">
									<input
										type="checkbox"
										checked={config.llmFallback}
										onChange={(e) => edit({ llmFallback: e.target.checked })}
									/>
									<span>{t("botLlmFallback")}</span>
								</label>
								<label className="bot-check">
									<input
										type="checkbox"
										checked={config.shinyCheck}
										onChange={(e) => edit({ shinyCheck: e.target.checked })}
									/>
									<span>{t("botShinyCheck")}</span>
								</label>
							</Section>
						</div>
					)}
					<div className="bot-card">
						<div className="bot-card-head">
							<h3>{t("botLog")}</h3>
							<label className="bot-check bot-log-filter">
								<input
									type="checkbox"
									checked={warnOnly}
									onChange={(e) => {
										setWarnOnly(e.target.checked);
										storeFlag(LOG_KEY, e.target.checked);
									}}
								/>
								<span>{t("botLogWarnOnly")}</span>
							</label>
						</div>
						{logs.length === 0 ? (
							<p className="bot-muted">{t("botLogEmpty")}</p>
						) : (
							<ul className="bot-log">
								{logs.map((l, i) => (
									<li
										key={`${l.ts}-${i}`}
										className={l.level === "info" ? "" : l.level === "error" ? "bot-err" : "bot-warn"}
									>
										<time>{new Date(l.ts * 1000).toLocaleTimeString()}</time> {l.text}
									</li>
								))}
							</ul>
						)}
					</div>
				</section>
			</div>
		</div>
	);
}
