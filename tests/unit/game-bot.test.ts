import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_BOT_CONFIG,
	GameBotService,
	normalizeBotConfig,
	normalizeRouteName,
	parseBotEvent,
	parseHunt,
	parseRoutes,
	resolveBotScript,
} from "../../server/game-bot";
import type { ServerMessage } from "../../server/protocol";

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "game-bot-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("normalizeBotConfig", () => {
	it("keeps defaults for garbage input", () => {
		expect(normalizeBotConfig(null)).toEqual(DEFAULT_BOT_CONFIG);
		expect(normalizeBotConfig("x")).toEqual(DEFAULT_BOT_CONFIG);
	});

	it("accepts a spot on the 0-1000 scale only", () => {
		expect(normalizeBotConfig({ spot: { x: 452.4, y: 556.6 } }).spot).toEqual({ x: 452, y: 557 });
		expect(normalizeBotConfig({ spot: { x: 1200, y: 10 } }).spot).toBeNull();
		const base = normalizeBotConfig({ spot: { x: 1, y: 2 } });
		expect(normalizeBotConfig({ spot: null }, base).spot).toBeNull();
		expect(normalizeBotConfig({}, base).spot).toEqual({ x: 1, y: 2 });
	});

	it("clamps numbers and filters keys", () => {
		const c = normalizeBotConfig({
			pokemonSlot: 9,
			moves: ["2", "x", "2", "10", "5"],
			rodKey: "Alt",
			fightTimeoutS: 1,
			moveIntervalS: 99,
		});
		expect(c.pokemonSlot).toBe(6);
		expect(c.moves).toEqual(["2", "5"]);
		expect(c.rodKey).toBe("numpad0");
		expect(c.fightTimeoutS).toBe(10);
		expect(c.moveIntervalS).toBe(10);
		expect(normalizeBotConfig({ rodKey: "NumPad3" }).rodKey).toBe("numpad3");
	});

	it("accepts only allowlisted ball hotkeys", () => {
		const c = normalizeBotConfig({ ballPrimary: " Shift + 1 ", ballSecondary: "ctrl+shift+F5" });
		expect(c.ballPrimary).toBe("shift+1");
		expect(c.ballSecondary).toBe("ctrl+shift+f5");
		expect(normalizeBotConfig({ ballPrimary: "alt+1" }, c).ballPrimary).toBe("shift+1");
		expect(normalizeBotConfig({ ballPrimary: "f12" }, c).ballPrimary).toBe("shift+1");
		expect(normalizeBotConfig({ ballPrimary: "" }, c).ballPrimary).toBe("");
	});

	it("keeps the stranger alarm off by default and only allowlisted alarm keys", () => {
		const d = normalizeBotConfig({});
		expect([d.alarmOn, d.alarmKeys, d.alarmIgnore]).toEqual([false, "", ""]);
		const c = normalizeBotConfig({
			alarmOn: true,
			alarmKeys: "Ctrl + L, alt+f4, enter, f12",
			alarmIgnore: "  Emy Sushi ",
		});
		expect([c.alarmOn, c.alarmKeys, c.alarmIgnore]).toEqual([true, "ctrl+l, enter", "Emy Sushi"]);
	});

	it("keeps a per-species shiny ball table, replaced as a whole, with valid names and hotkeys only", () => {
		expect(normalizeBotConfig({}).shinyBalls).toEqual({ tentacool: "shift+4", krabby: "shift+8", "*": "shift+8" });
		const c = normalizeBotConfig({
			shinyBalls: { " Staryu ": "Shift + 3", "*": "shift+8", "": "shift+1", "bad<name>": "shift+2", krabby: "alt+9" },
		});
		expect(c.shinyBalls).toEqual({ staryu: "shift+3", "*": "shift+8" });
		expect(normalizeBotConfig({ shinyBalls: ["x"] }).shinyBalls).toEqual(DEFAULT_BOT_CONFIG.shinyBalls);
	});

	it("attacks by default and keeps an explicit attack switch (booleans only)", () => {
		expect(normalizeBotConfig({}).attack).toBe(true);
		expect(normalizeBotConfig({ attack: false }).attack).toBe(false);
		expect(normalizeBotConfig({ attack: "no" }).attack).toBe(true);
		expect(normalizeBotConfig({ attack: true }, { ...DEFAULT_BOT_CONFIG, attack: false }).attack).toBe(true);
	});

	it("keeps the lure list, accepts known lures and allowlisted lure hotkeys only", () => {
		const d = normalizeBotConfig({});
		expect(d.lure).toBe("");
		expect(d.lureKeys.Worm).toBe("ctrl+shift+1");
		expect(d.lureKeys["Big Shrimp"]).toBe("ctrl+shift+e");
		expect(Object.keys(d.lureKeys)).toHaveLength(14);
		const c = normalizeBotConfig({ lure: "Kelp", lureKeys: { Kelp: "Ctrl + Shift + 9", Worm: "alt+1", Bogus: "f1" } });
		expect(c.lure).toBe("Kelp");
		expect(c.lureKeys.Kelp).toBe("ctrl+shift+9");
		expect(c.lureKeys.Worm).toBe("ctrl+shift+1"); // alt is not allowed: unchanged
		expect("Bogus" in c.lureKeys).toBe(false);
		expect(normalizeBotConfig({ lure: "Nope" }, c).lure).toBe("Kelp");
		expect(normalizeBotConfig({ lure: "" }, c).lure).toBe("");
	});

	it("orders the anti-idle range and filters modes", () => {
		const c = normalizeBotConfig({ antiIdle: { min: 12, max: 4, modes: "walk, dance,TURN" } });
		expect(c.antiIdle).toEqual({ min: 4, max: 12, modes: "walk,turn" });
		expect(normalizeBotConfig({}).antiIdle).toEqual({ min: 8, max: 12, modes: "step" });
		expect(normalizeBotConfig({ antiIdle: { min: 8, max: 12, modes: "STEP" } }).antiIdle.modes).toBe("step");
	});
});

