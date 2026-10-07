// Opt-in real llama.cpp router + authenticated browser check. Sends no inference request.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const runtime = resolve(process.env.PI_RUNTIME_REPO || "../pipipiPopopo");
const llama = process.env.WORKFREE_LLAMA_SERVER;
const files = JSON.parse(process.env.WORKFREE_TEST_GGUFS || "[]");
assert(
	llama && files.length >= 2,
	"Set WORKFREE_LLAMA_SERVER and WORKFREE_TEST_GGUFS (JSON array of >=2 existing GGUF paths)",
);
const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pi-local-context-"));
const modelsDir = join(temp, "models");
mkdirSync(modelsDir);
const project = join(temp, "project");
mkdirSync(project);
const profilePath = join(temp, "profiles.json");
const helper = join(runtime, "scripts/local-model-profiles.mjs");
for (const file of files) symlinkSync(resolve(file), join(modelsDir, basename(file)), "file");
const prepared = spawnSync(process.execPath, [helper, "prepare", profilePath, modelsDir], { encoding: "utf8" });
assert.equal(prepared.status, 0, prepared.stderr);
const profiles = JSON.parse(prepared.stdout);
const processes = [];
let output = "";
function start(executable, args, extraEnv = {}) {
	const child = spawn(executable, args, {
		cwd: root,
		env: { ...process.env, ...extraEnv },
		stdio: ["ignore", "pipe", "pipe"],
	});
	processes.push(child);
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	return child;
}
async function ready(url, child) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null) throw new Error(`Service exited: ${output}`);
		try {
			if ((await fetch(url)).ok) return;
		} catch {
			/* starting */
		}
		await delay(100);
	}
	throw new Error(`Readiness timeout: ${output}`);
}
const routerPort = 8991,
	proxyPort = 8992,
	uiPort = 8993;
const routerUrl = `http://127.0.0.1:${routerPort}`,
	uiUrl = `http://127.0.0.1:${uiPort}`;
