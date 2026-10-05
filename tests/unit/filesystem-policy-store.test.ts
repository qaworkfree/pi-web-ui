import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemPolicyStore } from "../../server/filesystem-policy-store.js";

describe("filesystem policy store", () => {
	it("round-trips a policy through the data directory", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-web-policy-"));
		const store = new FilesystemPolicyStore(dataDir);
		store.save({
			defaultPermissions: { read: "block" },
			rules: [{ path: "C:/AI/Projects", permissions: { read: "allow", write: "ask" } }],
		});

		const loaded = store.load();
		expect(loaded?.defaultPermissions.read).toBe("block");
		expect(loaded?.rules[0]?.permissions.write).toBe("ask");
		expect(readFileSync(join(dataDir, "filesystem-policy.json"), "utf8")).toContain("AI");
	});

	it("denies all actions for a missing policy", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-web-policy-"));
		expect(new FilesystemPolicyStore(dataDir).load().defaultPermissions.read).toBe("block");
		writeFileSync(join(dataDir, "filesystem-policy.json"), "{ corrupt");
		expect(new FilesystemPolicyStore(dataDir).load().defaultPermissions.execute).toBe("block");
	});
});
