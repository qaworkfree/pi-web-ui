import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { appUrl } from "./base-url";
import { clearAuthToken, withToken } from "./auth-token";
import { useT } from "./i18n";

interface AuthStatus {
	configured: boolean;
	passwordLogin: boolean;
	authenticated: boolean;
	user?: string;
	role?: "admin" | "user";
}
const AuthContext = createContext<{
	status: AuthStatus;
	logout: () => Promise<void>;
	refresh: () => Promise<void>;
} | null>(null);
export function useAuth() {
	return useContext(AuthContext);
}

export function AuthGate({ children }: { children: ReactNode }) {
	const t = useT();
	const [status, setStatus] = useState<AuthStatus | null>(null);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [unavailable, setUnavailable] = useState(false);
	const refresh = useCallback(async (): Promise<void> => {
		try {
			const response = await fetch(withToken(appUrl("/api/auth/status")), { credentials: "include" });
			if (!response.ok) throw new Error("Authentication status unavailable");
			const next = (await response.json()) as AuthStatus;
			if (typeof next.configured !== "boolean" || typeof next.authenticated !== "boolean")
				throw new Error("Invalid authentication status");
			setStatus(next);
			setUnavailable(false);
		} catch {
			setUnavailable(true);
		}
	}, []);
	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 60_000);
		const check = () => void refresh();
		window.addEventListener("focus", check);
		window.addEventListener("pi-auth-expired", check);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", check);
			window.removeEventListener("pi-auth-expired", check);
		};
	}, [refresh]);
	const logout = useCallback(async () => {
		const response = await fetch(withToken(appUrl("/api/auth/logout")), { method: "POST", credentials: "include" });
		if (!response.ok) throw new Error("Logout failed");
		clearAuthToken();
		setStatus((current) => (current ? { ...current, authenticated: false, user: undefined, role: undefined } : null));
		await refresh();
	}, [refresh]);
	const login = async (event: FormEvent): Promise<void> => {
		event.preventDefault();
		setLoading(true);
		setError("");
		try {
			const response = await fetch(appUrl("/api/auth/login"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "include",
				body: JSON.stringify({ username, password }),
			});
			if (!response.ok) {
				setError(t("authInvalid"));
				return;
			}
			setPassword("");
			await refresh();
		} catch {
			setError(t("authUnavailable"));
		} finally {
			setLoading(false);
		}
	};
	if (status && !unavailable && (!status.configured || status.authenticated))
		return <AuthContext.Provider value={{ status, logout, refresh }}>{children}</AuthContext.Provider>;
	return (
		<main className="auth-gate">
			{!status || unavailable || !status.passwordLogin ? (
				<div className="auth-card" role="status">
					<p>{unavailable ? t("authUnavailable") : !status ? t("loading") : t("authTokenRequired")}</p>
					<button type="button" onClick={() => void refresh()}>
						{t("authRefresh")}
					</button>
				</div>
			) : (
				<form className="auth-card" onSubmit={login}>
					<h1>{t("authSignIn")}</h1>
					<p>{t("authHint")}</p>
					<label>
						{t("authUsername")}
						<input
							autoComplete="username"
							maxLength={64}
							required
							value={username}
							onChange={(event) => setUsername(event.target.value)}
						/>
					</label>
					<label>
						{t("authPassword")}
						<input
							type="password"
							autoComplete="current-password"
							maxLength={1024}
							required
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</label>
					{error && (
						<div className="auth-error" role="alert">
							{error}
						</div>
					)}
					<button type="submit" disabled={loading || !username || !password}>
						{loading ? t("loading") : t("authSignIn")}
					</button>
				</form>
			)}
		</main>
	);
}
