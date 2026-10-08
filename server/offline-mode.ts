/**
 * offline-mode.ts — Offline guard (PI_WEB_OFFLINE): deployment-level switch
 * that blocks outbound network access originating from the agent/server, for
 * working on sensitive files.
 *
 * Enforcement layers (fail-closed where the process can enforce it):
 *  1. Server process: `installOfflineFetchGate()` wraps `globalThis.fetch` so
 *     any non-loopback URL is rejected. This covers plugin catalog sync,
 *     preset sharing/catalog fetch, update checks, host.net.fetch and any
 *     other server-side fetch in one place. Loopback (the local llama.cpp
 *     router, the UI's own API) keeps working.
 *  2. Child processes (bash/terminal/eval/git/pip/npm/python): `applyOfflineChildEnv()`
 *     sets a black-hole proxy environment (HTTP(S)_PROXY/ALL_PROXY → a closed
 *     local port) with NO_PROXY for loopback, plus PI_WEB_OFFLINE=1 so
 *     cooperating scripts (tools/local-web.py) refuse outright.
 *  3. Tool gating: browser_page is force-disabled (agent-service) — it drives
 *     the user's real browser, which the proxy env cannot constrain.
 *
 * HONEST LIMIT: a child process making raw TCP connections (ignoring proxy
 * env) can still reach the network. The app cannot change OS firewall rules;
 * for a hard guarantee run `offline-guard.ps1` (Windows Firewall outbound
 * block for this installation's node/python), shipped next to the launcher.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isOfflineMode(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env.PI_WEB_OFFLINE ?? "").trim().toLowerCase();
	return TRUTHY.has(v);
}

/** Loopback-only allowance: localhost names and loopback literals (IPv4 127/8, IPv6 ::1). */
export function isLoopbackHost(hostname: string): boolean {
	const h = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
	if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
	return false;
}

/** URL allowed under the offline guard (loopback http/ws only). */
export function isOfflineAllowedUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return isLoopbackHost(u.hostname);
	} catch {
		return false;
	}
}

export const OFFLINE_BLOCKED_MESSAGE =
	"Offline mode is enabled (PI_WEB_OFFLINE): outbound network access is blocked; only loopback (127.0.0.1/localhost) is allowed.";

/**
 * Black-hole proxy env for child processes. Port 9 ("discard") on loopback is
 * closed on a normal Windows install, so proxy-honoring clients (curl, wget,
 * pip, npm, git-over-https, Python requests…) fail fast instead of reaching
 * the network. NO_PROXY keeps local services (llama router, UI API) working.
 */
export function offlineChildEnv(): Record<string, string> {
	const blackhole = "http://127.0.0.1:9";
	const noProxy = "localhost,127.0.0.1,::1";
	return {
		PI_WEB_OFFLINE: "1",
		HTTP_PROXY: blackhole,
		HTTPS_PROXY: blackhole,
		ALL_PROXY: blackhole,
		http_proxy: blackhole,
		https_proxy: blackhole,
		all_proxy: blackhole,
		NO_PROXY: noProxy,
		no_proxy: noProxy,
	};
}

/** Mutates process.env so every spawned child inherits the black-hole proxy. */
export function applyOfflineChildEnv(env: NodeJS.ProcessEnv = process.env): void {
	for (const [k, v] of Object.entries(offlineChildEnv())) env[k] = v;
}

let fetchGateInstalled = false;

/**
 * Replace globalThis.fetch with a loopback-only gate. Idempotent. Covers all
 * server-side fetch call sites (plugins host.net.fetch, catalog/preset sync,
 * update check) without touching each one.
 */
export function installOfflineFetchGate(): void {
	if (fetchGateInstalled) return;
	fetchGateInstalled = true;
	const realFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : ((input as Request).url ?? "");
		if (!isOfflineAllowedUrl(url)) {
			return Promise.reject(new Error(OFFLINE_BLOCKED_MESSAGE));
		}
		return realFetch(input, init);
	}) as typeof fetch;
}

/** System-prompt section appended when the offline guard is active. */
export const OFFLINE_SYSTEM_PROMPT =
	"\n\n────────── OFFLINE MODE (important) ──────────\n" +
	"This deployment is running with the offline guard enabled for sensitive files.\n" +
	"- All outbound network access is blocked; only loopback services (127.0.0.1/localhost) work.\n" +
	"- Do not attempt web searches, downloads, uploads, API calls, git push/pull to remote hosts, or any other internet access; such commands will fail.\n" +
	"- Never place file contents or user data in URLs or commands that target the network.\n" +
	"- Work strictly with local files and local tools.\n" +
	"──────────\n";
