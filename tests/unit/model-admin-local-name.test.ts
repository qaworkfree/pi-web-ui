import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAdminService, type ModelAdminHost } from "../../server/model-admin.js";
import type { ServerMessage } from "../../server/protocol.js";

const id = "workfree-local";
const filename = "Qwen3-2B-Q4_K_M.gguf";
const rows = [{ id, owned_by: "llamacpp" }];

function mockEndpoint(data: unknown[], props: unknown, propsStatus = 200) {
	const fetch = vi.fn(async (url: string) =>
		url.endsWith("/props")
			? new Response(JSON.stringify(props), { status: propsStatus })
			: new Response(JSON.stringify({ data })),
	);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("llama.cpp model names", () => {
	it.each([
		["http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/props", `D:\\IA\\modelos-llamacpp\\${filename}`],
		["http://127.0.0.1:8080/llama/v1/", "http://127.0.0.1:8080/llama/props", `/models/${filename}`],
		["http://127.0.0.1:8080/llama", "http://127.0.0.1:8080/llama/props", `/models/${filename}`],
	])("shows the file basename and retains the request alias for %s", async (base, propsUrl, path) => {
		const fetch = mockEndpoint(rows, { model_alias: id, model_path: path });
		const models = await ModelAdminService.probeModelsEndpoint(base, "fixture-key", true);
		expect(models).toEqual([{ id, name: filename }]);
		expect(JSON.stringify(models)).not.toContain(path);
		expect(fetch).toHaveBeenLastCalledWith(
			propsUrl,
			expect.objectContaining({ headers: { Authorization: "Bearer fixture-key" }, redirect: "error" }),
		);
	});

	it("retains the prefix when the catalog needs its /v1 fallback", async () => {
		const fetch = mockEndpoint(rows, { model_alias: id, model_path: `/models/${filename}` });
		fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
		expect(await ModelAdminService.probeModelsEndpoint("http://127.0.0.1:8080/llama")).toEqual([
			{ id, name: filename },
		]);
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([
			"http://127.0.0.1:8080/llama/models",
			"http://127.0.0.1:8080/llama/v1/models",
			"http://127.0.0.1:8080/llama/props",
		]);
	});

	it("does not probe unrelated cloud providers", async () => {
		const fetch = mockEndpoint([{ id: "qwen3", name: "Qwen3", owned_by: "cloud" }], {});
		expect(await ModelAdminService.probeModelsEndpoint("https://fixture.invalid/v1")).toEqual([
			{ id: "qwen3", name: "Qwen3" },
		]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([404, 401, 503])("falls back to the reported id when /props returns HTTP %s", async (status) => {
		mockEndpoint(rows, { error: "unavailable" }, status);
		expect(await ModelAdminService.probeModelsEndpoint("http://127.0.0.1:8080/v1")).toEqual([{ id, name: id }]);
	});

	it.each(["null", "not JSON"])("keeps discovery working for an invalid /props response: %s", async (body) => {
		const fetch = mockEndpoint(rows, {});
		fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: rows })));
		fetch.mockResolvedValueOnce(new Response(body));
		expect(await ModelAdminService.probeModelsEndpoint("http://127.0.0.1:8080/v1")).toEqual([{ id, name: id }]);
	});

	it("keeps discovery working when the optional request fails", async () => {
		const fetch = mockEndpoint(rows, {});
		fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: rows })));
		fetch.mockRejectedValueOnce(new Error("redirect rejected"));
		expect(await ModelAdminService.probeModelsEndpoint("http://127.0.0.1:8080/v1")).toEqual([{ id, name: id }]);
	});

	it("does not label unrelated router models with the one loaded file", async () => {
		mockEndpoint([...rows, { id: "other", owned_by: "llamacpp" }], {
			model_alias: id,
			model_path: `/models/${filename}`,
		});
		expect(await ModelAdminService.probeModelsEndpoint("http://127.0.0.1:8080/v1")).toEqual([
			{ id: "other", name: "other" },
			{ id, name: filename },
		]);
	});

	it.each([
		{ model_alias: "different", model_path: `/models/${filename}` },
		{ model_alias: id, model_path: "/models/not-a-gguf.bin" },
		{ model_alias: id, model_path: "/models/control\nname.gguf" },
	])("rejects inconsistent or invalid file metadata: %j", async (props) => {
		mockEndpoint(rows, props);
		expect(await ModelAdminService.probeModelsEndpoint("http://127.0.0.1:8080/v1")).toEqual([{ id, name: id }]);
	});

	it("matches a declared alias and supports a single model without alias metadata", async () => {
		mockEndpoint([{ id, aliases: ["actual-alias"], owned_by: "llama.cpp" }], {
			model_alias: "actual-alias",
			model_path: `/models/${filename}`,
		});
		expect(await ModelAdminService.probeModelsEndpoint("http://127.0.0.1:8080/v1")).toEqual([{ id, name: filename }]);
		mockEndpoint(rows, { model_path: `/models/${filename}` });
		expect(await ModelAdminService.probeModelsEndpoint("http://127.0.0.1:8080/v1")).toEqual([{ id, name: filename }]);
	});

	it("refreshes stale saved names over real HTTP, preserving credentials, routing and capabilities", async () => {
		const requests: string[] = [];
		const server = createServer((request, response) => {
			requests.push(request.url ?? "");
			expect(request.headers.authorization).toBe("Bearer fixture-key");
			response.setHeader("Content-Type", "application/json");
			response.end(
				JSON.stringify(
					request.url === "/props" ? { model_alias: id, model_path: `/models/${filename}` } : { data: rows },
				),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const agentDir = mkdtempSync(join(tmpdir(), "pi-model-real-name-"));
		try {
			const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
			const original = {
				baseUrl,
				api: "openai-completions",
				apiKey: "fixture-key",
				models: [
					{
						id,
						name: "Workfree local GGUF",
						contextWindow: 8192,
						maxTokens: 2048,
						compat: { supportsStrictMode: false },
					},
				],
			};
			writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: original } }));
			const notices: ServerMessage[] = [];
			const refresh = vi.fn(async () => {});
			const host: ModelAdminHost = {
				agentDir,
				emit: (message) => notices.push(message),
				flushSnapshot: () => {},
				isDisposed: () => false,
				modelRuntime: () => ({ refresh, setRuntimeApiKey: async () => {} }) as unknown as ModelRuntime,
				invalidatePiConfig: () => {},
				pushModels: async () => {},
			};
			await new ModelAdminService(host).refreshProviderModels("local", 7);
			const config = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
			expect(config.providers.local).toEqual({ ...original, models: [{ ...original.models[0], name: filename }] });
			expect(requests).toEqual(["/v1/models", "/props"]);
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(notices).toContainEqual(
				expect.objectContaining({ type: "refresh_provider_result", ok: true, added: 0, total: 1 }),
			);
			expect(JSON.stringify(notices)).not.toContain("fixture-key");
			expect(JSON.stringify(notices)).not.toContain("/models/");
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
