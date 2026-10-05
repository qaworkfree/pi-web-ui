import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionRecord {
	user: string;
	expiresAt: number;
}

export class AuthSessionStore {
	private readonly sessions = new Map<string, SessionRecord>();

	create(user: string): { token: string; expiresAt: number } {
		this.sweep();
		const token = randomBytes(32).toString("base64url");
		const expiresAt = Date.now() + SESSION_TTL_MS;
		this.sessions.set(token, { user, expiresAt });
		return { token, expiresAt };
	}

	get(token: string | undefined): { user: string; expiresAt: number } | undefined {
		if (!token) return undefined;
		const record = this.sessions.get(token);
		if (!record || record.expiresAt <= Date.now()) {
			if (record) this.sessions.delete(token);
			return undefined;
		}
		return { ...record };
	}

	revoke(token: string | undefined): void {
		if (token) this.sessions.delete(token);
	}

	private sweep(): void {
		const now = Date.now();
		for (const [token, record] of this.sessions) if (record.expiresAt <= now) this.sessions.delete(token);
	}
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
	return `pi_web_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function sessionCookieToken(cookieHeader: string | undefined): string {
	if (!cookieHeader) return "";
	for (const part of cookieHeader.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key !== "pi_web_session") continue;
		try {
			return decodeURIComponent(rest.join("=").trim());
		} catch {
			return rest.join("=").trim();
		}
	}
	return "";
}
