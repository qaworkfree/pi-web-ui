import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "../../server/auth-rate-limit.js";

describe("login rate limiter", () => {
	it("allows five attempts and blocks the sixth", () => {
		let now = 1000;
		const limiter = new LoginRateLimiter(5, 60_000, () => now);
		for (let i = 0; i < 5; i++) {
			expect(limiter.check("127.0.0.1").allowed).toBe(true);
			limiter.recordFailure("127.0.0.1");
		}
		expect(limiter.check("127.0.0.1").allowed).toBe(false);
		now += 60_001;
		expect(limiter.check("127.0.0.1").allowed).toBe(true);
	});

	it("clears failures after successful login", () => {
		const limiter = new LoginRateLimiter(1, 60_000, () => 1000);
		limiter.recordFailure("client");
		expect(limiter.check("client").allowed).toBe(false);
		limiter.clear("client");
		expect(limiter.check("client").allowed).toBe(true);
	});
});
