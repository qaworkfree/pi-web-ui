import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { FiRefreshCw, FiTrash2, FiUserPlus, FiUsers } from "react-icons/fi";
import { appUrl } from "../base-url";

interface AuthUser {
	username: string;
	role: "admin" | "user";
}

export function UserManagementPanel() {
	const [users, setUsers] = useState<AuthUser[]>([]);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	const request = useCallback(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		return fetch(input, {
			...init,
			credentials: "include",
			headers: { "Content-Type": "application/json", ...init?.headers },
		});
	}, []);

	const load = useCallback(async () => {
		setError("");
		const response = await request(appUrl("/api/auth/users"));
		if (!response.ok) {
			setError(
				response.status === 403 ? "Administrator access is required." : "Authentication management is unavailable.",
			);
			return;
		}
		const data = (await response.json()) as { users?: AuthUser[] };
		setUsers(data.users ?? []);
	}, [request]);

	useEffect(() => {
		void load();
	}, [load]);

	const addUser = async (event: FormEvent): Promise<void> => {
		event.preventDefault();
		setLoading(true);
		setError("");
		try {
			const response = await request(appUrl("/api/auth/users"), {
				method: "POST",
				body: JSON.stringify({ username, password }),
			});
			const data = (await response.json()) as { error?: string; users?: AuthUser[] };
			if (!response.ok) throw new Error(data.error ?? "Unable to add user");
			setUsers(data.users ?? []);
			setUsername("");
			setPassword("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Unable to add user");
		} finally {
			setLoading(false);
		}
	};

	const removeUser = async (name: string): Promise<void> => {
		if (!window.confirm(`Remove user "${name}"? Their active sessions will be revoked.`)) return;
		const response = await request(appUrl(`/api/auth/users/${encodeURIComponent(name)}`), { method: "DELETE" });
		const data = (await response.json()) as { error?: string; users?: AuthUser[] };
		if (!response.ok) {
			setError(data.error ?? "Unable to remove user");
			return;
		}
		setUsers(data.users ?? []);
	};

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiUsers className="set-section-icon" />
				Users
				<button type="button" className="set-save-btn" onClick={() => void load()} title="Refresh users">
					<FiRefreshCw />
				</button>
			</div>
			<p className="set-hint">Administrators can add accounts and revoke access by removing users.</p>
			{error && <div className="auth-error">{error}</div>}
			<form className="user-add-form" onSubmit={addUser}>
				<input
					className="set-input"
					placeholder="Username"
					value={username}
					onChange={(event) => setUsername(event.target.value)}
				/>
				<input
					className="set-input"
					type="password"
					placeholder="Password (8+ characters)"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
				/>
				<button type="submit" className="set-add-btn" disabled={loading || !username || password.length < 8}>
					<FiUserPlus /> Add user
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
							title={`Remove ${user.username}`}
							onClick={() => void removeUser(user.username)}
						>
							<FiTrash2 />
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
