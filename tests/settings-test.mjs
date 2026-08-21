// Settings feature — protocol smoke test (no model calls).
//
// Verifies the full wire path for the settings panel: settings_state pushed on
// attach / get_settings / set_settings (prompt append+replace, skill and
// extension toggles) / save_preset / apply_preset / delete_preset, plus
// per-client persistence across a reconnect.
//
// Runs against the compiled server on a dedicated port (8931). With an
// isolated fake agent dir (PI_CODING_AGENT_DIR → temp) it exercises the
// protocol only; point it at a real agent dir to also exercise the
// skill/extension toggle round-trip (see settings-live flow in git history).
// Usage: npm run build && node settings-test.mjs [port]
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.argv[2] || 8931);
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-web-set-test-"));
console.log("data-dir:", DATA_DIR);

const server = spawn(process.execPath, ["dist/server/index.js"], {
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: DATA_DIR,
		PI_WEB_CWD: process.cwd(),
		PI_CODING_AGENT_DIR: join(DATA_DIR, "agent"),
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv-err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		ws.on("message", (d) => this.received.push(JSON.parse(d.toString())));
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	/** Wait for a message; optional predicate. A set_settings pushes
	 *  settings_state twice (immediately + after the reload), so stale
	 *  duplicates are consumed while scanning. */
	async waitFor(type, timeout = 8000, pred) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (m.type !== type) continue;
				this.received.splice(i, 1);
				if (!pred || pred(m)) return m;
				i--;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
}

async function connect() {
	for (let i = 0; i < 60; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((res, rej) => {
				ws.on("open", res);
				ws.on("error", rej);
			});
			return new Client(ws);
		} catch {
			await sleep(500);
		}
	}
	throw new Error("server not ready");
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name} ${extra}`);
	}
}

let c;
try {
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor("snapshot");
	const st0 = await c.waitFor("settings_state");
	check("settings_state pushed on attach", !!st0.settings);
	check("has skills array", Array.isArray(st0.settings.skills));
	check("has extensions array", Array.isArray(st0.settings.extensions));
	check("has presets array", Array.isArray(st0.settings.presets));
	check("default promptMode=append", st0.settings.promptMode === "append");
	check(
		"settings_state carries built-in default prompts",
		typeof st0.settings.defaultSystemPrompt === "string" &&
			typeof st0.settings.visionBridgeDefaultPrompt === "string" &&
			st0.settings.visionBridgeDefaultPrompt.length > 0,
	);
	console.log(`  skills=${st0.settings.skills.length} extensions=${st0.settings.extensions.length}`);

	c.send({ type: "get_settings" });
	const st1 = await c.waitFor("settings_state");
	check("get_settings echoes state", st1.settings.promptMode === "append");

	// append prompt, then save it as a preset
	c.send({ type: "set_settings", promptMode: "append", customSystemPrompt: "你是一个测试助手。" });
	const st2 = await c.waitFor("settings_state", 8000, (m) => m.settings.customSystemPrompt === "你是一个测试助手。");
	check("append prompt persisted", st2.settings.customSystemPrompt === "你是一个测试助手。");

	c.send({ type: "save_preset", name: "测试预设" });
	const st6 = await c.waitFor("settings_state", 8000, (m) => m.settings.presets.some((p) => p.name === "测试预设"));
	check("preset saved", st6.settings.presets.some((p) => p.name === "测试预设"));

	// replace prompt
	c.send({ type: "set_settings", promptMode: "replace", customSystemPrompt: "你是替换提示词。" });
	const st2b = await c.waitFor("settings_state", 8000, (m) => m.settings.promptMode === "replace");
	check("promptMode replace persisted", st2b.settings.promptMode === "replace");
	c.send({ type: "set_settings", promptMode: "append" });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptMode === "append");

	// skill toggle
	const skillName = st0.settings.skills[0]?.name;
	if (skillName) {
		c.send({ type: "set_settings", disabledSkills: [skillName] });
		const st3 = await c.waitFor("settings_state", 8000, (m) => m.settings.disabledSkills.includes(skillName));
		check("skill disabled", st3.settings.disabledSkills.includes(skillName));
		const s = st3.settings.skills.find((x) => x.name === skillName);
		check("disabled skill still listed (re-enableable)", s && !s.enabled);
		c.send({ type: "set_settings", disabledSkills: [] });
		const st4 = await c.waitFor("settings_state", 8000, (m) => m.settings.disabledSkills.length === 0);
		check("skill re-enabled", st4.settings.skills.find((x) => x.name === skillName)?.enabled === true);
	} else {
		console.log("  (no skills loaded — skipping)");
	}

	// extension toggle
	const extId = st0.settings.extensions[0]?.id;
	if (extId) {
		c.send({ type: "set_settings", disabledExtensions: [extId] });
		const st5 = await c.waitFor("settings_state", 8000, (m) => m.settings.disabledExtensions.includes(extId));
		check("extension disabled", st5.settings.disabledExtensions.includes(extId));
		const e = st5.settings.extensions.find((x) => x.id === extId);
		check("disabled extension still listed", e && !e.enabled);
		c.send({ type: "set_settings", disabledExtensions: [] });
		await c.waitFor("settings_state", 8000, (m) => m.settings.disabledExtensions.length === 0);
		check("extension re-enabled", true);
	} else {
		console.log("  (no extensions loaded — skipping)");
	}

	// apply preset → restores append/你好
	c.send({ type: "set_settings", customSystemPrompt: "临时内容" });
	await c.waitFor("settings_state", 8000, (m) => m.settings.customSystemPrompt === "临时内容");
	c.send({ type: "apply_preset", name: "测试预设" });
	const st7 = await c.waitFor("settings_state", 8000, (m) => m.settings.customSystemPrompt === "你是一个测试助手。");
	check("preset applied (prompt restored)", st7.settings.customSystemPrompt === "你是一个测试助手。");
	check("preset applied (mode restored)", st7.settings.promptMode === "append");

	c.send({ type: "delete_preset", name: "测试预设" });
	const st8 = await c.waitFor("settings_state", 8000, (m) => !m.settings.presets.some((p) => p.name === "测试预设"));
	check("preset deleted", !st8.settings.presets.some((p) => p.name === "测试预设"));

	// persistence across reconnect
	c.ws.close();
	await sleep(300);
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor("snapshot");
	const st9 = await c.waitFor("settings_state");
	check("prompt survives reconnect", st9.settings.customSystemPrompt === "你是一个测试助手。");
	c.ws.close();

	console.log(`\n${pass} passed, ${fail} failed`);
} catch (err) {
	console.error("TEST ERROR:", err.message);
	fail++;
} finally {
	server.kill("SIGTERM");
	await sleep(300);
}
process.exit(fail > 0 ? 1 : 0);
