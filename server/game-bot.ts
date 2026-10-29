/**
 * game-bot — server side of the BOT tab (opt-in local desktop automation).
 *
 * The tab drives a local game-control controller (`bot.py`) that only uses
 * screen capture and OS-level keyboard/mouse input on one game window: no
 * memory access, no injection, no network. It exists only when
 * `PI_WEB_GAME_CONTROL` points to that script; without it the tab is not drawn
 * and every bot message is refused, so a default install offers nothing.
 *
 * The controller is a child process speaking JSON lines: commands on stdin
 * (`{"cmd": ...}`), events on stdout (`{"event": ...}`). It is started lazily
 * by the first command and stopped with the server.
 *
 * Configuration (fishing spot, Pokemon slot, move keys, anti-idle range) is
 * the user's and lives in `<dataDir>/bot-settings.json` — the private data
 * directory, never the repository. Nothing about the character is stored.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { killPidTree } from "./process-utils.js";
import type {
	ServerMessage,
	UiBotAction,
	UiBotConfig,
	UiBotHuntState,
	UiBotLogEntry,
	UiBotRoute,
	UiBotRouteOp,
	UiBotState,
} from "./protocol.js";

const MAX_LOGS = 120;
const MOVE_KEY = /^[1-9]$/;
/** step = one step out and back (the simple default); turn, walk and walk+turn are the older routines. */
const ANTI_IDLE_MODES = ["step", "turn", "walk", "walk+turn"];
const ROD_KEY = /^(numpad[0-9]|[a-z0-9]|f(?:[1-9]|1[01]))$/;
/** Ball hotkeys: optional ctrl/shift modifiers + an allowlisted key, e.g. "shift+1". */
/** A Pokemon species name as typed in the BOT tab (lower case). */
const SPECIES = /^[a-z][a-z0-9 .'-]{0,30}$/;
/** Keys the alarm may press (the controller's allowlist: no Alt, F12 stays the kill switch). */
const ALARM_KEY =
	/^(?:(?:ctrl|shift)\+){0,2}(numpad[0-9]|[a-z0-9]|f(?:[1-9]|1[01])|up|down|left|right|space|enter|escape|tab|backspace|home|end|pageup|pagedown)$/;
const HOTKEY = /^(?:(?:ctrl|shift)\+){0,2}(numpad[0-9]|[a-z0-9]|f(?:[1-9]|1[01]))$/;
/** A hunt route name = its folder name: letters/digits first, then letters, digits, space . _ ( ) ' - (max 48). */
const ROUTE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()'-]{0,47}$/u;
const ROUTE_OPS: readonly UiBotRouteOp[] = [
	"list",
	"record_start",
	"record_waypoint",
	"record_stop",
	"record_cancel",
	"rename",
	"delete",
	"select",
];
/** Every bot_command the controller understands; anything else is dropped here instead of reaching it. */
export const BOT_ACTIONS: readonly UiBotAction[] = [
	"start",
	"stop",
	"status",
	"screenshot",
	"fish_start",
	"fish_stop",
	"anti_idle_start",
	"anti_idle_stop",
	"stop_all",
	"lure_attach",
	"lure_detach",
	"hunt_start",
	"hunt_stop",
	"hunt_resume",
	"hunt_back",
];
const MAX_ROUTES = 60;

/** Fishing lures and their default hotkeys (the user's hotbar; editable because it can differ by spot). */
export const DEFAULT_LURE_KEYS: Record<string, string> = {
	Worm: "ctrl+shift+1",
	Seaweed: "ctrl+shift+2",
	Fish: "ctrl+shift+3",
	Shrimp: "ctrl+shift+4",
	Kelp: "ctrl+shift+5",
	Steak: "ctrl+shift+6",
	"Misty's Special Lure": "ctrl+shift+7",
	"Special Lure": "ctrl+shift+8",
	"Big Steak": "ctrl+shift+9",
	"James Special Lure": "ctrl+shift+a",
	"Jessie Special Lure": "ctrl+shift+b",
	"Red Fish": "ctrl+shift+c",
	"Meowth Special Lure": "ctrl+shift+d",
	"Big Shrimp": "ctrl+shift+e",
};

export const DEFAULT_BOT_CONFIG: UiBotConfig = {
	windowTitle: "",
	spot: null,
	petSpot: null,
	rodKey: "numpad0",
	pokemonSlot: 1,
	moves: ["1", "2"],
	moveIntervalS: 1.6,
	attack: true,
	fightTimeoutS: 60,
	llmFallback: true,
	shinyCheck: true,
	antiIdle: { min: 8, max: 12, modes: "step" },
	ballPrimary: "",
	ballSecondary: "",
	shinyBalls: { tentacool: "shift+4", krabby: "shift+8", "*": "shift+8" },
	clearBall: "",
	huntRoute: "",
	routeMarkKey: "f9",
	alarmOn: false,
	alarmKeys: "",
	alarmIgnore: "",
	lure: "",
	lureKeys: { ...DEFAULT_LURE_KEYS },
};

function num(v: unknown, lo: number, hi: number, fallback: number): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** Clamp and sanitize a (partial) config against the current one. Pure; unit-tested. */
export function normalizeBotConfig(input: unknown, base: UiBotConfig = DEFAULT_BOT_CONFIG): UiBotConfig {
	const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const out: UiBotConfig = {
		...base,
		antiIdle: { ...base.antiIdle },
		moves: [...base.moves],
		lureKeys: { ...DEFAULT_LURE_KEYS, ...base.lureKeys },
	};
	if (typeof o.windowTitle === "string") out.windowTitle = o.windowTitle.trim().slice(0, 120);
	for (const k of ["spot", "petSpot"] as const) {
		const v = o[k];
		if (v === null) out[k] = null;
		else if (v && typeof v === "object") {
			const s = v as Record<string, unknown>;
			const x = Number(s.x);
			const y = Number(s.y);
			if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1000 && y >= 0 && y <= 1000) {
				out[k] = { x: Math.round(x), y: Math.round(y) };
			}
		}
	}
	if (typeof o.rodKey === "string" && ROD_KEY.test(o.rodKey.trim().toLowerCase()))
		out.rodKey = o.rodKey.trim().toLowerCase();
	if (o.pokemonSlot !== undefined) out.pokemonSlot = Math.round(num(o.pokemonSlot, 1, 6, base.pokemonSlot));
	if (Array.isArray(o.moves)) {
		const moves = o.moves.map(String).filter((m) => MOVE_KEY.test(m));
		if (moves.length) out.moves = [...new Set(moves)].slice(0, 9);
	}
	if (o.moveIntervalS !== undefined) out.moveIntervalS = num(o.moveIntervalS, 0.5, 10, base.moveIntervalS);
	if (o.fightTimeoutS !== undefined) out.fightTimeoutS = Math.round(num(o.fightTimeoutS, 10, 600, base.fightTimeoutS));
	if (typeof o.llmFallback === "boolean") out.llmFallback = o.llmFallback;
	if (typeof o.attack === "boolean") out.attack = o.attack;
	for (const k of ["ballPrimary", "ballSecondary", "clearBall", "routeMarkKey"] as const) {
		if (typeof o[k] !== "string") continue;
		const v = (o[k] as string).replace(/\s+/g, "").toLowerCase();
		if (v === "" || HOTKEY.test(v)) out[k] = v;
	}
	if (typeof o.huntRoute === "string") {
		const r = o.huntRoute === "" ? "" : normalizeRouteName(o.huntRoute);
		if (r !== null) out.huntRoute = r;
	}
	if (typeof o.shinyCheck === "boolean") out.shinyCheck = o.shinyCheck;
	if (typeof o.alarmOn === "boolean") out.alarmOn = o.alarmOn;
	if (typeof o.alarmKeys === "string") {
		out.alarmKeys = o.alarmKeys
			.split(",")
			.map((k) => k.replace(/\s+/g, "").toLowerCase())
			.filter((k) => ALARM_KEY.test(k))
			.slice(0, 6)
			.join(", ");
	}
	if (typeof o.alarmIgnore === "string") out.alarmIgnore = o.alarmIgnore.trim().slice(0, 40);
	if (o.shinyBalls && typeof o.shinyBalls === "object" && !Array.isArray(o.shinyBalls)) {
		// The whole table is replaced (rows can be removed); bad names or hotkeys are dropped.
		const balls: Record<string, string> = {};
		for (const [name, key] of Object.entries(o.shinyBalls as Record<string, unknown>).slice(0, 60)) {
			const n = name.trim().toLowerCase();
			const k = typeof key === "string" ? key.replace(/\s+/g, "").toLowerCase() : "";
			if ((n === "*" || SPECIES.test(n)) && HOTKEY.test(k)) balls[n] = k;
		}
		out.shinyBalls = balls;
	}
	if (o.lureKeys && typeof o.lureKeys === "object") {
		for (const [name, key] of Object.entries(o.lureKeys as Record<string, unknown>)) {
			if (!(name in DEFAULT_LURE_KEYS) || typeof key !== "string") continue; // known lures only
			const v = key.replace(/\s+/g, "").toLowerCase();
			if (HOTKEY.test(v)) out.lureKeys[name] = v;
		}
	}
	if (typeof o.lure === "string" && (o.lure === "" || o.lure in DEFAULT_LURE_KEYS)) out.lure = o.lure;
	if (o.antiIdle && typeof o.antiIdle === "object") {
		const a = o.antiIdle as Record<string, unknown>;
		const min = num(a.min, 0.5, 30, out.antiIdle.min);
		const max = num(a.max, 0.5, 30, out.antiIdle.max);
		out.antiIdle.min = Math.min(min, max);
		out.antiIdle.max = Math.max(min, max);
		if (typeof a.modes === "string") {
			const modes = a.modes
				.split(",")
				.map((m) => m.trim().toLowerCase())
				.filter((m) => ANTI_IDLE_MODES.includes(m));
			if (modes.length) out.antiIdle.modes = [...new Set(modes)].join(",");
		}
	}
	return out;
}

