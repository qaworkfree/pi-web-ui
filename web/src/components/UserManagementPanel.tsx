import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { FiRefreshCw, FiTrash2, FiUserPlus, FiUsers } from "react-icons/fi";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useAuth } from "../auth-session";
import { useT } from "../i18n";

interface AuthUser {
	username: string;
	role: "admin" | "user";
}
interface AuthSession {
	id: string;
	createdAt: number;
	expiresAt: number;
	userAgent?: string;
	address?: string;
}
export function UserManagementPanel() {
	const t = useT();
	const auth = useAuth();
	const isAdmin = auth?.status.role === "admin";
	const [users, setUsers] = useState<AuthUser[]>([]);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [sessions, setSessions] = useState<AuthSession[]>([]);
	const [currentId, setCurrentId] = useState("");
	const request = useCallback(async (path: string, init?: RequestInit) => {
		const response = await fetch(withToken(appUrl(path)), {
			...init,
			credentials: "include",
			headers: { "Content-Type": "application/json", ...init?.headers },
		});
		if (!response.ok) throw new Error("Authentication operation failed");
		return response;
	}, []);
	const load = useCallback(async () => {
		setError("");
		try {
			const data = (await (await request("/api/auth/sessions")).json()) as {
				sessions: AuthSession[];
				current?: { id: string };
			};
			setSessions(data.sessions);
			setCurrentId(data.current?.id ?? "");
			if (isAdmin) {
				const data = (await (await request("/api/auth/users")).json()) as { users: AuthUser[] };
				setUsers(data.users);
			}
		} catch {
			setError(t("authUnavailable"));
		}
	}, [request, isAdmin, t]);
	useEffect(() => {
		if (auth?.status.user) void load();
	}, [load, auth?.status.user]);
	const perform = async (operation: () => Promise<void>) => {
		setLoading(true);
		setError("");
		try {
			await operation();
		} catch {
			setError(t("authUnavailable"));
		} finally {
			setLoading(false);
		}
	};
	const addUser = async (event: FormEvent) => {
		event.preventDefault();
		await perform(async () => {
			await request("/api/auth/users", { method: "POST", body: JSON.stringify({ username, password }) });
			setUsername("");
			setPassword("");
			await load();
		});
	};
	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiUsers className="set-section-icon" />
				{t("authAccount")}
				<button
					type="button"
					className="set-save-btn"
					disabled={loading || !auth?.status.user}
					onClick={() => void load()}
					title={t("authRefresh")}
					aria-label={t("authRefresh")}
				>
					<FiRefreshCw />
				</button>
			</div>
			{error && (
				<div className="auth-error" role="alert">
					{error}
				</div>
			)}
			{auth?.status.configured && (
				<button type="button" className="set-save-btn" disabled={loading} onClick={() => void perform(auth.logout)}>
					{t("oauthLogout")} {auth.status.user}
				</button>
			)}
			{isAdmin && (
				<>
					<p className="set-hint">{t("authAdminHint")}</p>
					<form className="user-add-form" onSubmit={addUser}>
						<input
							className="set-input"
							aria-label={t("authUsername")}
							placeholder={t("authUsername")}
							autoComplete="off"
							maxLength={64}
							required
							pattern="[A-Za-z0-9_.-]+"
							value={username}
							onChange={(event) => setUsername(event.target.value)}
						/>
						<input
							className="set-input"
							aria-label={t("authPassword")}
							placeholder={t("authPasswordHint")}
							type="password"
							autoComplete="new-password"
							minLength={8}
							maxLength={1024}
							required
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
						<button type="submit" className="set-add-btn" disabled={loading || !username || password.length < 8}>
							<FiUserPlus />
							{t("authAddUser")}
						</button>
					</form>
					<div className="user-list">
						{users.map((user) => (
							<div className="set-card user-row" key={user.username}>
								<span>{user.username}</span>
								<span className="set-hint">{user.role}</span>
								<button
									type="button"
									className="set-icon-btn danger"
									disabled={loading}
									title={t("authRemoveConfirm", { name: user.username })}
									aria-label={t("authRemoveConfirm", { name: user.username })}
									onClick={() => {
										if (window.confirm(t("authRemoveConfirm", { name: user.username })))
											void perform(async () => {
												await request(`/api/auth/users/${encodeURIComponent(user.username)}`, { method: "DELETE" });
												await load();
											});
									}}
								>
									<FiTrash2 />
								</button>
							</div>
						))}
					</div>
				</>
			)}
			{auth?.status.user && (
				<>
					<div className="set-subsection-title">{t("authDevices")}</div>
					<p className="set-hint">{t("authDeviceHint")}</p>
					<div className="user-list">
						{sessions.length === 0 ? (
							<p className="set-hint">{t("authNoDevices")}</p>
						) : (
							sessions.map((session) => (
								<div className="set-card user-row" key={session.id}>
									<span>
										{session.userAgent || t("authUnknownBrowser")}
										{session.id === currentId && <strong> · {t("authCurrentDevice")}</strong>}
										<small className="set-hint">
											{session.address ? ` · ${session.address}` : ""} · {new Date(session.createdAt).toLocaleString()}
										</small>
									</span>
									<button
										type="button"
										className="set-icon-btn danger"
										disabled={loading}
										title={t("authRevoke")}
										aria-label={t("authRevoke")}
										onClick={() => {
											if (window.confirm(t("authRevokeConfirm")))
												void perform(async () => {
													await request(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
													if (session.id === currentId) await auth.refresh();
													else await load();
												});
										}}
									>
										<FiTrash2 />
									</button>
								</div>
							))
						)}
					</div>
				</>
			)}
		</div>
	);
}
