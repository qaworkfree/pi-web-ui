import { describe, expect, it } from "vitest";
import { AuthSessionStore, sessionCookie, sessionCookieToken } from "../../server/auth-sessions.js";

describe("auth sessions", () => {
	it("creates, validates, and revokes sessions", () => {
		const store = new AuthSessionStore();
		const created = store.create("alice");
		expect(store.get(created.token)?.user).toBe("alice");
		store.revoke(created.token);
		expect(store.get(created.token)).toBeUndefined();
	});

	it("round-trips the HttpOnly session cookie value", () => {
		const cookie = sessionCookie("token=with spaces", 3600, true);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(sessionCookieToken(cookie.split(";")[0])).toBe("token=with spaces");
	});

	it("lists and revokes sessions without exposing bearer tokens", () => {
		const store = new AuthSessionStore();
		const first = store.create("alice", { userAgent: "Browser", address: "127.0.0.1" });
		const second = store.create("alice");
		store.create("bob");
		const sessions = store.list("alice");
		expect(sessions).toHaveLength(2);
		expect(sessions[0]).not.toHaveProperty("token");
		expect(sessions.find((session) => session.id === first.id)?.userAgent).toBe("Browser");
		expect(store.revokeId("alice", second.id)).toBe(true);
		expect(store.list("alice")).toHaveLength(1);
		expect(store.revokeId("bob", first.id)).toBe(false);
	});
});
