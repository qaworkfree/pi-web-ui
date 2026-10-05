import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyProjectFilesystemPreset } from "../../server/project-filesystem-policy.js";
import { evaluateFilesystemPolicy, normalizeFilesystemPolicy } from "../../server/filesystem-policy.js";

describe("project filesystem presets", () => {
	it("preserves defaults, other projects and nested exceptions", () => {
		const root = resolve("project");
		const other = resolve("other");
		const policy = normalizeFilesystemPolicy({
			defaultPermissions: { execute: "block" },
			rules: [
				{ path: root, permissions: { read: "block" } },
				{ path: other, permissions: { write: "allow" } },
				{ path: resolve(root, "secrets"), permissions: { read: "block" } },
			],
		});
		const result = applyProjectFilesystemPreset(policy, root, "development");
		expect(result.defaultPermissions).toEqual(policy.defaultPermissions);
		expect(result.rules).toHaveLength(3);
		expect(evaluateFilesystemPolicy(result, "read", resolve(root, "src.ts")).decision).toBe("allow");
		expect(evaluateFilesystemPolicy(result, "execute", root).decision).toBe("ask");
		expect(evaluateFilesystemPolicy(result, "read", resolve(root, "secrets/key")).decision).toBe("block");
		expect(evaluateFilesystemPolicy(result, "write", resolve(other, "src.ts")).decision).toBe("allow");
		expect(evaluateFilesystemPolicy(result, "read", resolve(root + "-sibling", "src.ts")).decision).toBe("block");
		expect(policy.rules[0].permissions.read).toBe("block");
	});
	it("requires an explicit valid project and supports restrictive presets", () => {
		expect(() => applyProjectFilesystemPreset(undefined, "", "development")).toThrow("absolute");
		expect(() => applyProjectFilesystemPreset(undefined, resolve("project"), "__proto__")).toThrow("Unknown");
		const root = resolve("project");
		const read = applyProjectFilesystemPreset(undefined, root, "read-only");
		expect(evaluateFilesystemPolicy(read, "write", root).decision).toBe("block");
		expect(evaluateFilesystemPolicy(read, "read", root).decision).toBe("allow");
		expect(evaluateFilesystemPolicy(applyProjectFilesystemPreset(read, root, "blocked"), "read", root).decision).toBe(
			"block",
		);
	});
});
