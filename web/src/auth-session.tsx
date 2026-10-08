import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
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
	// Uncontrolled inputs read via refs on submit: browser AUTOFILL writes the
	// DOM value without firing React onChange, so a controlled value + a
	// "disabled until state is non-empty" submit button leaves the form stuck
	// with a not-allowed cursor even though both fields look filled.
	const usernameRef = useRef<HTMLInputElement>(null);
	const passwordRef = useRef<HTMLInputElement>(null);
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
		const username = usernameRef.current?.value.trim() ?? "";
		const password = passwordRef.current?.value ?? "";
		if (!username || !password) {
			setError(t("authInvalid"));
			return;
		}
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
			if (passwordRef.current) passwordRef.current.value = "";
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
						<input ref={usernameRef} name="username" autoComplete="username" maxLength={64} required />
					</label>
					<label>
						{t("authPassword")}
						<input
							ref={passwordRef}
							name="password"
							type="password"
							autoComplete="current-password"
							maxLength={1024}
							required
						/>
					</label>
					{error && (
						<div className="auth-error" role="alert">
							{error}
						</div>
					)}
					{/* Only `loading` gates the button: emptiness is enforced by the
					    `required` attributes + the submit-time check, so autofilled
					    credentials (no React onChange) can still be submitted. */}
					<button type="submit" disabled={loading}>
						{loading ? t("loading") : t("authSignIn")}
					</button>
				</form>
			)}
		</main>
	);
}
