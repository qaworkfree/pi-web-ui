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
});
