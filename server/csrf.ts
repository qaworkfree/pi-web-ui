import type { IncomingHttpHeaders } from "node:http";
import { isTlsRequest } from "./auth-cookie.js";

type OriginRequest = {
	method?: string;
	headers: IncomingHttpHeaders;
	secure?: boolean;
	socket?: unknown;
};

function firstHeader(value: string | string[] | undefined): string {
	return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

interface OriginOptions {
	trustProxy?: boolean;
	allowedOrigins?: readonly string[];
	requireOrigin?: boolean;
}

export function requestOrigin(request: OriginRequest, options: OriginOptions = {}): string | undefined {
	const forwardedHost = options.trustProxy
		? firstHeader(request.headers["x-forwarded-host"]).split(",", 1)[0]?.trim()
		: "";
	const host = forwardedHost || firstHeader(request.headers.host);
	return host ? originOf(`${isTlsRequest(request, options.trustProxy) ? "https" : "http"}://${host}`) : undefined;
}

function originOf(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
		return `${url.protocol}//${url.host}`;
	} catch {
		return undefined;
	}
}

/** Browser writes must come from the UI origin or an explicit additional origin.
 * Cookie callers require origin metadata; header-authenticated clients may omit it. */
export function sameOriginStateChange(request: OriginRequest, options: OriginOptions = {}): boolean {
	if (!request.method || !/^(POST|PUT|PATCH|DELETE)$/i.test(request.method)) return true;
	return browserOriginAllowed(request, options);
}

export function browserOriginAllowed(request: OriginRequest, options: OriginOptions = {}): boolean {
	const expected = requestOrigin(request, options);
	if (!expected) return false;
	const origin = firstHeader(request.headers.origin);
	const referer = firstHeader(request.headers.referer);
	const source = origin || referer;
	if (!source) return !options.requireOrigin;
	const actual = originOf(source);
	return Boolean(
		actual && (actual === expected || options.allowedOrigins?.some((allowed) => originOf(allowed) === actual)),
	);
}
