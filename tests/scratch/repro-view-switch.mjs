/* Reproduce the "switching to chat kills the terminal" report against the
 * LIVE dev server (vite :5173, ws proxied to tsx watch :8787). */
import { chromium } from "playwright-core";

const URL = process.env.TEST_URL || "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
	executablePath:
		"/Users/c/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", (m) => {
	if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200));
});
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

await page.goto(URL);
await page.waitForSelector(".topbar", { timeout: 30000 });
console.log("app loaded");
await sleep(2000);

// Terminal view, run a long-running command so we can tell if it dies.
await page.click('.view-switch button:has-text("终端")');
await page.waitForSelector(".terminal-view");
await page.click(".term-tabs .panel-new"); // plain shell
await page.waitForSelector(".term-tab", { timeout: 8000 });
console.log("shell tab opened");
await sleep(2500);

const textarea = page.locator(".term-xterm .xterm-helper-textarea").first();
await textarea.click();
await page.keyboard.type("sleep 60");
await page.keyboard.press("Enter");
await sleep(1200);
console.log("ran: sleep 60");

// Now switch to chat and back — the bug report.
await page.click('.view-switch button:has-text("对话")');
console.log("switched to chat");
await sleep(1500);
await page.click('.view-switch button:has-text("终端")');
await sleep(1500);
console.log("switched back to terminal");

const tabCount = await page.locator(".term-tab").count();
console.log("tabs after switch-back:", tabCount);
const tabText = tabCount > 0 ? await page.locator(".term-tab").first().textContent() : "(none)";
console.log("tab text:", tabText);
const termText = await page.textContent(".term-main");
console.log("terminal still has output:", termText?.includes("sleep 60"));

// Is the PTY process still alive? Ask via the terminal itself.
if (tabCount > 0) {
	await page.locator(".term-xterm .xterm-helper-textarea").first().click();
	await page.keyboard.type("echo STILL_ALIVE");
	await page.keyboard.press("Enter");
	await sleep(1500);
	const t = await page.textContent(".term-main");
	console.log("echo came back:", t?.includes("STILL_ALIVE"));
}

await browser.close();
console.log("done");