/** A route name as typed (trimmed, inner spaces collapsed) or null when it cannot be a folder name. Pure; unit-tested. */
export function normalizeRouteName(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const n = input.trim().replace(/\s+/g, " ");
	if (!ROUTE_NAME.test(n) || /[. ]$/.test(n) || n.includes("..")) return null;
	return n;
}

function finite(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : 0;
}

function count(v: unknown): number {
	return Math.max(0, Math.round(finite(v)));
}

/** The controller's route list (event "routes") → catalog rows; bad rows dropped, newest first. Pure; unit-tested. */
export function parseRoutes(input: unknown): UiBotRoute[] {
	if (!Array.isArray(input)) return [];
	const rows: UiBotRoute[] = [];
	for (const r of input.slice(0, MAX_ROUTES)) {
		if (!r || typeof r !== "object") continue;
		const o = r as Record<string, unknown>;
		const name = normalizeRouteName(o.name);
		if (!name) continue;
		const thumb = typeof o.thumb === "string" && /^[A-Za-z0-9+/=]{0,200000}$/.test(o.thumb) ? o.thumb : "";
		rows.push({
			name,
			waypoints: count(o.waypoints),
			steps: count(o.steps),
			// Older controllers do not say: let Start decide (it refuses a route without a minimap path).
			walkable: o.walkable !== false,
			created: finite(o.created),
			updated: finite(o.updated),
			thumb,
		});
	}
	return rows.sort((a, b) => b.updated - a.updated);
}

