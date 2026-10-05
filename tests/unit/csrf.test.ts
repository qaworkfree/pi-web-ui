import { describe, expect, it } from "vitest";
import { sameOriginStateChange } from "../../server/csrf.js";

const base = { host: "localhost:8788" };

describe("sameOriginStateChange", () => {
	it("allows same-origin browser writes", () => {
		expect(
			sameOriginStateChange({ method: "POST", headers: { host: base.host, origin: "http://localhost:8788" } }),
		).toBe(true);
	});
	it("rejects cross-origin browser writes", () => {
		expect(
			sameOriginStateChange({ method: "POST", headers: { host: base.host, origin: "https://evil.example" } }),
		).toBe(false);
	});
	it("accepts a same-origin referer when Origin is absent", () => {
		expect(
			sameOriginStateChange({
				method: "DELETE",
				headers: { host: base.host, referer: "http://localhost:8788/settings" },
			}),
		).toBe(true);
	});
	it("supports TLS behind a forwarded proxy", () => {
		expect(
			sameOriginStateChange({
				method: "POST",
				headers: {
					host: "internal:8788",
					"x-forwarded-host": "ui.example",
					"x-forwarded-proto": "https",
					origin: "https://ui.example",
				},
			}),
		).toBe(true);
	});
	it("does not constrain read requests", () => {
		expect(sameOriginStateChange({ method: "GET", headers: { host: base.host, origin: "https://evil.example" } })).toBe(
			true,
		);
	});
	it("allows non-browser clients without origin metadata", () => {
		expect(sameOriginStateChange({ method: "POST", headers: { host: base.host } })).toBe(true);
	});
});
