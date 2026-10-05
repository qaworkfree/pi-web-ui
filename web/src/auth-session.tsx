import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { appUrl } from "./base-url";
import { withToken } from "./auth-token";

interface AuthStatus {
	configured: boolean;
	authenticated: boolean;
	user?: string;
}

export function AuthGate({ children }: { children: ReactNode }) {
	const [status, setStatus] = useState<AuthStatus | null>(null);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	const refresh = async (): Promise<void> => {
		try {
			const response = await fetch(withToken(appUrl("/api/auth/status")), { credentials: "include" });
			if (!response.ok) {
				setStatus({ configured: false, authenticated: true });
				return;
			}
			setStatus((await response.json()) as AuthStatus);
		} catch {
			setStatus({ configured: false, authenticated: true });
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

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
			if (!response.ok) throw new Error("Invalid username or password");
			setPassword("");
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Login failed");
		} finally {
			setLoading(false);
		}
	};

	if (!status || !status.configured || status.authenticated) return <>{children}</>;
	return (
		<main className="auth-gate">
			<form className="auth-card" onSubmit={login}>
				<h1>Sign in</h1>
				<p>Authenticate to access your local AI workspace.</p>
				<label>
					Username
					<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
				</label>
				<label>
					Password
					<input
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
				</label>
				{error && <div className="auth-error">{error}</div>}
				<button type="submit" disabled={loading || !username || !password}>
					{loading ? "Signing in…" : "Sign in"}
				</button>
			</form>
		</main>
	);
}
