// Real browser layout regression with disposable state and no model requests.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pi-mobile-layout-"));
const artifacts = process.env.PI_WEB_MOBILE_ARTIFACT_DIR || join(temp, "screenshots");
const audit = process.argv.includes("--audit");
const port = 8997;
const origin = `http://127.0.0.1:${port}`;
const agent = join(temp, "agent");
mkdirSync(agent);
mkdirSync(join(agent, "sessions"));
writeFileSync(
	join(agent, "sessions", "2026-01-01T00-00-00-000Z_mobile-reading.jsonl"),
	[
		JSON.stringify({
			type: "session",
			version: 3,
			id: "mobile-reading",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: temp,
		}),
		JSON.stringify({
			type: "message",
			id: "user-reading",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "Mobile reading example" }], timestamp: 1767225601000 },
		}),
		JSON.stringify({
			type: "message",
			id: "assistant-reading",
			parentId: "user-reading",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text:
							"## A readable response\n\nThis is a disposable example for checking comfortable reading, links, lists and long file names. No model was called.\n\n- Review the attached document.\n- Compare the figures and explain the differences.\n\n" +
							"LongFileNameWithoutSpaces".repeat(12) +
							"\n\n```text\n" +
							"A wide code line ".repeat(18) +
							"\n```\n\n| Category | Description | Result |\n| --- | --- | --- |\n| Example | A longer table entry for mobile layout | Ready |",
					},
				],
				timestamp: 1767225602000,
			},
		}),
	].join("\n") + "\n",
);
mkdirSync(join(temp, "ui"));
writeFileSync(
	join(temp, "ui", "filesystem-policy.json"),
	JSON.stringify({
		defaultPermissions: { read: "block", write: "block", execute: "block" },
		rules: [{ path: temp, permissions: { read: "allow", write: "block", execute: "block" } }],
	}),
);
mkdirSync(artifacts, { recursive: true });
writeFileSync(join(temp, "layout-example.md"), "# Example document\n\nReadable local file preview.\n");
writeFileSync(
	join(agent, "models.json"),
	JSON.stringify({
		providers: {
			mobileFixture: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "fixture-only",
				models: [
					{
						id: "mobile-fixture",
						name: "Example GGUF model with a deliberately long readable name",
						reasoning: true,
						contextWindow: 32768,
						maxTokens: 4096,
					},
				],
			},
		},
	}),
);
let browser;
let output = "";
const env = {
	...process.env,
	PI_WEB_PORT: String(port),
	PI_WEB_HOST: "127.0.0.1",
	PI_WEB_DATA_DIR: join(temp, "ui"),
	PI_WEB_CWD: temp,
	PI_CODING_AGENT_DIR: agent,
	PI_WEB_AUTH_USERNAME: "admin",
	PI_WEB_AUTH_PASSWORD: "fixture-password",
	PI_WEB_TOKEN: "",
	PI_WEB_TRUST_PROXY: "",
	PI_WEB_ALLOW_HOSTS: "",
	PI_WEB_ALLOW_ORIGINS: "",
	PI_WEB_AUTO_RESUME: "0",
	PI_WEB_START_BLANK: "1",
	PI_WEB_PRESET_REPO: "0",
	PI_WEB_PLUGIN_CATALOG_INSTALL: "0",
};
for (const key of ["PI_WEB_UPLOAD_DIR", "PI_WEB_ATTACHMENT_DIR", "PI_WEB_OCR_CACHE"]) delete env[key];
const server = spawn(process.execPath, ["--import", "./dist/server/resolve-global-sdk.js", "dist/server/index.js"], {
	cwd: root,
	env,
	windowsHide: true,
	stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (data) => {
	output += data;
});
server.stderr.on("data", (data) => {
	output += data;
});
const results = [];
async function record(page, name, selector = "body") {
	await page
		.locator(selector)
		.first()
		.evaluate((el) =>
			Promise.all(
				el
					.getAnimations()
					.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
					.map((a) => a.finished.catch(() => {})),
			),
		);
	const metrics = await page
		.locator(selector)
		.first()
		.evaluate((el) => {
			const rect = el.getBoundingClientRect();
			return {
				width: innerWidth,
				height: innerHeight,
				documentWidth: document.documentElement.scrollWidth,
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				contentOverflow: [...el.querySelectorAll(".modal-body,.model-studio-main")].some(
					(n) => n.scrollWidth > n.clientWidth + 1,
				),
				inputs: [
					...el.querySelectorAll(
						'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="hidden"]):not([type="file"]),textarea,select',
					),
				]
					.filter((n) => n.getBoundingClientRect().width > 0)
					.map((n) => parseFloat(getComputedStyle(n).fontSize)),
				smallButtons: [...el.querySelectorAll("button")]
					.filter((n) => {
						const r = n.getBoundingClientRect();
						return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden";
					})
					.filter((n) => {
						const r = n.getBoundingClientRect();
						return r.width < 43.5 || r.height < 43.5;
					})
					.map((n) => ({
						label: n.getAttribute("aria-label") || n.textContent?.trim().slice(0, 35),
						class: n.className,
					})),
			};
		});
	results.push({ name, ...metrics });
	writeFileSync(join(artifacts, "metrics.json"), JSON.stringify({ audit, results }, null, 2));
	await page.screenshot({ path: join(artifacts, `${name}.png`) });
	if (metrics.width <= 768) assert(metrics.documentWidth <= metrics.width + 1, `${name}: document overflow`);
	if (!audit && metrics.width <= 768) assert(!metrics.contentOverflow, `${name}: clipped inner content`);
	if (!audit && selector !== "body") {
		assert(metrics.left >= -1 && metrics.right <= metrics.width + 1, `${name}: horizontal clipping`);
		assert(metrics.top >= -1 && metrics.bottom <= metrics.height + 1, `${name}: vertical clipping`);
	}
	if (metrics.width <= 768)
		assert(
			metrics.inputs.every((size) => size >= 16),
			`${name}: editable controls must not trigger Safari zoom`,
		);
	if (!audit && metrics.width <= 768) assert.equal(metrics.smallButtons.length, 0, `${name}: undersized touch target`);
}
async function action(page, tip) {
	let target = page.locator(`button[data-tip="${tip}"]`).filter({ visible: true }).first();
	if (!(await target.count())) {
		await page.locator(".plugin-topbar-more button").filter({ visible: true }).first().click();
		target = page.locator(`button[data-tip="${tip}"]`).filter({ visible: true }).first();
	}
	await target.click();
}
try {
	for (let i = 0; i < 600; i++) {
		if (server.exitCode !== null) throw new Error(output);
		try {
			if ((await fetch(`${origin}/api/health`)).ok) break;
		} catch {}
		await delay(100);
	}
	assert(CHROME_PATH, "Chrome required for mobile rendering verification");
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	for (const width of [430, 390, 375]) {
		const context = await browser.newContext({
			viewport: { width, height: 932 },
			deviceScaleFactor: 3,
			isMobile: true,
			hasTouch: true,
		});
		const page = await context.newPage();
		await page.addInitScript(() => {
			const NativeSocket = window.WebSocket;
			window.WebSocket = class extends NativeSocket {
				constructor(...args) {
					super(...args);
					window.__mobileLayoutSocket = this;
				}
			};
		});
		const errors = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.goto(origin);
		await record(page, `${width}-login`, ".auth-card");
		await page.getByRole("textbox", { name: "Username", exact: true }).fill("admin");
		await page.getByLabel("Password", { exact: true }).fill("fixture-password");
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await page.locator(".inputbox textarea").waitFor();
		await record(page, `${width}-chat`);
		await page.evaluate(
			(path) => window.__mobileLayoutSocket.send(JSON.stringify({ type: "switch_session", path })),
			join(agent, "sessions", "2026-01-01T00-00-00-000Z_mobile-reading.jsonl"),
		);
		await page.getByText("A readable response", { exact: true }).waitFor();
		await record(page, `${width}-message-reading`);
		const messages = await page.locator(".messages").evaluate((el) => ({
			width: el.clientWidth,
			content: el.scrollWidth,
			font: parseFloat(getComputedStyle(el.querySelector(".md")).fontSize),
		}));
		assert(messages.content <= messages.width + 1, "Long text/code must not overflow the message scroller");
		assert(messages.font >= 16);
		if (!audit) {
			const headings = await page.locator(".messages .md th").evaluateAll((nodes) =>
				nodes.map((node) => {
					const range = document.createRange();
					range.selectNodeContents(node);
					return { height: range.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight) };
				}),
			);
			assert.equal(headings.length, 3);
			assert(
				headings.every((h) => h.height <= h.line * 1.1),
				`${width}: short table headings must stay readable`,
			);
			const targets = await page
				.locator(".topbar button:visible, .composer-tools button:visible")
				.evaluateAll((nodes) =>
					nodes.map((n) => {
						const r = n.getBoundingClientRect();
						return { width: r.width, height: r.height };
					}),
				);
			assert(
				targets.every((r) => r.width >= 43.5 && r.height >= 43.5),
				`${width}: primary touch targets`,
			);
		}
		await page.locator(".goalbar-hint").click();
		await record(page, `${width}-goal-editor`, ".goalbar");
		await page.locator(".goalbar-opts .dropdown").first().locator("button").first().click();
		await record(page, `${width}-goal-model-picker`, ".goalbar .dd-menu");
		await page.keyboard.press("Escape");
		await page.locator(".goalbar-row .goalbar-icon-btn").last().click();
		await page.locator(".composer-tools .dropdown").first().locator("button").first().click();
		await record(page, `${width}-models`, ".dd-menu-model");
		if (!audit) {
			const rows = await page.locator(".dd-menu-model .dd-item:has(.dd-model-cell)").evaluateAll((nodes) =>
				nodes.map((row) => {
					const bounds = row.getBoundingClientRect();
					const text = row.querySelector(".dd-model-cell").getBoundingClientRect();
					return text.top >= bounds.top && text.bottom <= bounds.bottom;
				}),
			);
			assert(rows.length && rows.every(Boolean), `${width}: model rows must contain their full labels`);
			assert(
				await page.locator(".dd-menu-model .dd-footer").evaluate((node) => {
					const bounds = node.getBoundingClientRect();
					return node.contains(document.elementFromPoint(bounds.right - 12, bounds.top + 12));
				}),
				`${width}: composer actions must not overlap the model sheet`,
			);
		}
		await page.getByRole("button", { name: /Manage models/ }).click();
		await page.locator(".model-studio-modal").waitFor();
		await record(page, `${width}-model-management`, ".model-studio-modal");
		await page.locator(".studio-nav-item").filter({ hasText: "mobileFixture" }).first().click();
		await record(page, `${width}-model-edit`, ".model-studio-modal");
		await page.locator(".model-matrix-card").first().scrollIntoViewIfNeeded();
		await record(page, `${width}-model-context`, ".model-studio-modal");
		await page.locator(".model-studio-modal button.close-btn").click();
		await action(page, "Settings");
		await page.locator(".settings-tab").first().waitFor();
		const tabs = await page
			.locator(".settings-tab")
			.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-tab")));
		for (const tab of tabs) {
			await page.locator(`.settings-tab[data-tab="${tab}"]`).click();
			await record(page, `${width}-settings-${tab.replaceAll(":", "-")}`, ".settings-modal");
		}
		await page.locator(".settings-modal .modal-close").click();
		await page.locator(".plugin-topbar-more button").click();
		await record(page, `${width}-more-menu`, ".plugin-topbar-menu.portal");
		await page.keyboard.press("Escape");
		await action(page, "Open project");
		await record(page, `${width}-project-picker`, ".project-picker");
		await page.keyboard.press("Escape");
		await page.locator(".panel-toggle").first().click();
		await record(page, `${width}-history`, ".drawer-left.open");
		await page.locator(".drawer-backdrop").click({ position: { x: width - 10, y: 400 } });
		await page.locator(".panel-toggle").last().click();
		await record(page, `${width}-files`, ".drawer-right.open");
		await page.getByText("layout-example.md", { exact: true }).first().click();
		await record(page, `${width}-file-preview`, ".fp");
		await page.locator(".fp-close").click();
		if (await page.locator(".drawer-backdrop.on").count())
			await page.locator(".drawer-backdrop.on").click({ position: { x: 10, y: 400 } });
		await action(page, "Terminal");
		await record(page, `${width}-terminal`);
		await action(page, "Git");
		await record(page, `${width}-git`);
		await action(page, "Chat");
		await page.setViewportSize({ width, height: 480 });
		await page.locator(".inputbox textarea").focus();
		await record(page, `${width}-short-viewport`);
		const input = await page.locator(".inputbox").boundingBox();
		assert(input.y + input.height <= 480, `${width}: composer visible in keyboard-sized viewport`);
		await page.locator(".goalbar-hint").click();
		await record(page, `${width}-short-goal-editor`, ".goalbar");
		const goalComposer = await page.locator(".inputbox").boundingBox();
		assert(goalComposer.y + goalComposer.height <= 480, `${width}: expanded Goal must keep the composer visible`);
		const goalFooter = await page.locator(".statusbar").boundingBox();
		assert(goalComposer.y + goalComposer.height <= goalFooter.y, `${width}: composer must not overlap the footer`);
		await page.locator(".goalbar-row .goalbar-icon-btn").last().click();
		await page.locator(".composer-tools .dropdown").first().locator("button").first().click();
		await record(page, `${width}-short-model-picker`, ".dd-menu-model");
		await page.keyboard.press("Escape");
		await action(page, "Settings");
		await record(page, `${width}-short-settings`, ".settings-modal");
		await page.locator(".settings-modal .modal-close").click();
		await page.setViewportSize({ width, height: 932 });
		await page.evaluate(() => {
			const style = document.documentElement.style;
			style.setProperty("--mobile-safe-top", "59px");
			style.setProperty("--mobile-safe-bottom", "34px");
			style.setProperty("--mobile-safe-left", "8px");
			style.setProperty("--mobile-safe-right", "8px");
		});
		await record(page, `${width}-simulated-safe-areas`);
		if (!audit && (await page.locator(".scroll-bottom:visible").count())) {
			const jump = await page.locator(".scroll-bottom").boundingBox();
			const goal = await page.locator(".goalbar-hint").boundingBox();
			assert(jump.y + jump.height <= goal.y - 3, `${width}: floating controls must not overlap`);
		}
		const app = await page.locator(".app").evaluate((el) => {
			const style = getComputedStyle(el);
			return { top: style.paddingTop, bottom: style.paddingBottom, left: style.paddingLeft, right: style.paddingRight };
		});
		assert.deepEqual(app, { top: "59px", bottom: "34px", left: "8px", right: "8px" });
		await action(page, "Settings");
		await record(page, `${width}-safe-area-settings`, ".settings-modal");
		await page.locator(".settings-modal .modal-close").click();
		assert.deepEqual(errors, [], `${width}: browser errors`);
		await context.close();
	}
	const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	await desktop.goto(origin);
	await desktop.getByRole("textbox", { name: "Username", exact: true }).fill("admin");
	await desktop.getByLabel("Password", { exact: true }).fill("fixture-password");
	await desktop.getByRole("button", { name: "Sign in", exact: true }).click();
	await desktop.locator(".inputbox textarea").waitFor();
	await desktop.locator(".statusbar").waitFor();
	await record(desktop, "desktop-chat");
	const desktopGeometry = () =>
		desktop.evaluate(() => ({
			documentWidth: document.documentElement.scrollWidth,
			boxes: [...document.querySelectorAll(".topbar,.main,.inputbar,.statusbar,.settings-modal")].map((el) => {
				const r = el.getBoundingClientRect();
				return {
					class: el.className,
					x: r.x,
					y: r.y,
					width: r.width,
					height: r.height,
					font: getComputedStyle(el).fontSize,
				};
			}),
		}));
	const actualChat = await desktopGeometry();
	const baselineCss = execFileSync("git", ["show", "HEAD:web/src/styles.css"], { cwd: root, encoding: "utf8" });
	let baselineStyle = await desktop.addStyleTag({ content: baselineCss });
	assert.deepEqual(await desktopGeometry(), actualChat, "Desktop chat geometry must match the previous stylesheet");
	await baselineStyle.evaluate((el) => el.remove());
	await action(desktop, "Settings");
	await desktop.locator(".settings-tab").first().waitFor();
	await record(desktop, "desktop-settings", ".settings-modal");
	const actualSettings = await desktopGeometry();
	baselineStyle = await desktop.addStyleTag({ content: baselineCss });
	assert.deepEqual(
		await desktopGeometry(),
		actualSettings,
		"Desktop Settings geometry must match the previous stylesheet",
	);
	await baselineStyle.evaluate((el) => el.remove());
	writeFileSync(join(artifacts, "metrics.json"), JSON.stringify({ audit, results }, null, 2));
	console.log(`PASS: ${results.length} rendered states; screenshots: ${artifacts}`);
} finally {
	await browser?.close();
	if (server.exitCode === null) {
		const exited = once(server, "exit");
		server.kill("SIGTERM");
		await exited;
	}
	rmSync(temp, { recursive: true, force: true });
}
