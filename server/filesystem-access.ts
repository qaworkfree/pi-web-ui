import { realpathSync } from "node:fs";
import { realpath, stat, lstat, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	evaluateFilesystemPolicy,
	type FilesystemAction,
	type FilesystemPolicy,
	type PolicyEvaluation,
} from "./filesystem-policy.js";
import type { UiApprovalCategory } from "./protocol.js";
import type { ToolApprovalResolution } from "./tool-approval.js";

/** Resolve existing links, including a new file below an existing ancestor. */
export async function canonicalFilesystemPath(path: string): Promise<string> {
	const absolute = resolve(path);
	try {
		return await realpath(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(absolute);
		if (parent === absolute) throw error;
		return join(await canonicalFilesystemPath(parent), basename(absolute));
	}
}

export async function filesystemAccess(
	policy: FilesystemPolicy,
	action: FilesystemAction,
	path: string,
): Promise<PolicyEvaluation> {
	const original = evaluateFilesystemPolicy(policy, action, path);
	const physical = evaluateFilesystemPolicy(policy, action, await canonicalFilesystemPath(path));
	// An explicit denied alias must not become a route into another allowed tree.
	return original.matchedRule?.permissions[action] === "block" ? { ...physical, decision: "block" } : physical;
}

export async function requireFilesystemAccess(
	policy: FilesystemPolicy,
	action: FilesystemAction,
	path: string,
): Promise<void> {
	if ((await filesystemAccess(policy, action, path)).decision !== "allow")
		throw new Error(`Permission denied: ${action} ${path}`);
}

export type FilesystemApprovalRequest = (
	toolCallId: string,
	toolName: string,
	params: unknown,
	reason?: string,
	reasonEn?: string,
	conversationId?: string,
	category?: UiApprovalCategory,
) => Promise<ToolApprovalResolution>;

/** Ask grants exactly this operation; it cannot override a later Block or path change. */
export async function authorizeFilesystemTool(options: {
	getPolicy?: () => FilesystemPolicy | undefined;
	action: FilesystemAction;
	path: string;
	toolCallId: string;
	toolName: string;
	params: unknown;
	askApproval?: FilesystemApprovalRequest;
	conversationId?: string;
	signal?: AbortSignal;
	detectCreate?: boolean;
}): Promise<boolean | undefined> {
	const policy = options.getPolicy?.();
	if (!policy) return undefined;
	const action = async (): Promise<FilesystemAction> => {
		if (!options.detectCreate) return options.action;
		try {
			await stat(options.path);
			return "write";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "create";
			throw error;
		}
	};
	const selectedAction = await action();
	const initial = await filesystemAccess(policy, selectedAction, options.path);
	if (options.signal?.aborted || initial.decision === "block") return false;
	if (initial.decision === "allow") return true;
	if (!options.askApproval) return false;
	const answer = await options.askApproval(
		options.toolCallId,
		options.toolName,
		options.params,
		`文件系统策略需要审批：${selectedAction} ${initial.path}`,
		`Filesystem approval required: ${selectedAction} ${initial.path}`,
		options.conversationId,
		{
			id: `filesystem:${selectedAction}:${initial.path}`,
			label: `文件系统：${selectedAction}`,
			labelEn: `Filesystem: ${selectedAction}`,
		},
	);
	if (answer.decision !== "approve" || options.signal?.aborted || (await action()) !== selectedAction) return false;
	const current = await filesystemAccess(options.getPolicy?.() ?? policy, selectedAction, options.path);
	return current.path === initial.path && current.decision !== "block";
}

/** Validate all descendants before a recursive operation; do not follow links. */
export async function requireFilesystemTreeAccess(
	policy: FilesystemPolicy,
	action: FilesystemAction,
	path: string,
	destination?: string,
): Promise<void> {
	await requireFilesystemAccess(policy, action, path);
	if (destination) await requireFilesystemAccess(policy, "create", destination);
	const info = await lstat(path);
	if (info.isDirectory())
		for (const child of await readdir(path))
			await requireFilesystemTreeAccess(
				policy,
				action,
				join(path, child),
				destination ? join(destination, child) : undefined,
			);
}

function canonicalFilesystemPathSync(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(absolute);
		if (parent === absolute) throw error;
		return join(canonicalFilesystemPathSync(parent), basename(absolute));
	}
}

/** Watch subscriptions have a synchronous API; use the same physical-path rule. */
export function requireFilesystemAccessSync(policy: FilesystemPolicy, action: FilesystemAction, path: string): void {
	const original = evaluateFilesystemPolicy(policy, action, path);
	const physical = evaluateFilesystemPolicy(policy, action, canonicalFilesystemPathSync(path));
	if (original.matchedRule?.permissions[action] === "block" || physical.decision !== "allow")
		throw new Error(`Permission denied: ${action} ${path}`);
}

/** Recursive mkdir writes only the missing ancestors, not existing parents. */
export async function requireFilesystemParentCreation(policy: FilesystemPolicy, path: string): Promise<void> {
	let parent = dirname(resolve(path));
	while (true) {
		try {
			await stat(parent);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await requireFilesystemAccess(policy, "create", parent);
		const next = dirname(parent);
		if (next === parent) return;
		parent = next;
	}
}
