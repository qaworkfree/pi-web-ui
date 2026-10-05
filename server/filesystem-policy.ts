/**
 * Central filesystem permission policy.
 *
 * This module deliberately contains no filesystem access. It normalizes a
 * requested path and evaluates it against an explicit allow/ask/block policy.
 * Enforcement callers must still resolve symlinks and perform the check as
 * close as possible to the operation itself.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export const FILESYSTEM_ACTIONS = ["read", "create", "write", "edit", "delete", "execute"] as const;
export type FilesystemAction = (typeof FILESYSTEM_ACTIONS)[number];
export type PermissionDecision = "allow" | "ask" | "block";

export type FilesystemPermissions = Readonly<Partial<Record<FilesystemAction, PermissionDecision>>>;

export interface FilesystemPolicyRule {
	path: string;
	permissions: FilesystemPermissions;
}

export interface FilesystemPolicy {
	defaultPermissions: FilesystemPermissions;
	rules: readonly FilesystemPolicyRule[];
}

export interface PolicyEvaluation {
	decision: PermissionDecision;
	path: string;
	action: FilesystemAction;
	matchedRule?: FilesystemPolicyRule;
}

export const DENY_BY_DEFAULT_POLICY: FilesystemPolicy = Object.freeze({
	defaultPermissions: Object.freeze({
		read: "block",
		create: "block",
		write: "block",
		edit: "block",
		delete: "block",
		execute: "block",
	}),
	rules: Object.freeze([]),
});

function normalizePolicyPath(path: string): string {
	return resolve(path);
}

function pathDepth(path: string): number {
	return path.split(sep).filter(Boolean).length;
}

/** Return true when candidate is root itself or a descendant of root. */
export function isPathWithin(root: string, candidate: string): boolean {
	const rootPath = normalizePolicyPath(root);
	const candidatePath = normalizePolicyPath(candidate);
	const child = relative(rootPath, candidatePath);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function ruleForAction(
	policy: FilesystemPolicy,
	path: string,
	action: FilesystemAction,
): FilesystemPolicyRule | undefined {
	return policy.rules
		.filter((rule) => isPathWithin(rule.path, path) && rule.permissions[action] !== undefined)
		.sort((a, b) => pathDepth(normalizePolicyPath(b.path)) - pathDepth(normalizePolicyPath(a.path)))[0];
}

/** Evaluate one operation. The most specific rule declaring that action wins. */
export function evaluateFilesystemPolicy(
	policy: FilesystemPolicy,
	action: FilesystemAction,
	path: string,
): PolicyEvaluation {
	const normalizedPath = normalizePolicyPath(path);
	const matchedRule = ruleForAction(policy, normalizedPath, action);
	const decision = matchedRule?.permissions[action] ?? policy.defaultPermissions[action] ?? "block";
	return { decision, path: normalizedPath, action, matchedRule };
}

/** Normalize externally loaded policy data without weakening deny-by-default. */
export function normalizeFilesystemPolicy(input: Partial<FilesystemPolicy> | undefined): FilesystemPolicy {
	const defaultPermissions: Record<FilesystemAction, PermissionDecision> = {
		read: input?.defaultPermissions?.read ?? "block",
		create: input?.defaultPermissions?.create ?? "block",
		write: input?.defaultPermissions?.write ?? "block",
		edit: input?.defaultPermissions?.edit ?? "block",
		delete: input?.defaultPermissions?.delete ?? "block",
		execute: input?.defaultPermissions?.execute ?? "block",
	};
	const rules = (input?.rules ?? []).map((rule) => ({
		path: normalizePolicyPath(rule.path),
		permissions: { ...rule.permissions },
	}));
	return { defaultPermissions, rules };
}
