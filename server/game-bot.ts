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
import type { ServerMessage, UiBotAction, UiBotConfig, UiBotLogEntry, UiBotState } from "./protocol.js";

const MAX_LOGS = 120;
const MOVE_KEY = /^[1-9]$/;
const ANTI_IDLE_MODES = ["turn", "walk", "walk+turn"];
const ROD_KEY = /^(numpad[0-9]|[a-z0-9]|f(?:[1-9]|1[01]))$/;
/** Ball hotkeys: optional ctrl/shift modifiers + an allowlisted key, e.g. "shift+1". */
const HOTKEY = /^(?:(?:ctrl|shift)\+){0,2}(numpad[0-9]|[a-z0-9]|f(?:[1-9]|1[01]))$/;

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
	rodKey: "numpad0",
	pokemonSlot: 1,
	moves: ["1", "2"],
	moveIntervalS: 1.6,
	fightTimeoutS: 60,
	llmFallback: true,
	shinyCheck: true,
	antiIdle: { min: 3, max: 10, modes: "turn,walk,walk+turn" },
	ballPrimary: "",
	ballSecondary: "",
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
	if (o.spot === null) out.spot = null;
	else if (o.spot && typeof o.spot === "object") {
		const s = o.spot as Record<string, unknown>;
		const x = Number(s.x);
		const y = Number(s.y);
		if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1000 && y >= 0 && y <= 1000) {
			out.spot = { x: Math.round(x), y: Math.round(y) };
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
	for (const k of ["ballPrimary", "ballSecondary"] as const) {
		if (typeof o[k] !== "string") continue;
		const v = (o[k] as string).replace(/\s+/g, "").toLowerCase();
		if (v === "" || HOTKEY.test(v)) out[k] = v;
	}
	if (typeof o.shinyCheck === "boolean") out.shinyCheck = o.shinyCheck;
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
			this.live = { ...this.live, fishing: false, antiIdle: false, phase: "idle", reason: "" };
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
			case "error":
				this.addLog("error", String(ev.text ?? "error"));
				this.push();
				break;
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
		if (!this.available) return;
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
