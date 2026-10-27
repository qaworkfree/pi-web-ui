/**
 * 冒烟测试共用的构建辅助：修并行构建竞态。
 * run-smoke.mjs 并行 worker 里多个测试各自 `npm run build` 同时写 dist/ 会互相
 * 踩踏（偶发非零退出 →「build failed」假红）。聚合跑器在起 worker 池前统一构建
 * 一次并设 PI_SMOKE_PREBUILT=1，各测试经本辅助跳过自建；单独跑某个测试
 * （环境变量缺席）时照旧现场构建，保持可独立运行。
 */
import { execSync } from "node:child_process";

/** 构建仓库（PI_SMOKE_PREBUILT=1 时 no-op）；失败打印构建输出并以 1 退出。 */
export function ensureBuild(repoRoot) {
	if (process.env.PI_SMOKE_PREBUILT === "1") return;
	try {
		execSync("npm run build", { cwd: repoRoot, stdio: "pipe" });
	} catch (err) {
		if (err?.stdout?.length) process.stdout.write(err.stdout);
		if (err?.stderr?.length) process.stderr.write(err.stderr);
		console.error("build failed");
		process.exit(1);
	}
}
