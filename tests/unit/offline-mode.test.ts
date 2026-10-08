/**
 * Offline guard (PI_WEB_OFFLINE) unit tests — pure functions only, zero server.
 * Covers: env detection, loopback host/URL allowance, black-hole child env.
 */
import { describe, expect, it } from "vitest";
import {
	isOfflineMode,
	isLoopbackHost,
	isOfflineAllowedUrl,
	offlineChildEnv,
	OFFLINE_BLOCKED_MESSAGE,
	OFFLINE_SYSTEM_PROMPT,
} from "../../server/offline-mode.js";

describe("isOfflineMode", () => {
	it("accepts truthy forms", () => {
		for (const v of ["1", "true", "YES", "On", " 1 "]) {
			expect(isOfflineMode({ PI_WEB_OFFLINE: v })).toBe(true);
		}
	});
	it("rejects falsy/absent forms", () => {
		for (const v of [undefined, "", "0", "false", "off", "no", "nope"]) {
			expect(isOfflineMode({ PI_WEB_OFFLINE: v })).toBe(false);
		}
	});
});

describe("isLoopbackHost", () => {
	it("allows loopback names and literals", () => {
		for (const h of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
			expect(isLoopbackHost(h)).toBe(true);
		}
	});
	it("blocks everything else", () => {
		for (const h of [
			"example.com",
			"192.168.1.10",
			"10.0.0.1",
			"127.0.0.1.evil.com",
			"localhost.evil.com",
			"8.8.8.8",
		]) {
			expect(isLoopbackHost(h)).toBe(false);
		}
	});
});

describe("isOfflineAllowedUrl", () => {
	it("allows loopback http/ws URLs", () => {
		expect(isOfflineAllowedUrl("http://127.0.0.1:8080/v1/models")).toBe(true);
		expect(isOfflineAllowedUrl("http://localhost:8788/api/health")).toBe(true);
		expect(isOfflineAllowedUrl("ws://127.0.0.1:8788/ws")).toBe(true);
	});
	it("blocks remote and malformed URLs (fail closed)", () => {
		expect(isOfflineAllowedUrl("https://api.github.com/repos")).toBe(false);
		expect(isOfflineAllowedUrl("https://registry.npmjs.org/x")).toBe(false);
		expect(isOfflineAllowedUrl("not a url")).toBe(false);
		expect(isOfflineAllowedUrl("")).toBe(false);
	});
});

describe("offlineChildEnv", () => {
	it("black-holes proxies but exempts loopback", () => {
		const env = offlineChildEnv();
		expect(env.PI_WEB_OFFLINE).toBe("1");
		for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
			expect(env[k]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		}
		expect(env.NO_PROXY).toContain("127.0.0.1");
		expect(env.NO_PROXY).toContain("localhost");
	});
});

describe("messages", () => {
	it("blocked message and system prompt are English and name the env var", () => {
		expect(OFFLINE_BLOCKED_MESSAGE).toContain("PI_WEB_OFFLINE");
		expect(OFFLINE_SYSTEM_PROMPT).toContain("OFFLINE MODE");
		expect(OFFLINE_BLOCKED_MESSAGE).not.toMatch(/[一-鿿]/);
		expect(OFFLINE_SYSTEM_PROMPT).not.toMatch(/[一-鿿]/);
	});
});
