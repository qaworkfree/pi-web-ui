import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthCredentialStore } from "../../server/auth-credentials.js";

describe("auth credential store", () => {
	it("refuses startup instead of disabling authentication on corrupt credentials", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-web-auth-corrupt-"));
		for (const content of [
			"{",
			JSON.stringify({ version: 1, users: [] }),
			JSON.stringify({ version: 1, users: [{ username: "admin", salt: "bad", hash: "bad" }] }),
		]) {
			writeFileSync(join(dataDir, "auth-users.json"), content);
			expect(() => new AuthCredentialStore(dataDir, "admin", "replacement")).toThrow(
				"refusing unauthenticated startup",
			);
		}
	});
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

	it("supports admin-managed users and protects the last administrator", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-web-auth-"));
		const store = new AuthCredentialStore(dataDir, "admin", "admin-password");
		store.addUser("bob", "bob-password");
		expect(store.listUsers()).toEqual([
			{ username: "admin", role: "admin" },
			{ username: "bob", role: "user" },
		]);
		expect(store.isAdmin("admin")).toBe(true);
		store.removeUser("bob");
		expect(store.verify("bob", "bob-password")).toBe(false);
		expect(() => store.removeUser("admin")).toThrow("last user");
	});
});