/** The controller's hunt block in its state event → UiBotHuntState (missing = idle). Pure; unit-tested. */
export function parseHunt(input: unknown): UiBotHuntState {
	const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const rec = o.recording && typeof o.recording === "object" ? (o.recording as Record<string, unknown>) : null;
	return {
		running: o.running === true,
		route: typeof o.route === "string" ? o.route : "",
		waypoint: count(o.waypoint),
		waypoints: count(o.waypoints),
		step: count(o.step),
		steps: count(o.steps),
		startedAt: finite(o.startedAt),
		stuck: o.stuck === true,
		recording: rec
			? {
					name: typeof rec.name === "string" ? rec.name : "",
					steps: count(rec.steps),
					tiles: count(rec.tiles),
					waypoints: count(rec.waypoints),
					startedAt: finite(rec.startedAt),
				}
			: null,
	};
}

/** One stdout line of the controller → a typed event, or null for noise. Pure; unit-tested. */
export function parseBotEvent(line: string): { event: string; [k: string]: unknown } | null {
	const s = line.trim();
	if (!s.startsWith("{")) return null;
	try {
		const v = JSON.parse(s) as unknown;
		if (v && typeof v === "object" && typeof (v as { event?: unknown }).event === "string") {
			return v as { event: string };
		}
	} catch {
		/* not a JSON event line */
	}
	return null;
}

