import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Seed `<dataDir>/filesystem-policy.json` allowing the given roots.
 *
 * 这个 fork 的文件系统策略是 deny-by-default：data dir 里没有
 * filesystem-policy.json 时一切读/写/预览/监听都被拒（上游没有这层，上游时代的
 * 测试会表现成 403 / 空结果 / watcher 超时，而不是在测它想测的东西）。自起
 * server 的测试给自己的临时工作区播一条 allow 规则即可回到被测行为；默认决策
 * 保持 block，策略语义本身另有专测（filesystem-ux / project-required /
 * project-filesystem-policy）。
 */
export function seedAllowPolicy(dataDir, ...roots) {
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(dataDir, "filesystem-policy.json"),
		JSON.stringify({
			defaultPermissions: {
				read: "block",
				create: "block",
				write: "block",
				edit: "block",
				delete: "block",
				execute: "block",
			},
			rules: roots.map((path) => ({
				path,
				permissions: {
					read: "allow",
					create: "allow",
					write: "allow",
					edit: "allow",
					delete: "allow",
					execute: "allow",
				},
			})),
		}),
	);
}
