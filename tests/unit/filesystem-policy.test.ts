import { describe, expect, it } from "vitest";
import {
	DENY_BY_DEFAULT_POLICY,
	evaluateFilesystemPolicy,
	normalizeFilesystemPolicy,
	type FilesystemPolicy,
} from "../../server/filesystem-policy.js";

describe("filesystem policy", () => {
	it("blocks every action by default", () => {
		const actions = ["read", "create", "write", "edit", "delete", "execute"] as const;
		for (const action of actions) {
			expect(evaluateFilesystemPolicy(DENY_BY_DEFAULT_POLICY, action, "C:/private/file.txt").decision).toBe("block");
		}
	});

	it("uses the most specific matching rule", () => {
		const policy: FilesystemPolicy = normalizeFilesystemPolicy({
			rules: [
				{ path: "C:/AI", permissions: { read: "allow", write: "ask" } },
				{ path: "C:/AI/Projects", permissions: { write: "allow" } },
			],
		});

		expect(evaluateFilesystemPolicy(policy, "read", "C:/AI/Projects/app.ts").decision).toBe("allow");
		expect(evaluateFilesystemPolicy(policy, "write", "C:/AI/Projects/app.ts").decision).toBe("allow");
		expect(evaluateFilesystemPolicy(policy, "write", "C:/AI/notes.txt").decision).toBe("ask");
	});

	it("does not match sibling paths", () => {
		const policy = normalizeFilesystemPolicy({
			rules: [{ path: "C:/AI/Projects", permissions: { read: "allow" } }],
		});
		expect(evaluateFilesystemPolicy(policy, "read", "C:/AI/ProjectsPrivate/file.txt").decision).toBe("block");
	});

	it("keeps unspecified actions blocked", () => {
		const policy = normalizeFilesystemPolicy({
			rules: [{ path: "C:/Models", permissions: { read: "allow" } }],
		});
		expect(evaluateFilesystemPolicy(policy, "write", "C:/Models/model.gguf").decision).toBe("block");
	});
});
