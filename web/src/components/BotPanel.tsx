import { useEffect, useState, type MouseEvent } from "react";
import { FiCamera, FiPlay, FiSquare, FiSave } from "react-icons/fi";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import type { UiBotAction, UiBotConfig } from "../types";
import type { ChatState } from "../use-chat";

/**
 * BOT tab: drives the local game-control controller (server/game-bot.ts) —
 * auto-fishing with a scripted fight and an anti-AFK keeper. Offered only when
 * the server has PI_WEB_GAME_CONTROL configured. The fishing spot is picked by
 * clicking the game screenshot; settings are stored server-side in the private
 * data dir.
 */
export function BotPanel({ chat }: { chat: ChatState }) {
	const t = useT();
	const state = chat.botState;
	const shot = chat.botShot;
	const [draft, setDraft] = useState<UiBotConfig | null>(null);
	const config = draft ?? state?.config ?? null;

	useEffect(() => {
		appSend({ type: "bot_command", action: "status" });
		if (!chat.botShot) appSend({ type: "bot_command", action: "screenshot" });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once on open
	}, []);

	if (!chat.bot) {
		return (
			<div className="bot-panel">
				<p className="bot-muted">{t("botUnavailable")}</p>
			</div>
		);
	}

	const run = (action: UiBotAction) => appSend({ type: "bot_command", action });
	const save = (partial: Partial<UiBotConfig>) => appSend({ type: "bot_save_config", config: partial });
	const edit = (patch: Partial<UiBotConfig>) => config && setDraft({ ...config, ...patch });

	const pickSpot = (e: MouseEvent<HTMLImageElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		const x = Math.round(((e.clientX - r.left) / r.width) * 1000);
		const y = Math.round(((e.clientY - r.top) / r.height) * 1000);
		save({ spot: { x, y } });
	};

	const spot = state?.config.spot ?? null;
	const running = Boolean(state?.fishing || state?.antiIdle);
	const nextMin =
		state?.antiIdle && state.antiIdleNext
			? Math.max(0, (state.antiIdleNext - Date.now() / 1000) / 60).toFixed(1)
			: null;
	const logs = [...(state?.logs ?? [])].reverse();

	return (
		<div className="bot-panel">
			<div className="bot-head">
				<h2>{t("botTitle")}</h2>
				<span className="bot-muted">{t("botSafety")}</span>
			</div>
			<div className="bot-body">
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
						</div>
					) : (
						<p className="bot-muted">{t("botNoShot")}</p>
					)}
					<div className="bot-row">
						<button type="button" className="btn" onClick={() => run("screenshot")}>
							<FiCamera /> {t("botRefreshShot")}
						</button>
						<span className="bot-muted">
							{t("botSpot")}: {spot ? `${spot.x}, ${spot.y}` : t("botSpotNone")} — {t("botSpotHint")}
						</span>
					</div>
				</section>

				<section className="bot-side">
					<div className="bot-card">
						<h3>{t("botStatus")}</h3>
						<p>
							<strong>{state?.phase ?? "idle"}</strong>
							{state?.reason ? ` — ${state.reason}` : ""}
						</p>
						{state?.halted && <p className="bot-warn">{t("botHalted")}</p>}
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

					<div className="bot-card">
						<h3>
							{t("botFishing")} + {t("botAntiIdle")}
						</h3>
						<div className="bot-row">
							{running ? (
								<button type="button" className="btn" onClick={() => run("stop")}>
									<FiSquare /> {t("botStop")}
								</button>
							) : (
								<button type="button" className="btn primary" disabled={!spot} onClick={() => run("start")}>
									<FiPlay /> {t("botStart")}
								</button>
							)}
							{nextMin !== null && <span className="bot-muted">{t("botNextRoutine", { min: nextMin })}</span>}
						</div>
						{state?.antiIdleLast && <p className="bot-muted">{state.antiIdleLast}</p>}
					</div>

					{config && (
						<div className="bot-card">
							<h3>{t("botSettings")}</h3>
							<label className="bot-field">
								<span>{t("botWindowTitle")}</span>
								<input value={config.windowTitle} onChange={(e) => edit({ windowTitle: e.target.value })} />
							</label>
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
								<span>{t("botRodKey")}</span>
								<input value={config.rodKey} onChange={(e) => edit({ rodKey: e.target.value })} />
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
							<div className="bot-row">
								<button
									type="button"
									className="btn primary"
									disabled={!draft}
									onClick={() => {
										if (draft) save(draft);
										setDraft(null);
									}}
								>
									<FiSave /> {t("botSave")}
								</button>
							</div>
						</div>
					)}

					<div className="bot-card">
						<h3>{t("botLog")}</h3>
						<ul className="bot-log">
							{logs.map((l, i) => (
								<li key={`${l.ts}-${i}`} className={l.level === "info" ? "" : "bot-warn"}>
									<time>{new Date(l.ts * 1000).toLocaleTimeString()}</time> {l.text}
								</li>
							))}
						</ul>
					</div>
				</section>
			</div>
		</div>
	);
}