/** The configured controller script, or null when the BOT feature is off. */
export function resolveBotScript(env: NodeJS.ProcessEnv = process.env): string | null {
	const p = (env.PI_WEB_GAME_CONTROL ?? "").trim();
	if (!p || !isAbsolute(p) || !p.toLowerCase().endsWith(".py") || !existsSync(p)) return null;
	return p;
}

export class GameBotService {
	readonly script: string | null;
	private readonly settingsPath: string;
	private config: UiBotConfig;
	private child: ChildProcess | null = null;
	private logs: UiBotLogEntry[] = [];
	private live: Record<string, unknown> = {};
	private routes: UiBotRoute[] = [];
	private lastError = "";

	constructor(
		dataDir: string,
		private readonly broadcast: (msg: ServerMessage) => void,
		env: NodeJS.ProcessEnv = process.env,
	) {
		this.script = resolveBotScript(env);
		this.settingsPath = join(dataDir, "bot-settings.json");
		this.config = this.load();
	}

	get available(): boolean {
		return this.script !== null;
	}

	private load(): UiBotConfig {
		try {
			if (existsSync(this.settingsPath)) {
				return normalizeBotConfig(JSON.parse(readFileSync(this.settingsPath, "utf8")) as unknown);
			}
		} catch {
			/* unreadable settings: start from defaults */
		}
		return { ...DEFAULT_BOT_CONFIG };
	}

	state(): UiBotState {
		const n = (k: string) => (typeof this.live[k] === "number" ? (this.live[k] as number) : 0);
		const b = (k: string) => this.live[k] === true;
		const s = (k: string) => (typeof this.live[k] === "string" ? (this.live[k] as string) : "");
		return {
			available: this.available,
			running: this.child !== null,
			fishing: b("fishing"),
			antiIdle: b("antiIdle"),
			halted: b("halted"),
			phase: s("phase") || "idle",
			reason: s("reason"),
			target: s("target"),
			lastResult: s("lastResult"),
			antiIdleNext: n("antiIdleNext"),
			antiIdleRuns: n("antiIdleRuns"),
			antiIdleLast: s("antiIdleLast"),
			stats: {
				casts: n("casts"),
				bites: n("bites"),
				challenges: n("challenges"),
				fights: n("fights"),
				shinies: n("shinies"),
				llm: n("llm"),
			},
			lure: {
				name: s("lureName") || this.config.lure,
				active: typeof this.live.lureActive === "boolean" ? this.live.lureActive : null,
			},
			hunt: parseHunt(this.live.hunt),
			routes: this.routes,
			config: this.config,
			logs: this.logs,
			error: this.lastError || undefined,
		};
	}

	private push(): void {
		this.broadcast({ type: "bot_state", state: this.state() });
	}

	private addLog(level: UiBotLogEntry["level"], text: string, ts = Date.now() / 1000): void {
		this.logs = [...this.logs, { ts, level, text: text.slice(0, 400) }].slice(-MAX_LOGS);
	}

