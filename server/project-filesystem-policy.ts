import { isAbsolute, resolve } from "node:path";
import { normalizeFilesystemPolicy, type FilesystemPolicy, type FilesystemPermissions } from "./filesystem-policy.js";

export const PROJECT_FILESYSTEM_PRESETS = {
	blocked: { read: "block", create: "block", write: "block", edit: "block", delete: "block", execute: "block" },
	"read-only": { read: "allow", create: "block", write: "block", edit: "block", delete: "block", execute: "block" },
	development: { read: "allow", create: "allow", write: "allow", edit: "allow", delete: "ask", execute: "ask" },
} as const satisfies Record<string, FilesystemPermissions>;
export type ProjectFilesystemPreset = keyof typeof PROJECT_FILESYSTEM_PRESETS;

/** Replace only the exact project-root rule, retaining defaults and nested/other rules. */
export function applyProjectFilesystemPreset(
	policy: FilesystemPolicy | undefined,
	project: string,
	preset: string,
): FilesystemPolicy {
	if (!isAbsolute(project)) throw new Error("Project scope must be an absolute path");
	if (!Object.hasOwn(PROJECT_FILESYSTEM_PRESETS, preset)) throw new Error("Unknown project filesystem preset");
	const normalized = normalizeFilesystemPolicy(policy);
	const path = resolve(project);
	return {
		defaultPermissions: normalized.defaultPermissions,
		rules: [
			...normalized.rules.filter((rule) => resolve(rule.path) !== path),
			{ path, permissions: { ...PROJECT_FILESYSTEM_PRESETS[preset as ProjectFilesystemPreset] } },
		],
	};
}
