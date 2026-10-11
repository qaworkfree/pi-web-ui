// detectProjectPreset: the Settings panel must show the project's EFFECTIVE
// preset (blocked/read-only/development/custom/none) instead of always
// defaulting the dropdown to "Read only".
import { describe, expect, it } from "vitest";
import { detectProjectPreset } from "../../web/src/components/FilesystemPolicyPanel.js";
import type { UiFilesystemPolicy } from "../../web/src/types.js";

const policy = (rules: UiFilesystemPolicy["rules"]): UiFilesystemPolicy => ({
	defaultPermissions: {
		read: "block",
		create: "block",
		write: "block",
		edit: "block",
		delete: "block",
		execute: "block",
	},
	rules,
});

const DEV = { read: "allow", create: "allow", write: "allow", edit: "allow", delete: "ask", execute: "ask" } as const;
const READ_ONLY = {
	read: "allow",
	create: "block",
	write: "block",
	edit: "block",
	delete: "block",
	execute: "block",
} as const;
const BLOCKED = {
	read: "block",
	create: "block",
	write: "block",
	edit: "block",
	delete: "block",
	execute: "block",
} as const;

describe("detectProjectPreset", () => {
	it("returns none without a policy, cwd or matching rule", () => {
		expect(detectProjectPreset(null, "D:/proj")).toBe("none");
		expect(detectProjectPreset(policy([]), "")).toBe("none");
		expect(detectProjectPreset(policy([{ path: "D:/other", permissions: DEV }]), "D:/proj")).toBe("none");
	});

	it("recognizes each preset shape", () => {
		expect(detectProjectPreset(policy([{ path: "D:/proj", permissions: DEV }]), "D:/proj")).toBe("development");
		expect(detectProjectPreset(policy([{ path: "D:/proj", permissions: READ_ONLY }]), "D:/proj")).toBe("read-only");
		expect(detectProjectPreset(policy([{ path: "D:/proj", permissions: BLOCKED }]), "D:/proj")).toBe("blocked");
	});

	it("treats missing actions in the rule as block (partial rules still match)", () => {
		// read-only minus the explicit blocks: same effective shape.
		expect(detectProjectPreset(policy([{ path: "D:/proj", permissions: { read: "allow" } }]), "D:/proj")).toBe(
			"read-only",
		);
		expect(detectProjectPreset(policy([{ path: "D:/proj", permissions: {} }]), "D:/proj")).toBe("blocked");
	});

	it("returns custom for a rule matching no preset shape", () => {
		expect(
			detectProjectPreset(policy([{ path: "D:/proj", permissions: { ...DEV, delete: "allow" } }]), "D:/proj"),
		).toBe("custom");
	});

	it("matches paths case-insensitively across slash styles and trailing separators", () => {
		expect(detectProjectPreset(policy([{ path: "d:\\Proj\\", permissions: DEV }]), "D:/proj")).toBe("development");
		expect(detectProjectPreset(policy([{ path: "D:/proj", permissions: DEV }]), "d:\\PROJ\\")).toBe("development");
	});
});
