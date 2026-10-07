import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAdminService, type ModelAdminHost } from "../../server/model-admin.js";

const dirs: string[] = [];
function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-local-discovery-"));
	dirs.push(agentDir);
	const path = join(agentDir, "models.json");
	const config = {
		extra: "preserve",
		providers: {
			local: {
				baseUrl: "http://127.0.0.1:8080/v1",
				apiKey: "fixture-key",
				models: [
					{ id: "old-alias", name: "Old model", contextWindow: 8192 },
					{ id: "qwen", name: "Made up name", contextWindow: 4096, compat: { supportsStrictMode: false } },
				],
			},
			cloud: { baseUrl: "https://provider.invalid/v1", models: [{ id: "cloud" }] },
		},
	};
	writeFileSync(path, JSON.stringify(config));
	const refresh = vi.fn(async () => {});
	const pushModels = vi.fn(async () => {});
	const host: ModelAdminHost = {
		agentDir,
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		isDisposed: () => false,
		modelRuntime: () => ({ refresh }) as unknown as ModelRuntime,
		invalidatePiConfig: vi.fn(),
		pushModels,
	};
	return { config, path, refresh, pushModels, service: new ModelAdminService(host) };
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("automatic local model discovery", () => {
	it("discovers all advertised filenames using GET only; preserves manual rows, capabilities and credentials", async () => {
		const { service, config, path, refresh, pushModels } = fixture();
		const fetch = vi.fn(
			async (url: string) =>
				new Response(
					JSON.stringify(
						url.endsWith("/props")
							? { role: "router", models_autoload: true }
							: {
									data: [
										{
											id: "qwen",
											owned_by: "llamacpp",
											status: { value: "unloaded", args: ["-m", "D:\\IA\\modelos-llamacpp\\Qwen.gguf"] },
										},
										{
											id: "other",
											owned_by: "llamacpp",
											status: { value: "unloaded", args: ["--model", "/models/Other.gguf"] },
										},
									],
								},
					),
				),
		);
		vi.stubGlobal("fetch", fetch);
		const live = await service.discoverLocalModels();
		expect([...live.get("local")!]).toEqual(["other", "qwen"]);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.extra).toBe("preserve");
		expect(saved.providers.cloud).toEqual(config.providers.cloud);
		expect(saved.providers.local.apiKey).toBe("fixture-key");
		expect(saved.providers.local.models).toEqual([
			config.providers.local.models[0],
			{ ...config.providers.local.models[1], name: "Qwen.gguf" },
			{ id: "other", name: "Other.gguf" },
		]);
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([
			"http://127.0.0.1:8080/v1/models",
			"http://127.0.0.1:8080/props",
		]);
		for (const call of fetch.mock.calls as unknown as [string, RequestInit][])
			expect(call[1].method ?? "GET").toBe("GET");
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(pushModels).not.toHaveBeenCalled(); // No recursive list/discovery loop.
		await service.discoverLocalModels();
		expect(refresh).toHaveBeenCalledTimes(1); // No rewrite when unchanged.
	});
	it("keeps saved models intact when the server is offline", async () => {
		const { service, path, refresh } = fixture();
		const before = readFileSync(path, "utf8");
		vi.spyOn(ModelAdminService, "probeModelsEndpoint").mockRejectedValue(new Error("offline"));
		expect((await service.discoverLocalModels()).size).toBe(0);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(refresh).not.toHaveBeenCalled();
	});
	it.each(["delete", "edit"])("preserves a concurrent provider %s", async (operation) => {
		const { service, config, path, refresh } = fixture();
		vi.spyOn(ModelAdminService, "probeModelsEndpoint").mockImplementation(async () => {
			if (operation === "delete") Reflect.deleteProperty(config.providers, "local");
			else config.providers.local.baseUrl = "http://127.0.0.1:9090/v1";
			writeFileSync(path, JSON.stringify(config));
			return [{ id: "qwen", name: "Qwen.gguf" }];
		});
		expect((await service.discoverLocalModels()).size).toBe(0);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(config);
		expect(refresh).not.toHaveBeenCalled();
	});
});
