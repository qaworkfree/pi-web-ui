import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_BOT_CONFIG,
	GameBotService,
	normalizeBotConfig,
	parseBotEvent,
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

	it("orders the anti-idle range and filters modes", () => {
		const c = normalizeBotConfig({ antiIdle: { min: 12, max: 4, modes: "walk, dance,TURN" } });
		expect(c.antiIdle).toEqual({ min: 4, max: 12, modes: "walk,turn" });
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
