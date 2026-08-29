/* Scroll stick E2E: verifies the two pending assertions for the
 * Back-to-bottom fix in MessageList.tsx on a long (>30 msg) chat:
 *  (i)  auto-stick — scrollHeight growing after the jump (streaming appends)
 *       does not outrun scrollToBottom's re-asserts; viewport stays pinned;
 *  (ii) user escape — an upward wheel during/after the grace window sticks
 *       and never bounces back (no force-snap, even if layout shifts).
 * Run: npm run build && node tests/scroll-stick-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-scrollstick-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(
	join(agentDir, "auth.json"),
	JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }),
);
for (let i = 1; i <= 35; i++) {
	writeFileSync(
		join(workdir, `seed-${String(i).padStart(2, "0")}.txt`),
		`seed content ${i}\n`,
	);
}
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			fastfail: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [{ id: "test-model" }],
			},
		},
	}),
);
process.env.PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
const CLIENT_ID = "scroll-stick-test-client";
const TALL_TEXT = "很长的需求描述。".repeat(2000);

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const server = spawn(process.execPath, [join(root, "dist", "server", "index.js")], {
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

/** Seed a long chat via WS (same pattern as lazy-window-test). */
function seedChat(want) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("seed timeout")), 30000);
		let step = 0;
		let known = 0;
		const sendNext = () => {
			if (step === 0) {
				const attachments = [];
				for (let i = 1; i <= 35; i++)
					attachments.push({ path: `seed-${String(i).padStart(2, "0")}.txt` });
				ws.send(
					JSON.stringify({
						type: "prompt",
						text: "请总结这些文件",
						attachments,
					}),
				);
			} else {
				ws.send(
					JSON.stringify({ type: "prompt", text: `${TALL_TEXT}\n\n第 ${step} 条` }),
				);
			}
			step++;
		};
		ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID })));
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			if (msg.type === "ready") return sendNext();
			let total = -1;
			if (msg.type === "snapshot") {
				known = msg.state.messages.length;
				total = known;
			} else if (msg.type === "snapshot_delta") {
				known += msg.appended?.length ?? 0;
				total = known;
			}
			if (total < 0) return;
			if (step === 1 && total >= 36) return sendNext();
			if (step === 2 && total >= 38) return sendNext();
			if (total >= want) {
				clearTimeout(timer);
				ws.close();
				resolve(total);
			}
		});
		ws.on("error", reject);
	});
}

/** Start inflating scrollHeight like a streaming append would: a 180px-tall
 *  spacer every 90ms for `ticks` ticks, inside the scroll container. */
const GROW_FN = `
	window.__grow = (ticks) => {
		window.__growLeft = ticks;
		window.__growTimer = setInterval(() => {
			if (window.__growLeft-- <= 0) return clearInterval(window.__growTimer);
			const el = document.querySelector('.messages');
			const d = document.createElement('div');
			d.style.height = '180px';
			el.appendChild(d);
		}, 90);
	};
`;
const distFromBottom = (page) =>
	page.evaluate(() => {
		const el = document.querySelector(".messages");
		return el.scrollHeight - el.scrollTop - el.clientHeight;
	});

async function main() {
	await waitServer();
	const total = await seedChat(38);
	console.log(`chat seeded (${total} messages)`);

	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));
	await page.addInitScript(
		(id) => localStorage.setItem("pi-web-client-id", id),
		CLIENT_ID,
	);

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.waitForSelector(".msg", { timeout: 30000 });
	await sleep(500);
	await page.addScriptTag({ content: GROW_FN });

	// ---- (i) auto-stick: growth race after back-to-bottom ----
	// Real streaming appends arrive WITH React renders (effect at line ~443
	// re-pins); the scrollToBottom re-asserts (rAF x2 + 120/300/600ms) are the
	// backstop for growth within the ~600ms after the jump. Simulate growth in
	// that window: 5 ticks x 90ms ≈ 900px of bottom growth racing the re-asserts.
	await page.evaluate(() => {
		document.querySelector(".messages").scrollTop = 0;
	});
	await sleep(400);
	await page.locator(".scroll-bottom").click();
	await page.evaluate(() => window.__grow(5));
	await sleep(1400); // past the 600ms re-assert
	let d = await distFromBottom(page);
	check(`auto-stick: viewport pinned while bottom grew (gap ${d}px < 80)`, d < 80);

	// ---- (ii) user escape: upward wheel sticks, no bounce-back ----
	await sleep(400); // grace window (250ms) fully elapsed
	await page.evaluate(() => window.__grow(4)); // still "streaming" when user escapes
	await page.mouse.move(700, 450);
	await page.mouse.wheel(0, -600);
	await sleep(400); // let the wheel's own scroll settle
	const before = await page.evaluate(
		() => document.querySelector(".messages").scrollTop,
	);
	await sleep(2200); // well past any re-assert timer / stream end — no force-snap
	const after = await page.evaluate(
		() => document.querySelector(".messages").scrollTop,
	);
	const gap = await distFromBottom(page);
	check(
		`user escape: scroll position sticks (Δ${Math.abs(after - before)}px < 400)`,
		Math.abs(after - before) < 400,
	);
	check(`user escape: no force-snap to bottom (gap ${gap}px > 300)`, gap > 300);

	// Post-stream: no late snap-back after growth stops
	await sleep(1200);
	const gapFinal = await distFromBottom(page);
	check(`post-stream: still no force-snap (gap ${gapFinal}px > 300)`, gapFinal > 300);

	check("no page errors", consoleErrors.length === 0);
	if (consoleErrors.length > 0)
		console.log("   console errors:", consoleErrors.slice(0, 3));

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
	console.error("❌", e.message);
	process.exit(1);
});
