import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { checkWorkfreeDeployment, deploymentSessionCookie } from "../../scripts/check-workfree-deployment.mjs";

async function fixture(
	run: (baseUrl: string, observed: { logouts: number; logins: number }) => Promise<void>,
	mode = "ok",
) {
	let authenticated = false;
	const observed = { logouts: 0, logins: 0 };
	const sockets = new WebSocketServer({ noServer: true });
	const server = createServer(async (req, res) => {
		// Each case restarts this fixture; do not reuse pooled sockets from a previous case.
		res.setHeader("Connection", "close");
		const path = req.url?.replace(/^\/pi\//, "/");
		const hasCookie = req.headers.cookie === "pi_web_session=fixture-secret" && authenticated;
		if (path === "/api/health") {
			if (mode === "redirect") {
				res.writeHead(302, { Location: "http://user:should-not-print@localhost/private" });
				res.end();
				return;
			}
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ piVersion: "1.0.2" }));
			return;
		}
		if (path === "/api/auth/sessions") {
			res.writeHead(mode === "public-http" || hasCookie ? 200 : 401);
			res.end("sessions");
			return;
		}
		if (path === "/api/auth/login") {
			observed.logins++;
			if (mode === "timeout") return;
			let body = "";
			for await (const chunk of req) body += chunk;
			const credentials = JSON.parse(body);
			if (credentials.password !== "test-password") {
				res.writeHead(401);
				res.end("test-password upstream body must not appear");
				return;
			}
			authenticated = true;
			res.setHeader(
				"Set-Cookie",
				mode === "bad-cookie"
					? "pi_web_session=fixture-secret; SameSite=Lax"
					: "pi_web_session=fixture-secret; HttpOnly; SameSite=Lax",
			);
			res.end("logged in");
			return;
		}
		if (path === "/api/auth/logout") {
			if (req.headers.origin === "https://workfree-csrf-check.invalid" && mode !== "bad-csrf") {
				res.writeHead(403);
				res.end();
				return;
			}
			observed.logouts++;
			authenticated = false;
			if (mode !== "bad-revocation") for (const ws of sockets.clients) ws.close(4001);
			res.end("logged out");
			return;
		}
		res.writeHead(404);
		res.end();
	});
	server.on("upgrade", (req, socket, head) => {
		const valid = req.headers.cookie === "pi_web_session=fixture-secret" && authenticated;
		if (!valid && mode !== "public-ws") {
			socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		sockets.handleUpgrade(req, socket, head, (ws) => {
			if (mode === "early-close") {
				ws.close();
				return;
			}
			ws.on("message", (raw) => {
				const hello = JSON.parse(raw.toString());
				ws.send("null"); // Ignore non-protocol JSON before the actual snapshot.
				ws.send(
					JSON.stringify({
						type: "snapshot",
						state:
							mode === "bad-snapshot" ? {} : { clientId: hello.clientId, sessionId: "fixture-session", messages: [] },
					}),
				);
			});
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(8993, "127.0.0.1", resolve);
	});
	try {
		await run("http://127.0.0.1:8993/pi", observed);
	} finally {
		for (const ws of sockets.clients) ws.terminate();
		await new Promise<void>((resolve) => sockets.close(() => resolve()));
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
const credentials = { username: "validation", password: "test-password", expectedPiVersion: "1.0.2" };
describe("running deployment checks", () => {
	it("validates real HTTP/WS traffic with a reverse-proxy prefix and revokes only its own session", async () => {
		await fixture(async (baseUrl, observed) => {
			const report = await checkWorkfreeDeployment({ baseUrl, ...credentials });
			expect(report).toMatchObject({ passed: true, piVersion: "1.0.2", transport: "loopback HTTP/WS" });
			expect(report.checks).toHaveLength(6);
			expect(report.unverified).toContain("GPU execution");
			expect(JSON.stringify(report)).not.toMatch(/fixture-secret|test-password|validation/);
			expect(observed).toEqual({ logins: 1, logouts: 1 });
		});
	});
	it.each([
		["public-http", /Anonymous HTTP denial/],
		["public-ws", /Anonymous WebSocket access/],
		["redirect", /redirect/],
		["bad-cookie", /cookie must/],
		["bad-csrf", /CSRF denial/],
		["early-close", /closed before a snapshot/],
		["bad-snapshot", /invalid client state/],
		["bad-revocation", /close.*WebSocket/],
		["timeout", /timeout/],
	] as const)("rejects %s without including credentials or response bodies", async (mode, error) => {
		await fixture(async (baseUrl, observed) => {
			const result = checkWorkfreeDeployment({
				baseUrl,
				...credentials,
				timeoutMs: mode === "bad-revocation" || mode === "timeout" ? 500 : 5000,
			});
			await expect(result).rejects.toThrow(error);
			await expect(result).rejects.not.toThrow(/fixture-secret|test-password|should-not-print/);
			if (["bad-cookie", "bad-csrf", "early-close", "bad-snapshot"].includes(mode))
				expect(observed.logouts).toBe(mode === "bad-csrf" ? 2 : 1);
		}, mode);
	});
	it("rejects a different loaded SDK before sending login credentials", async () => {
		await fixture(async (baseUrl, observed) => {
			await expect(checkWorkfreeDeployment({ baseUrl, ...credentials, expectedPiVersion: "wrong" })).rejects.toThrow(
				/Loaded agent version/,
			);
			expect(observed.logins).toBe(0);
		});
	});
	it.each([
		"http://host.ts.net",
		"https://user:password@host.ts.net",
		"https://host.ts.net/?token=secret",
		"file:///tmp/ui",
	])("rejects unsafe URL %s before connecting", async (baseUrl) => {
		await expect(checkWorkfreeDeployment({ baseUrl, ...credentials })).rejects.toThrow(/HTTPS|credentials|HTTP/);
	});
	it("rejects missing credentials and invalid deadlines", async () => {
		await expect(checkWorkfreeDeployment({ baseUrl: "http://localhost", username: "", password: "" })).rejects.toThrow(
			/USERNAME/,
		);
		await expect(
			checkWorkfreeDeployment({ baseUrl: "http://localhost", ...credentials, timeoutMs: 0 }),
		).rejects.toThrow(/timeoutMs/);
	});
});

describe("HTTPS cookie requirements", () => {
	it("accepts a secure session cookie while keeping its attributes case-insensitive", () => {
		expect(deploymentSessionCookie(["pi_web_session=secret; httponly; samesite=Lax; SECURE"], true)).toBe(
			"pi_web_session=secret",
		);
	});
	it.each([
		["pi_web_session=secret; HttpOnly; SameSite=Lax"],
		["pi_web_session=secret; Secure; SameSite=Lax"],
		["pi_web_session=secret; Secure; HttpOnly"],
		["pi_web_session=secret; Secure; HttpOnly; SameSite=Lax", "pi_web_token=service-secret"],
		["pi_web_session=secret; Secure; HttpOnly; SameSite=Lax", "pi_web_session=other; Secure; HttpOnly; SameSite=Lax"],
	])("rejects unsafe HTTPS cookie attributes without exposing tokens", (...cookies) => {
		expect(() => deploymentSessionCookie(cookies, true)).toThrow(/cookie/);
		expect(() => deploymentSessionCookie(cookies, true)).not.toThrow(/secret/);
	});
});
