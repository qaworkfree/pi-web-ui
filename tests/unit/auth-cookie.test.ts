import { describe, expect, it } from "vitest";
import { buildPiWebTokenCookie, isTlsRequest } from "../../server/auth-cookie.js";

describe("isTlsRequest", () => {
	it("明文 HTTP 默认不加 Secure", () => {
		expect(isTlsRequest({ socket: {}, headers: {} })).toBe(false);
		expect(isTlsRequest({ headers: {} })).toBe(false);
	});

	it("直连 TLS（socket.encrypted）判为 TLS", () => {
		expect(isTlsRequest({ socket: { encrypted: true }, headers: {} })).toBe(true);
	});

	it("express req.secure 判为 TLS", () => {
		expect(isTlsRequest({ secure: true, headers: {} })).toBe(true);
	});

	it("x-forwarded-proto=https 判为 TLS（大小写/空格容忍）", () => {
		expect(isTlsRequest({ headers: { "x-forwarded-proto": "https" } })).toBe(true);
		expect(isTlsRequest({ headers: { "x-forwarded-proto": " HTTPS " } })).toBe(true);
		expect(isTlsRequest({ headers: { "x-forwarded-proto": "https, http" } })).toBe(true);
		expect(isTlsRequest({ headers: { "x-forwarded-proto": ["https"] } })).toBe(true);
	});

	it("x-forwarded-proto=http 判为明文", () => {
		expect(isTlsRequest({ headers: { "x-forwarded-proto": "http" } })).toBe(false);
		expect(isTlsRequest({ headers: { "x-forwarded-proto": "http, https" } })).toBe(false);
	});

	it("RFC 7239 Forwarded: proto=https 判为 TLS", () => {
		expect(isTlsRequest({ headers: { forwarded: "for=1.2.3.4;proto=https;host=x" } })).toBe(true);
		expect(isTlsRequest({ headers: { forwarded: "for=1.2.3.4;proto=http;host=x" } })).toBe(false);
	});
});

describe("buildPiWebTokenCookie", () => {
	it("明文不带 Secure（保持 loopback 可用）", () => {
		expect(buildPiWebTokenCookie("abc", 31536000, false)).toBe(
			"pi_web_token=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000",
		);
	});

	it("TLS 写入带 Secure", () => {
		const v = buildPiWebTokenCookie("abc", 31536000, true);
		expect(v).toContain("; Secure");
		expect(v.startsWith("pi_web_token=abc;")).toBe(true);
	});

	it("清除 cookie 两路都跟 Secure 走", () => {
		expect(buildPiWebTokenCookie("", 0, false)).toBe("pi_web_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
		expect(buildPiWebTokenCookie("", 0, true)).toContain("; Secure");
	});
});