	private ensureChild(): ChildProcess | null {
		if (this.child) return this.child;
		if (!this.script) return null;
		const uv = (process.env.PI_WEB_GAME_CONTROL_UV ?? "").trim() || "uv";
		const child = spawn(uv, ["run", "--script", this.script], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env: { ...process.env, PYTHONUTF8: "1" },
		});
		this.child = child;
		this.lastError = "";
		child.stdin?.on("error", () => {});
		child.stderr?.on("data", () => {}); // drain: a full stderr pipe would stall the controller
		child.on("error", (err) => {
			this.lastError = `Could not start the BOT controller: ${err.message}`;
			this.addLog("error", this.lastError);
		});
		child.on("exit", (code) => {
			if (this.child !== child) return;
			this.child = null;
			this.live = { ...this.live, fishing: false, antiIdle: false, phase: "idle", reason: "", hunt: undefined };
			this.addLog(code ? "error" : "info", `BOT controller stopped${code ? ` (exit ${code})` : ""}`);
			this.push();
		});
		createInterface({ input: child.stdout! }).on("line", (line) => {
			if (this.child !== child) return;
			this.onEvent(line);
		});
		this.send({ cmd: "configure", config: this.controllerConfig() });
		return child;
	}

	/** Config as sent to the controller; an empty window title keeps the controller's default. */
	private controllerConfig(): Record<string, unknown> {
		const { windowTitle, ...rest } = this.config;
		return windowTitle ? { ...rest, windowTitle } : rest;
	}

	private send(cmd: Record<string, unknown>): boolean {
		const c = this.child;
		if (!c?.stdin || c.stdin.destroyed) return false;
		c.stdin.write(JSON.stringify(cmd) + "\n");
		return true;
	}

	private onEvent(line: string): void {
		const ev = parseBotEvent(line);
		if (!ev) return;
		switch (ev.event) {
			case "state": {
				const { event: _event, config: _config, ...rest } = ev;
				this.live = rest;
				this.push();
				break;
			}
			case "log":
				this.addLog(
					ev.level === "warn" || ev.level === "error" ? ev.level : "info",
					String(ev.text ?? ""),
					typeof ev.ts === "number" ? ev.ts : undefined,
				);
				this.push();
				break;
			case "screenshot":
				if (typeof ev.data === "string") {
					this.broadcast({
						type: "bot_screenshot",
						data: ev.data,
						width: Number(ev.width) || 0,
						height: Number(ev.height) || 0,
					});
				}
				break;
			case "alert": {
				const text = `BOT: ${String(ev.text ?? "")}`;
				this.addLog("warn", text);
				this.broadcast({ type: "notice", level: "warning", text });
				this.push();
				break;
			}
			case "routes":
				this.routes = parseRoutes(ev.routes);
				this.push();
				break;
			case "error": {
				// A refused command (e.g. Start without a walkable route) must be seen, not only logged.
				const text = String(ev.text ?? "error");
				this.addLog("error", text);
				this.broadcast({ type: "notice", level: "warning", text: `BOT: ${text}` });
				this.push();
				break;
			}
			default:
				break;
		}
	}

	/** Pushes the current state to every client (used on attach and on request). */
	publish(): void {
		this.push();
	}

	saveConfig(partial: unknown): void {
		this.config = normalizeBotConfig(partial, this.config);
		writeJsonAtomicSync(this.settingsPath, this.config);
		this.send({ cmd: "configure", config: this.controllerConfig() });
		this.push();
	}

	command(action: UiBotAction): void {
		if (!this.available || !BOT_ACTIONS.includes(action)) return;
		if (action === "status" && !this.child) {
			this.push();
			return;
		}
		if (!this.ensureChild()) {
			this.push();
			return;
		}
		this.send({ cmd: action });
	}

	/** Route catalog / recorder (bot_route). Names are validated here; the controller owns the files. */
	route(op: unknown, name?: unknown, newName?: unknown): void {
		if (!this.available || typeof op !== "string" || !ROUTE_OPS.includes(op as UiBotRouteOp)) return;
		const needsName = op === "record_start" || op === "rename" || op === "delete" || op === "select";
		const n = needsName ? normalizeRouteName(name) : null;
		const nn = op === "rename" ? normalizeRouteName(newName) : null;
		if ((needsName && !n) || (op === "rename" && !nn)) {
			this.addLog("warn", "Route name not allowed: use letters, digits, spaces, . _ ( ) ' - (max 48)");
			this.push();
			return;
		}
		// The selected route follows a rename and is cleared by a delete.
		const selected =
			op === "select" && n
				? n
				: op === "rename" && n === this.config.huntRoute && nn
					? nn
					: op === "delete" && n === this.config.huntRoute
						? ""
						: null;
		if (selected !== null) {
			this.config = normalizeBotConfig({ huntRoute: selected }, this.config);
			writeJsonAtomicSync(this.settingsPath, this.config);
		}
		if (!this.ensureChild()) {
			this.push();
			return;
		}
		if (selected !== null) this.send({ cmd: "configure", config: this.controllerConfig() });
		this.send({ cmd: "route", op, ...(n ? { name: n } : {}), ...(nn ? { newName: nn } : {}) });
		this.push();
	}

	async dispose(): Promise<void> {
		const c = this.child;
		this.child = null;
		if (!c) return;
		try {
			c.stdin?.write(JSON.stringify({ cmd: "stop_all" }) + "\n");
			c.stdin?.end();
		} catch {
			/* already gone */
		}
		if (c.pid) await killPidTree(c.pid);
	}
}