const requests = [];
let latestState = {};
const proxy = createServer(async (req, res) => {
	requests.push({ method: req.method, path: req.url });
	if (req.method !== "GET") {
		res.writeHead(405);
		res.end("Metadata only");
		return;
	}
	try {
		const response = await fetch(`${routerUrl}${req.url}`);
		res.writeHead(response.status, { "content-type": "application/json" });
		res.end(await response.text());
	} catch {
		res.writeHead(502);
		res.end();
	}
});
let browser;
let page;
try {
	const routerEnv = {};
	for (const key of Object.keys(process.env)) if (key.startsWith("LLAMA_ARG_")) routerEnv[key] = "";
	const router = start(
		llama,
		[
			"--models-preset",
			profiles.presetPath,
			"--models-max",
			"1",
			"--models-autoload",
			"--jinja",
			"--host",
			"127.0.0.1",
			"--port",
			String(routerPort),
			"--parallel",
			"1",
			"--n-gpu-layers",
			"0",
			"--threads",
			"2",
		],
		routerEnv,
	);
	await ready(`${routerUrl}/health`, router);
	await new Promise((resolveListen, reject) => {
		proxy.once("error", reject);
		proxy.listen(proxyPort, "127.0.0.1", resolveListen);
	});
	const password = randomBytes(18).toString("hex");
	const ui = start(process.execPath, ["--import", "./dist/server/resolve-global-sdk.js", "dist/server/index.js"], {
		PI_WEB_PORT: String(uiPort),
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_DATA_DIR: join(temp, "data"),
		PI_CODING_AGENT_DIR: join(temp, "agent"),
		PI_WEB_CWD: project,
		PI_WEB_SDK: "global",
		PI_WEB_SDK_DIR: join(runtime, "packages/coding-agent"),
		LLAMA_BASE_URL: `http://127.0.0.1:${proxyPort}`,
		PI_WEB_AUTH_USERNAME: "validation",
		PI_WEB_AUTH_PASSWORD: password,
		PI_WEB_TOKEN: "",
		PI_WEB_PLUGIN_CATALOG_URL: "off",
		PI_WEB_LOCAL_MODEL_PROFILES: profilePath,
		PI_WEB_LOCAL_MODEL_PROFILE_SCRIPT: helper,
	});
	await ready(`${uiUrl}/api/health`, ui);
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
	page.on("websocket", (socket) =>
		socket.on("framereceived", ({ payload }) => {
			try {
				const event = JSON.parse(String(payload));
				if (event.type === "snapshot") latestState = event.state;
				else if (event.type === "snapshot_delta") latestState = { ...latestState, ...event.state };
			} catch {
				/* non-JSON keepalive */
			}
		}),
	);
	await page.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	await page.goto(uiUrl);
	await page.getByRole("textbox", { name: "Username", exact: true }).fill("validation");
	await page.getByLabel("Password", { exact: true }).fill(password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.waitForSelector(".chip-model");
	await page.locator(".chip-model").first().click();
	await page.locator(".dd-item").filter({ hasText: profiles.models[0].name }).click();
	await page.locator(".chip-model").first().click();
	await page.locator(".dd-refresh", { hasText: "Manage models" }).click();
	await page.waitForSelector(".model-studio-modal");
	await page.locator(".studio-sidebar-section").first().locator(".studio-nav-item", { hasText: "llama.cpp" }).click();
	await page.waitForFunction(
		(count) => document.querySelectorAll(".model-matrix-card").length === count,
		profiles.models.length,
	);
	for (const model of profiles.models) {
		const row = page.locator(".model-matrix-card").filter({ has: page.locator(`input[value="${model.id}"]`) });
		assert((await row.textContent()).includes(`GGUF limit: ${model.contextLimit} tokens`));
		const options = await row
			.locator(".spec-combobox-select")
			.first()
			.locator("option")
			.evaluateAll((entries) => entries.map((entry) => entry.value));
		assert(options.filter((value) => value !== "custom").every((value) => Number(value) <= model.contextLimit));
	}
	const first = profiles.models[0];
	const selected = first.contextWindow === 2048 ? 1024 : 2048;
	const row = page.locator(".model-matrix-card").filter({ has: page.locator(`input[value="${first.id}"]`) });
	await row.locator(".spec-combobox-select").first().selectOption(String(selected));
	await page.getByRole("button", { name: "Save", exact: true }).click();
	for (let attempt = 0; attempt < 100; attempt++) {
		if (JSON.parse(readFileSync(profilePath, "utf8")).models[0].contextWindow === selected) break;
		await delay(100);
	}
	const saved = JSON.parse(readFileSync(profilePath, "utf8"));
	assert.equal(saved.models[0].contextWindow, selected);
	for (let attempt = 0; attempt < 100 && latestState.stats?.contextUsage?.contextWindow !== selected; attempt++)
		await delay(100);
	assert.equal(
		latestState.stats?.contextUsage?.contextWindow,
		selected,
		"Existing idle conversation adopts selected context",
	);
	assert.equal(
		saved.models[1].contextWindow,
		profiles.models[1].contextWindow,
		"Other model choice remains independent",
	);
	let catalog;
	for (let attempt = 0; attempt < 50; attempt++) {
		catalog = await (await fetch(`${routerUrl}/models?reload=1`)).json();
		const entry = catalog.data.find((model) => model.id === first.id);
		const args = entry?.status?.args || [];
		const position = args.findIndex((arg) => arg === "--ctx-size" || arg === "-c");
		if (args[position + 1] === String(selected)) break;
		await delay(100);
	}
	const entry = catalog.data.find((model) => model.id === first.id);
	const args = entry.status.args,
		index = args.findIndex((arg) => arg === "--ctx-size" || arg === "-c");
	assert.equal(args[index + 1], String(selected), "Actual router child preset uses saved context");
	assert(
		catalog.data.every((model) => model.status.value === "unloaded"),
		"No model weights loaded",
	);
	assert(requests.length > 0 && requests.every((request) => request.method === "GET"), "UI made metadata GETs only");
	assert.deepEqual(
		readdirSync(project).filter((name) => name !== ".pi"),
		[],
		"No unsolicited project files",
	);
	console.log(
		`PASS: ${profiles.models.length} actual GGUF limits, authenticated browser controls, independent saved context, router preset ${selected}, ${requests.length} metadata GETs, zero inference/loaded weights.`,
	);
} catch (error) {
	console.error(
		await page
			?.locator(".model-studio-modal")
			.innerText()
			.catch(() => "No modal"),
	);
	console.error(output.slice(-7000));
	throw error;
} finally {
	await browser?.close();
	await new Promise((done) => proxy.close(done));
	for (const child of processes.reverse()) {
		if (child.exitCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
	}
	rmSync(temp, { recursive: true, force: true });
}
