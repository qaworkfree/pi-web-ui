/** Private launcher bridge. Only verified limits/settings, never file paths, reach the browser. */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { UiModelConfigEntry } from "./protocol.js";

interface LocalProfile extends UiModelConfigEntry {
	contextLimit: number;
	contextWindow: number;
	maxTokens: number;
	embedding?: boolean;
}
interface Profiles {
	modelsDir: string;
	models: LocalProfile[];
}
const execute = promisify(execFile);
let pending: Promise<unknown> = Promise.resolve();
interface LocalModelHost {
	isModelBusy?: () => boolean;
	isDisposed?: () => boolean;
	onLocalModelsSaved?: () => Promise<void>;
}
const hosts = new Set<WeakRef<LocalModelHost>>();
export function registerLocalModelHost(host: LocalModelHost): void {
	hosts.add(new WeakRef(host));
}
export async function notifyLocalModelsSaved(): Promise<void> {
	for (const ref of hosts) {
		const host = ref.deref();
		if (host && !host.isDisposed?.()) await host.onLocalModelsSaved?.();
	}
}
export function localModelsBusy(): boolean {
	let busy = false;
	for (const ref of hosts) {
		const host = ref.deref();
		if (!host || host.isDisposed?.()) hosts.delete(ref);
		else if (host.isModelBusy?.()) busy = true;
	}
	return busy;
}

export function readLocalProfiles(): LocalProfile[] {
	const path = process.env.PI_WEB_LOCAL_MODEL_PROFILES;
	if (!path) return [];
	return (JSON.parse(readFileSync(path, "utf8")) as Profiles).models;
}

/** Snapshot-path variant: snapshots fire every ~60ms while streaming, so the
 *  composer context chip reads through a small TTL cache instead of hitting
 *  the profiles file each time. Saves bust it via bustLocalProfilesCache(). */
let profilesCache: { at: number; models: LocalProfile[] } | null = null;
export function readLocalProfilesCached(ttlMs = 2000): LocalProfile[] {
	const now = Date.now();
	if (profilesCache && now - profilesCache.at < ttlMs) return profilesCache.models;
	try {
		profilesCache = { at: now, models: readLocalProfiles() };
	} catch {
		profilesCache = { at: now, models: [] };
	}
	return profilesCache.models;
}
export function bustLocalProfilesCache(): void {
	profilesCache = null;
}

export function managedLocalProvider(id: string, baseUrl?: string): boolean {
	if (!process.env.PI_WEB_LOCAL_MODEL_PROFILES) return false;
	if (id === "llama.cpp") return true;
	try {
		const target = new URL(process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080");
		const candidate = new URL(baseUrl || "");
		return (
			["127.0.0.1", "localhost", "[::1]"].includes(candidate.hostname) &&
			candidate.protocol === target.protocol &&
			candidate.port === target.port &&
			!candidate.username &&
			!candidate.password &&
			["", "/", "/v1", "/v1/"].includes(candidate.pathname)
		);
	} catch {
		return false;
	}
}

/** Serialize rescans and saves across browser clients; helper never runs inference. */
export async function runLocalProfiles(updates?: UiModelConfigEntry[]): Promise<void> {
	const path = process.env.PI_WEB_LOCAL_MODEL_PROFILES;
	if (!path) return;
	const script = process.env.PI_WEB_LOCAL_MODEL_PROFILE_SCRIPT;
	if (!script) throw new Error("Missing local model profile helper; restart using Start-Workfree.cmd");
	const operation = pending
		.catch(() => {})
		.then(async () => {
			if (localModelsBusy()) {
				if (updates) throw new Error("Wait for active agent turns to finish before changing local model context");
				return;
			}
			const profiles = JSON.parse(readFileSync(path, "utf8")) as Profiles;
			const args = updates
				? [
						script,
						"set",
						path,
						JSON.stringify(updates.map(({ id, contextWindow, maxTokens }) => ({ id, contextWindow, maxTokens }))),
					]
				: [script, "prepare", path, profiles.modelsDir];
			await execute(process.execPath, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
			bustLocalProfilesCache();
		});
	pending = operation;
	await operation;
}

export function localProfileRow(model: LocalProfile): UiModelConfigEntry {
	return {
		id: model.id,
		name: model.embedding ? `${model.name} (embeddings only)` : model.name,
		contextLimit: model.contextLimit,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

export function localEmbeddingModel(provider: string, id: string, baseUrl?: string): boolean {
	return (
		managedLocalProvider(provider, baseUrl) && readLocalProfiles().some((model) => model.id === id && model.embedding)
	);
}
