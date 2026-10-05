import type { IncomingHttpHeaders } from "node:http";

type OriginRequest = {
	method?: string;
	headers: IncomingHttpHeaders;
	secure?: boolean;
	socket?: unknown;
};

function firstHeader(value: string | string[] | undefined): string {
	return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function forwardedProtocol(request: OriginRequest): string {
	if ((request.socket as { encrypted?: boolean } | undefined)?.encrypted || request.secure) return "https";
	const forwarded = firstHeader(request.headers["x-forwarded-proto"]);
	if (forwarded) return forwarded.split(",", 1)[0]?.trim().toLowerCase() === "https" ? "https" : "http";
	return "http";
}

function requestOrigin(request: OriginRequest): string | undefined {
	const host = firstHeader(request.headers["x-forwarded-host"]) || firstHeader(request.headers.host);
	return host ? `${forwardedProtocol(request)}://${host}` : undefined;
}

function originOf(value: string): string | undefined {
	try {
		const url = new URL(value);
		return `${url.protocol}//${url.host}`;
	} catch {
		return undefined;
	}
}

/** Browser state-changing requests must come from this server's own origin.
 * Requests without Origin/Referer remain compatible with non-browser clients. */
export function sameOriginStateChange(request: OriginRequest): boolean {
	if (!request.method || !/^(POST|PUT|PATCH|DELETE)$/i.test(request.method)) return true;
	const expected = requestOrigin(request);
	if (!expected) return false;
	const origin = firstHeader(request.headers.origin);
	if (origin) return origin !== "null" && originOf(origin) === originOf(expected);
	const referer = firstHeader(request.headers.referer);
	if (referer) return originOf(referer) === originOf(expected);
	return true;
}
