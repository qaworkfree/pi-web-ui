#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

/** Validate cookie attributes without including the token in errors or reports. */
export function deploymentSessionCookie(cookies, secure) {
	const sessions = cookies.filter((cookie) => cookie.startsWith("pi_web_session="));
	if (sessions.length !== 1 || cookies.some((cookie) => cookie.startsWith("pi_web_token=")))
		throw new Error("Login must issue exactly one session cookie and no service-token cookie");
	const parts = sessions[0].split(";").map((part) => part.trim());
	const attributes = new Set(parts.slice(1).map((part) => part.toLowerCase()));
	if (!attributes.has("httponly") || !attributes.has("samesite=lax") || (secure && !attributes.has("secure")))
		throw new Error("Login cookie must be HttpOnly, SameSite=Lax and Secure over HTTPS");
	if (!parts[0].slice("pi_web_session=".length)) throw new Error("Login session cookie is empty");
	return parts[0];
}

/** Probe an already running UI; create and revoke only this check's login session. */
export async function checkWorkfreeDeployment({
	baseUrl = process.env.WORKFREE_UI_URL,
	username = process.env.WORKFREE_UI_USERNAME,
	password = process.env.WORKFREE_UI_PASSWORD,
	expectedPiVersion = process.env.WORKFREE_EXPECT_PI_VERSION,
	timeoutMs = 30_000,
} = {}) {
	let base;
	try {
		base = new URL(baseUrl);
	} catch {
		throw new Error("Set WORKFREE_UI_URL to the running UI's HTTP(S) address");
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
	if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
		throw new Error("Use an HTTP(S) UI URL without embedded credentials, query or fragment");
	if (base.protocol !== "https:" && !loopback) throw new Error("Remote deployment checks require HTTPS");
	if (!username || !password)
		throw new Error("Set WORKFREE_UI_USERNAME and WORKFREE_UI_PASSWORD locally; do not send credentials in chat");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
		throw new Error("timeoutMs must be between 1 and 120000");
	base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
	const endpoint = (path) => new URL(path, base);
	const signal = AbortSignal.timeout(timeoutMs);
	const checks = [];
	let cookie;
	let socket;
	let loggedOut = false;
	const request = async (path, expected, label, options = {}, requestSignal = signal) => {
		let response;
		try {
			response = await fetch(endpoint(path), { ...options, signal: requestSignal, redirect: "error" });
		} catch {
			throw new Error(`${label}: connection, TLS, redirect or timeout failure`);
		}
		if (response.status !== expected) {
			await response.body?.cancel();
			throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}`);
		}
		return response;
	};
	const discard = async (response) => {
		await response.body?.cancel();
	};
	const wsUrl = endpoint("ws");
	wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
	const connect = (authenticated) =>
		new Promise((resolve, reject) => {
			const clientId = `deployment-check-${randomUUID()}`;
			let requestedSnapshot = false;
			const ws = new WebSocket(wsUrl, {
				headers: { Origin: base.origin, ...(authenticated ? { Cookie: cookie } : {}) },
				followRedirects: false,
				maxPayload: 1024 * 1024,
			});
			const fail = () => {
				ws.terminate();
				reject(new Error("WebSocket validation: connection, TLS or timeout failure"));
			};
			const abort = () => fail();
			const cleanup = () => signal.removeEventListener("abort", abort);
			signal.addEventListener("abort", abort, { once: true });
			ws.on("error", () => {
				cleanup();
				reject(new Error("WebSocket validation: connection, TLS or protocol failure"));
			});
			ws.on("close", () => {
				cleanup();
				reject(new Error("WebSocket validation: connection closed before a snapshot"));
			});
			ws.on("unexpected-response", (_request, response) => {
				cleanup();
				const status = response.statusCode;
				response.destroy();
				ws.terminate();
				if (!authenticated && status === 401) resolve(undefined);
				else reject(new Error(`WebSocket validation: unexpected HTTP ${status}`));
			});
			ws.on("open", () => {
				if (!authenticated) {
					cleanup();
					ws.terminate();
					reject(new Error("Anonymous WebSocket access must be denied"));
					return;
				}
				socket = ws;
				ws.send(JSON.stringify({ type: "hello", clientId }));
			});
			ws.on("message", (raw) => {
				let message;
				try {
					message = JSON.parse(raw);
				} catch {
					return;
				}
				if (message?.type === "snapshot_delta" && !requestedSnapshot) {
					requestedSnapshot = true;
					ws.send(JSON.stringify({ type: "get_state" }));
					return;
				}
				if (message?.type === "snapshot") {
					cleanup();
					if (
						message.state?.clientId !== clientId ||
						!Array.isArray(message.state?.messages) ||
						typeof message.state?.sessionId !== "string"
					) {
						ws.terminate();
						reject(new Error("WebSocket validation: invalid client state snapshot"));
						return;
					}
					resolve(ws);
				}
			});
			if (signal.aborted) abort();
		});
	try {
		const healthResponse = await request("api/health", 200, "UI health");
		let health;
		try {
			health = await healthResponse.json();
		} catch {
			throw new Error("UI health returned invalid JSON");
		}
		if (typeof health?.piVersion !== "string" || !health.piVersion)
			throw new Error("UI health does not identify the loaded agent version");
		if (expectedPiVersion && health.piVersion !== expectedPiVersion)
			throw new Error("Loaded agent version differs from WORKFREE_EXPECT_PI_VERSION");
		checks.push("loaded-agent-version");
		await discard(await request("api/auth/sessions", 401, "Anonymous HTTP denial"));
		await connect(false);
		checks.push("anonymous-http-and-websocket-denial");
		const login = await request("api/auth/login", 200, "Password login", {
			method: "POST",
			headers: {
				Origin: base.origin,
				"Content-Type": "application/json",
				"User-Agent": "Workfree deployment validation",
			},
			body: JSON.stringify({ username, password }),
		});
		// Retain only our cookie for cleanup even if attribute validation fails.
		const cookies = login.headers.getSetCookie();
		cookie = cookies.find((value) => value.startsWith("pi_web_session="))?.split(";", 1)[0];
		await discard(login);
		cookie = deploymentSessionCookie(cookies, base.protocol === "https:");
		checks.push("password-login-and-cookie-attributes");
		await discard(await request("api/auth/sessions", 200, "Authenticated session", { headers: { Cookie: cookie } }));
		await connect(true);
		checks.push("authenticated-http-and-websocket-snapshot");
		await discard(
			await request("api/auth/logout", 403, "Cross-origin CSRF denial", {
				method: "POST",
				headers: { Cookie: cookie, Origin: "https://workfree-csrf-check.invalid" },
			}),
		);
		await discard(
			await request("api/auth/sessions", 200, "Session survives rejected cross-origin logout", {
				headers: { Cookie: cookie },
			}),
		);
		checks.push("cross-origin-write-denial");
		const closed = new Promise((resolve, reject) => {
			const abort = () => reject(new Error("Logout did not close the authenticated WebSocket before the deadline"));
			signal.addEventListener("abort", abort, { once: true });
			socket.once("close", (code) => {
				signal.removeEventListener("abort", abort);
				resolve(code);
			});
			if (signal.aborted) abort();
		});
		// Handle a deadline rejection immediately, including while HTTP logout waits.
		closed.catch(() => {});
		await discard(
			await request("api/auth/logout", 200, "Logout", {
				method: "POST",
				headers: { Cookie: cookie, Origin: base.origin },
			}),
		);
		loggedOut = true;
		if ((await closed) !== 4001) throw new Error("Logout did not revoke the open WebSocket with code 4001");
		await discard(await request("api/auth/sessions", 401, "Logged-out HTTP denial", { headers: { Cookie: cookie } }));
		checks.push("logout-http-and-open-websocket-revocation");
		return {
			passed: true,
			checkedAt: new Date().toISOString(),
			clientPlatform: platform(),
			targetOrigin: base.origin,
			transport: base.protocol === "https:" ? "HTTPS/WSS" : "loopback HTTP/WS",
			piVersion: health.piVersion,
			checks,
			unverified: [
				"model inference/tool calls",
				"GPU execution",
				"browser rendering",
				"tailnet ACLs and second-device identity",
			],
		};
	} finally {
		socket?.terminate();
		if (cookie && !loggedOut) {
			try {
				await discard(
					await request(
						"api/auth/logout",
						200,
						"Validation-session cleanup",
						{ method: "POST", headers: { Cookie: cookie, Origin: base.origin } },
						AbortSignal.timeout(3000),
					),
				);
			} catch {
				/* A failed cleanup is not a passing validation; server-side session management remains available. */
			}
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		console.log(JSON.stringify(await checkWorkfreeDeployment(), null, 2));
	} catch (error) {
		console.error(`Deployment check failed: ${error instanceof Error ? error.message : "unknown failure"}`);
		process.exitCode = 1;
	}
}
