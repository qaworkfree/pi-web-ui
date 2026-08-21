#!/usr/bin/env node
/**
 * run-smoke.mjs — 零 token 协议冒烟测试聚合跑器（本地与 CI 共用）。
 *
 * 顺序执行一组自起 server 的 *-test.mjs 脚本（各自独立端口 + 临时 data-dir，
 * 结束时自行清理）。任何一个失败不中断后续，最后汇总并以非零码退出。
 *
 * 不收录的脚本及原因：
 *   - 浏览器 E2E（playwright/chromium，路径写死本机）：*-browser*、scm-test、
 *     freeze、goal-pill/ui/rounds、panel/left/sound/settings-ui 等 → 本地手动跑；
 *   - 真模型 live：goal-review-loop、live-test（需已运行 server）、update-test。
 *
 * 用法：node tests/run-smoke.mjs [name1 name2 …]   # 无参 = 全量
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const ALL = [
	"conv-cwd-test",
	"fetch-models-test",
	"goal-prefs-test",
	"goal-test",
	"preview-test",
	"quiesce-test",
	"restart-handoff-test",
	"scm-features-test",
	"settings-test",
	"steer-queue-smoke",
	"terminal-smoke-test",
	"vision-bridge-test",
];

// 不在默认清单里的脚本：
//   - 需外部已运行 server（attach 型，默认 8787）：ws-session-test /
//     file-upload-test / image-paste-test / commands-test(8791) /
//     edit-reask-test / projects-test —— 本地先起 server 再单独跑；
//   - 需真模型（本地可跑，CI 无凭据必败）：goal-abort-test /
//     goal-autostart-test / goal-wizard-test / goal-wizard-cancel-test；
//   - 平台相关：spawn-helper-test（macOS spawn-helper 二进制）；
//   - CI 上启动超时待查：slash-commands-test；
//   - 已知失败待修（HEAD 上即败）：title-jsonl-test / tool-status-test；
//   - 浏览器 E2E 见文件头注释（headless Chrome 路径写死本机）。


const targets = process.argv.length > 2 ? process.argv.slice(2) : ALL;
const results = [];

for (const name of targets) {
	const file = join(here, `${name}.mjs`);
	process.stdout.write(`\n▶ ${name}\n`);
	const ok = await new Promise((resolveRun) => {
		const child = spawn(process.execPath, [file], {
			// 测试脚本内相对路径（如 dist/server/index.js）以仓库根为基准
			cwd: dirname(here),
			stdio: "inherit",
			env: process.env,
		});
		child.on("exit", (code) => resolveRun(code === 0));
		child.on("error", () => resolveRun(false));
	});
	results.push({ name, ok });
}

console.log("\n===== 冒烟汇总 =====");
let failures = 0;
for (const r of results) {
	console.log(`${r.ok ? "✓" : "✗"} ${r.name}`);
	if (!r.ok) failures++;
}
console.log(`\n${results.length - failures}/${results.length} 通过`);
process.exit(failures ? 1 : 0);
