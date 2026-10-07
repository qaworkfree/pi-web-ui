import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelAdminService, type ModelAdminHost } from "../../server/model-admin.js";
import {
	localProfileRow,
	managedLocalProvider,
	readLocalProfiles,
	registerLocalModelHost,
} from "../../server/local-model-profiles.js";
import { boundedPresets, validLocalContext } from "../../web/src/model-context.js";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "context-limits-"));
	dirs.push(agentDir);
	const profilePath = join(agentDir, "profiles.json");
	const profile = {
		id: "Qwen-Q4",
		name: "Qwen-Q4.gguf",
		path: "D:/private/models/Qwen-Q4.gguf",
		contextLimit: 32768,
		contextWindow: 4096,
		maxTokens: 1024,
	};
	writeFileSync(profilePath, JSON.stringify({ modelsDir: "D:/private/models", models: [profile] }));
	vi.stubEnv("PI_WEB_LOCAL_MODEL_PROFILES", profilePath);
	vi.stubEnv("LLAMA_BASE_URL", "http://127.0.0.1:8080");
	const config = {
		extra: "retained",
		providers: {
			"llama.cpp": { models: [{ id: profile.id, contextWindow: 1_000_000 }] },
			local: {
				baseUrl: "http://127.0.0.1:8080/v1",
				apiKey: "test-private",
				models: [{ id: profile.id, compat: { supportsStrictMode: false } }],
			},
			cloud: { models: [{ id: profile.id, contextWindow: 1_000_000 }] },
		},
	};
	const configPath = join(agentDir, "models.json");
	writeFileSync(configPath, JSON.stringify(config));
	const emit = vi.fn();
	const host: ModelAdminHost = {
		agentDir,
		emit,
		flushSnapshot: vi.fn(),
		isDisposed: () => false,
		modelRuntime: () => ({ refresh: vi.fn(async () => {}), getModels: () => [] }) as unknown as ModelRuntime,
		invalidatePiConfig: vi.fn(),
		pushModels: vi.fn(async () => {}),
	};
	return { profile, profilePath, config, configPath, service: new ModelAdminService(host), emit };
}
describe("GGUF context controls", () => {
	it("filters options separately for each GGUF; cloud choices remain available", () => {
		const presets = [{ value: "2048" }, { value: "32768" }, { value: "1000000" }];
		expect(boundedPresets(presets, 2048)).toEqual([presets[0]]);
		expect(boundedPresets(presets, 32768)).toEqual(presets.slice(0, 2));
		expect(boundedPresets(presets)).toEqual(presets);
	});
	it.each(["1000000", "32769", "0", "1", "", "3.5", "NaN"])("rejects invalid custom context %s", (contextWindow) => {
		expect(validLocalContext({ contextLimit: 32768, contextWindow, maxTokens: "1024" })).toBe(false);
	});
	it("accepts actual model limit and rejects output consuming the entire context", () => {
		expect(validLocalContext({ contextLimit: 32768, contextWindow: "32768", maxTokens: "1024" })).toBe(true);
		expect(validLocalContext({ contextLimit: 2048, contextWindow: "2048", maxTokens: "2048" })).toBe(false);
	});
	it("exposes verified selected limits without private model paths or credentials", async () => {
		const { profile, service, emit } = fixture();
		await service.listModelsConfig();
		const event = emit.mock.calls[0][0];
		expect(event.providers[0].models[0]).toMatchObject(localProfileRow(profile));
		expect(event.providers[1].models[0]).toMatchObject(localProfileRow(profile));
		expect(event.providers[2].models[0].contextWindow).toBe(1_000_000);
		expect(JSON.stringify(event)).not.toContain("D:/private");
		expect(JSON.stringify(event)).not.toContain("test-private");
	});
	it("only manages the configured local router, never another local port or cloud", () => {
		fixture();
		expect(managedLocalProvider("llama.cpp")).toBe(true);
		expect(managedLocalProvider("local", "http://localhost:8080/v1")).toBe(true);
		expect(managedLocalProvider("local", "http://localhost:8081/v1")).toBe(false);
		expect(managedLocalProvider("remote", "https://provider.invalid:8080/v1")).toBe(false);
		expect(readLocalProfiles()[0].contextLimit).toBe(32768);
	});
	it("rejects profile changes if the trusted helper is unavailable without modifying models.json", async () => {
		const { service, configPath, config, emit } = fixture();
		vi.stubEnv("PI_WEB_LOCAL_MODEL_PROFILE_SCRIPT", "");
		await service.saveModelConfig("llama.cpp", {
			providerId: "llama.cpp",
			models: [{ id: "Qwen-Q4", contextWindow: 0, maxTokens: 0 }],
		});
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(config);
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
	});
	it("preserves native capabilities and repairs an excessive cached context using verified choices", async () => {
		const { service, configPath, profile, emit } = fixture();
		vi.spyOn(ModelAdminService, "probeModelsEndpoint").mockResolvedValue([{ id: profile.id, name: profile.name }]);
		// Busy clients prevent rescans; existing verified profiles still govern discovery.
		const host = { isModelBusy: () => true, isDisposed: () => false };
		registerLocalModelHost(host);
		try {
			const live = await service.discoverLocalModels();
			expect(live.get("llama.cpp")?.has(profile.id)).toBe(true);
			const config = JSON.parse(readFileSync(configPath, "utf8"));
			expect(config.providers["llama.cpp"].models[0].contextWindow).toBe(4096);
			expect(config.providers.local.models[0].compat).toEqual({ supportsStrictMode: false });
			expect(config.extra).toBe("retained");
			await service.saveModelConfig("llama.cpp", {
				providerId: "llama.cpp",
				models: [{ id: profile.id, contextWindow: 8192, maxTokens: 1024 }],
			});
			expect(emit).toHaveBeenCalledWith(
				expect.objectContaining({ level: "error", textEn: expect.stringContaining("active agent") }),
			);
		} finally {
			host.isDisposed = () => true;
		}
	});
});
