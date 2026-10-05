import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionRecord {
	id: string;
	user: string;
	createdAt: number;
	expiresAt: number;
	userAgent?: string;
	address?: string;
}

export class AuthSessionStore {
	private readonly sessions = new Map<string, SessionRecord>();

	create(
		user: string,
		metadata?: { userAgent?: string; address?: string },
	): { id: string; token: string; expiresAt: number } {
		this.sweep();
		const id = randomBytes(16).toString("base64url");
		const token = randomBytes(32).toString("base64url");
		const createdAt = Date.now();
		const expiresAt = Date.now() + SESSION_TTL_MS;
		this.sessions.set(token, { id, user, createdAt, expiresAt, ...metadata });
		return { id, token, expiresAt };
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

	revokeUser(user: string): void {
		for (const [token, record] of this.sessions) if (record.user === user) this.sessions.delete(token);
	}

	list(
		user: string,
	): Array<{ id: string; user: string; createdAt: number; expiresAt: number; userAgent?: string; address?: string }> {
		this.sweep();
		return [...this.sessions.values()]
			.filter((record) => record.user === user)
			.sort((a, b) => b.createdAt - a.createdAt)
			.map(({ id, user: sessionUser, createdAt, expiresAt, userAgent, address }) => ({
				id,
				user: sessionUser,
				createdAt,
				expiresAt,
				...(userAgent ? { userAgent } : {}),
				...(address ? { address } : {}),
			}));
	}

	revokeId(user: string, id: string): boolean {
		for (const [token, record] of this.sessions) {
			if (record.user === user && record.id === id) {
				this.sessions.delete(token);
				return true;
			}
		}
		return false;
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
