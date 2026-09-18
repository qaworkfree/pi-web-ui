/**
 * `pi_web_token` cookie helpers.
 *
 * The `Secure` attribute is set only when the request arrived over TLS.
 * Always setting it would break plaintext HTTP (loopback default); never
 * setting it leaks the token over the network on HTTPS deployments.
 */
type TlsProbe = {
	socket?: unknown;
	secure?: boolean;
	headers?: Record<string, string | string[] | undefined>;
};

/** True when the browser connection is TLS: direct (`socket.encrypted`,
 *  express `req.secure`) or via a TLS-terminating proxy (`x-forwarded-proto`
 *  / RFC 7239 `forwarded`). */
export function isTlsRequest(req: TlsProbe): boolean {
	if ((req.socket as { encrypted?: boolean } | undefined | null)?.encrypted) return true;
	if (req.secure === true) return true;
	const proto = req.headers?.["x-forwarded-proto"];
	const first = Array.isArray(proto) ? proto[0] : proto;
	if (typeof first === "string" && first.split(",")[0]?.trim().toLowerCase() === "https") return true;
	const fwd = req.headers?.forwarded;
	const fwdFirst = Array.isArray(fwd) ? fwd[0] : fwd;
	if (typeof fwdFirst === "string" && /(?:^|[;,]\s*)proto=https(?:[;,]|$)/i.test(fwdFirst)) return true;
	return false;
}

/** Build the `Set-Cookie` value for `pi_web_token`. `encodedValue` is already
 *  `encodeURIComponent`'d (or `""` when clearing). */
export function buildPiWebTokenCookie(encodedValue: string, maxAge: number, secure: boolean): string {
	return `pi_web_token=${encodedValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
