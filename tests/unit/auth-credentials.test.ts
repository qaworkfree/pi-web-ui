import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthCredentialStore } from "../../server/auth-credentials.js";

describe("auth credential store", () => {
	it("bootstraps a salted hash and verifies it after reload", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-web-auth-"));
		const first = new AuthCredentialStore(dataDir, "alice", "correct horse battery staple");
		expect(first.isConfigured()).toBe(true);
		expect(first.verify("alice", "correct horse battery staple")).toBe(true);
		expect(first.verify("alice", "wrong")).toBe(false);
		const raw = readFileSync(join(dataDir, "auth-users.json"), "utf8");
		expect(raw).not.toContain("correct horse battery staple");

		const reloaded = new AuthCredentialStore(dataDir);
		expect(reloaded.verify("alice", "correct horse battery staple")).toBe(true);
	});

	it("does not overwrite existing credentials from changed environment values", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-web-auth-"));
		new AuthCredentialStore(dataDir, "alice", "old");
		const reloaded = new AuthCredentialStore(dataDir, "alice", "new");
		expect(reloaded.verify("alice", "old")).toBe(true);
		expect(reloaded.verify("alice", "new")).toBe(false);
	});
});