describe("parseBotEvent", () => {
	it("parses event lines and ignores noise", () => {
		expect(parseBotEvent('{"event":"log","text":"hi"}')).toEqual({ event: "log", text: "hi" });
		expect(parseBotEvent("Installed 29 packages")).toBeNull();
		expect(parseBotEvent('{"no":"event"}')).toBeNull();
		expect(parseBotEvent("{broken")).toBeNull();
	});
});

describe("resolveBotScript / GameBotService", () => {
	it("is off unless PI_WEB_GAME_CONTROL names an existing absolute .py file", () => {
		const d = tmp();
		const script = join(d, "bot.py");
		writeFileSync(script, "");
		expect(resolveBotScript({})).toBeNull();
		expect(resolveBotScript({ PI_WEB_GAME_CONTROL: "bot.py" })).toBeNull();
		expect(resolveBotScript({ PI_WEB_GAME_CONTROL: join(d, "missing.py") })).toBeNull();
		expect(resolveBotScript({ PI_WEB_GAME_CONTROL: join(d, "notes.txt") })).toBeNull();
		expect(resolveBotScript({ PI_WEB_GAME_CONTROL: script })).toBe(script);
	});

	it("persists normalized settings in the data dir and broadcasts state", () => {
		const d = tmp();
		const sent: ServerMessage[] = [];
		const svc = new GameBotService(d, (m) => sent.push(m), {});
		expect(svc.available).toBe(false);
		svc.saveConfig({ spot: { x: 10, y: 20 }, pokemonSlot: 2 });
		const saved = JSON.parse(readFileSync(join(d, "bot-settings.json"), "utf8"));
		expect(saved.spot).toEqual({ x: 10, y: 20 });
		expect(saved.pokemonSlot).toBe(2);
		const last = sent.at(-1);
		expect(last?.type).toBe("bot_state");
		if (last?.type === "bot_state") {
			expect(last.state.available).toBe(false);
			expect(last.state.config.spot).toEqual({ x: 10, y: 20 });
		}
		// A new service reads the same file back.
		expect(new GameBotService(d, () => {}, {}).state().config.pokemonSlot).toBe(2);
	});

	it("does not start anything when unavailable", () => {
		const sent: ServerMessage[] = [];
		const svc = new GameBotService(tmp(), (m) => sent.push(m), {});
		svc.command("fish_start");
		expect(svc.state().running).toBe(false);
		expect(sent).toEqual([]);
	});
});

describe("hunt routes", () => {
	it("accepts place names and refuses anything that is not a safe folder name", () => {
		expect(normalizeRouteName("  Cerulean   cave 1F ")).toBe("Cerulean cave 1F");
		expect(normalizeRouteName("Caverna (São Paulo) - 2")).toBe("Caverna (São Paulo) - 2");
		for (const bad of ["", " ", "../x", "a/b", "a\\b", "x.", ".hidden", "con:", "a".repeat(49), 5, null]) {
			expect(normalizeRouteName(bad), String(bad)).toBeNull();
		}
	});

	it("parses the controller's route list, newest first, dropping bad rows", () => {
		const rows = parseRoutes([
			{ name: "Old", waypoints: 2, steps: 10, created: 1, updated: 5, thumb: "abc=" },
			{ name: "../evil", waypoints: 1 },
			{ name: "New", waypoints: "3", steps: -4, created: 2, updated: 9, thumb: "<script>" },
			"junk",
		]);
		expect(rows.map((r) => r.name)).toEqual(["New", "Old"]);
		expect(rows[0]).toMatchObject({ waypoints: 3, steps: 0, thumb: "" });
		expect(rows[1].thumb).toBe("abc=");
		expect(parseRoutes("nope")).toEqual([]);
	});

	it("parses the hunt block, idle when missing", () => {
		expect(parseHunt(undefined)).toEqual({
			running: false,
			route: "",
			waypoint: 0,
			waypoints: 0,
			stuck: false,
			recording: null,
		});
		expect(
			parseHunt({
				running: true,
				route: "Cave",
				waypoint: 2,
				waypoints: 5,
				stuck: true,
				recording: { name: "Cave", steps: 7, waypoints: 1, startedAt: 100 },
			}),
		).toMatchObject({ running: true, waypoint: 2, stuck: true, recording: { steps: 7, waypoints: 1 } });
	});

	it("normalizes the hunt and clear-ball settings", () => {
		const c = normalizeBotConfig({ clearBall: " Shift+5 ", huntRoute: "Cave 1", routeMarkKey: "F9" });
		expect(c).toMatchObject({ clearBall: "shift+5", huntRoute: "Cave 1", routeMarkKey: "f9" });
		const bad = normalizeBotConfig({ clearBall: "alt+5", huntRoute: "../x", routeMarkKey: "f12" }, c);
		expect(bad).toMatchObject({ clearBall: "shift+5", huntRoute: "Cave 1", routeMarkKey: "f9" });
		expect(normalizeBotConfig({ huntRoute: "", clearBall: "" }, c)).toMatchObject({ huntRoute: "", clearBall: "" });
	});

	it("refuses route operations when the BOT is unavailable", () => {
		const sent: ServerMessage[] = [];
		const svc = new GameBotService(tmp(), (m) => sent.push(m), {});
		svc.route("record_start", "Cave");
		svc.route("delete", "Cave");
		expect(svc.state().running).toBe(false);
		expect(sent).toEqual([]);
	});
});
