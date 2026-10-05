import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { extractTargetPath } from "./approval-rules.js";
import { filesystemAccess, type FilesystemApprovalRequest } from "./filesystem-access.js";
import { normalizeFilesystemPolicy, type FilesystemPolicy, type PolicyEvaluation } from "./filesystem-policy.js";
import { pick, type ServerLang } from "./i18n.js";
import { resolvePathForDirCheck } from "./read-tool.js";
import type { AnyToolDefinition } from "./tool-overrides.js";

export interface NativeReadPermissionOptions {
	cwd: string;
	/** ls reads immediate entries; grep/find may inspect every descendant. */
	kind: "ls" | "grep" | "find";
	getPolicy: () => FilesystemPolicy | undefined;
	getLang: () => ServerLang;
	askApproval?: FilesystemApprovalRequest;
	getConversationId?: () => string | undefined;
}

// Bound the preflight rather than silently skipping targets in a large search.
const MAX_PREFLIGHT_PATHS = 20_000;

/**
 * Native rg/fd cannot exclude arbitrary policy rules. Authorize the entire
 * requested tree before invoking them, preserving their original output/schema.
 * Nested links are checked physically but not followed (neither tool uses --follow).
 */
export function withNativeReadPermission(
	base: AnyToolDefinition,
	options: NativeReadPermissionOptions,
): AnyToolDefinition {
	return {
		...base,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const input = params as Record<string, unknown> | undefined;
			// Use read's existing path/alias extractor, including extension `file`
			// arguments, so the directory branch cannot authorize a different root.
			const selectedPath = base.name === "read" ? extractTargetPath(params) : input?.path;
			const rawPath = selectedPath ?? ".";
			if (typeof rawPath !== "string") throw new Error("Invalid filesystem path");
			const target = resolvePathForDirCheck(rawPath || ".", ctx?.cwd || options.cwd);
			const deny = (path: string): never => {
				throw new Error(
					pick(
						options.getLang(),
						`【权限被拒绝】文件系统策略未授权读取：${path}。请缩小搜索范围或更新权限。`,
						`[Permission Denied] Filesystem policy did not authorize reading: ${path}. Narrow the search scope or update permissions.`,
					),
				);
			};
			const checkAbort = (): void => {
				if (signal?.aborted) throw new Error("Filesystem operation aborted");
			};
			const collect = async (): Promise<Map<string, PolicyEvaluation>> => {
				const policy = normalizeFilesystemPolicy(options.getPolicy());
				const paths = new Map<string, PolicyEvaluation>();
				const visit = async (path: string, root = false): Promise<void> => {
					checkAbort();
					if (paths.size >= MAX_PREFLIGHT_PATHS)
						throw new Error(
							pick(
								options.getLang(),
								"权限检查范围过大，请使用更具体的子目录。",
								"Filesystem permission preflight is too large. Use a more specific subdirectory.",
							),
						);
					const access = await filesystemAccess(policy, "read", path);
					if (access.decision === "block") deny(path);
					paths.set(path, access);
					// The requested root may itself be a permitted link to a directory.
					// Immediate ls entries need access checks only, not recursive inspection.
					if (options.kind === "ls" && !root) return;
					const info = root ? await stat(path) : await lstat(path);
					if (info.isDirectory()) for (const child of await readdir(path)) await visit(join(path, child));
				};
				await visit(target, true);
				return paths;
			};
			const initial = await collect();
			const asked = [...initial.values()].filter((access) => access.decision === "ask");
			if (asked.length) {
				const approve = options.askApproval;
				if (!approve) return deny(target);
				const scope = options.kind === "ls" ? "directory and immediate entries" : "complete search tree";
				const examples = asked
					.slice(0, 5)
					.map((access) => access.path)
					.join("\n");
				const answer = await approve(
					toolCallId,
					base.name,
					params,
					`文件系统读取审批：${target}（${asked.length} 个路径）。本次操作涵盖目录及${options.kind === "ls" ? "直接条目" : "全部搜索子项"}。\n${examples}`,
					`Filesystem read approval: ${target} (${asked.length} paths require Ask). This operation covers the ${scope}.\n${examples}`,
					options.getConversationId?.(),
					{ id: `filesystem:read:${initial.get(target)!.path}`, label: "文件系统：read", labelEn: "Filesystem: read" },
				);
				// Edit & Run would approve a different operation; broad grants are not used.
				if (answer.decision !== "approve") deny(target);
			}
			checkAbort();
			// Re-enumerate after approval: a new file, changed link, Block, or newly
			// requested Ask must not inherit approval for an earlier operation.
			const current = await collect();
			if (current.size !== initial.size) deny(target);
			for (const [path, access] of current) {
				const previous = initial.get(path);
				if (!previous || access.path !== previous.path || (access.decision === "ask" && previous.decision !== "ask"))
					deny(path);
			}
			checkAbort();
			return base.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}
