#!/usr/bin/env node
/**
 * check-protocol-sync.mjs — 校验 wire 协议双端手工同步：
 *   server/protocol.ts（事实源）↔ web/src/types.ts（镜像）
 *
 * 两端没有共享代码，新增/改名消息漏同步时，前端 onmessage switch 会静默
 * 丢弃消息（表现为"没反应"）。本脚本提取两端 ClientMessage / ServerMessage
 * 联合类型里的 `type: "…"` 字面量并比对集合，不一致即退出码 1。
 *
 * 用法：node scripts/check-protocol-sync.mjs（typecheck / CI 里自动跑）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const protocolSrc = readFileSync(join(root, "server/protocol.ts"), "utf8");
const typesSrc = readFileSync(join(root, "web/src/types.ts"), "utf8");

/** Extract the source text of `export type XMessage = …;` (up to the next
 *  `export type` at column 0 or EOF) and collect its `type: "…"` literals. */
function extractLiterals(src, typeName) {
	const start = src.indexOf(`export type ${typeName} =`);
	if (start === -1) return null;
	const rest = src.slice(start);
	const nextExport = rest.slice(1).search(/\nexport type /);
	const body =
		nextExport === -1 ? rest : rest.slice(0, nextExport + 1);
	const literals = [...body.matchAll(/\btype:\s*"([a-z_]+)"/g)].map(
		(m) => m[1],
	);
	return new Set(literals);
}

let failed = false;
for (const dir of ["Client", "Server"]) {
	const a = extractLiterals(protocolSrc, `${dir}Message`);
	const b = extractLiterals(typesSrc, `${dir}Message`);
	if (!a || !b) {
		console.error(`✗ ${dir}Message：在一端找不到类型定义`);
		failed = true;
		continue;
	}
	const onlyProtocol = [...a].filter((x) => !b.has(x));
	const onlyTypes = [...b].filter((x) => !a.has(x));
	for (const t of onlyProtocol)
		console.error(`✗ ${dir}Message "${t}" 只在 server/protocol.ts，缺 web/src/types.ts 镜像`);
	for (const t of onlyTypes)
		console.error(`✗ ${dir}Message "${t}" 只在 web/src/types.ts，server/protocol.ts 没有它`);
	if (onlyProtocol.length || onlyTypes.length) failed = true;
	else console.log(`✓ ${dir}Message 双端一致（${a.size} 个消息类型）`);
}

if (failed) {
	console.error("\n协议双端不同步 —— 先改 server/protocol.ts，再镜像到 web/src/types.ts。");
	process.exit(1);
}
