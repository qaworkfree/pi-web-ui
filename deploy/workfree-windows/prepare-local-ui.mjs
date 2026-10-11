import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const [root, preferred] = process.argv.slice(2);
if (!root) throw new Error("Missing installation folder");
const profiles = JSON.parse(readFileSync(join(root, "ui-data/local-launcher/profiles.json"), "utf8"));
const ids = new Set(profiles.models.map((model) => `llama.cpp/${model.id}`));
const selected = ids.has(`llama.cpp/${preferred}`) ? preferred : profiles.models[0].id;
const fallback = `llama.cpp/${selected}`;
const service = JSON.parse(readFileSync(join(root, "Personal/Config/service-config.json"), "utf8"));
const modelUrl = `http://127.0.0.1:${service.modelPort}/v1`;
function migrate(model) {
	if (model === "workfree-local/workfree-local") return fallback;
	if (typeof model === "string" && model.startsWith("workfree-local/")) {
		const native = model.replace("workfree-local/", "llama.cpp/");
		if (ids.has(native)) return native;
	}
	return model;
}
const backupDir = join(root, "cache/config-backups", new Date().toISOString().replaceAll(":", "-"));
function edit(path, change) {
	const before = existsSync(path) ? readFileSync(path, "utf8") : "{}";
	const value = JSON.parse(before);
	change(value);
	const after = `${JSON.stringify(value, null, 2)}\n`;
	if (before === after) return;
	mkdirSync(backupDir, { recursive: true });
	if (existsSync(path)) copyFileSync(path, join(backupDir, path.split(/[\\/]/).at(-1)));
	writeFileSync(`${path}.tmp`, after);
	renameSync(`${path}.tmp`, path);
}
edit(join(root, "agent-config/settings.json"), (settings) => {
	if (
		settings.defaultProvider === "workfree-local" ||
		!settings.defaultProvider ||
		(settings.defaultProvider === "llama.cpp" && !ids.has(`llama.cpp/${settings.defaultModel}`))
	) {
		settings.defaultProvider = "llama.cpp";
		settings.defaultModel = ids.has(`llama.cpp/${settings.defaultModel}`) ? settings.defaultModel : selected;
	}
});
edit(join(root, "agent-config/models.json"), (config) => {
	config.providers ??= {};
	// Retire only the provider this installation generated for the former fixed model.
	const legacy = config.providers["workfree-local"];
	if (
		legacy?.baseUrl === modelUrl &&
		legacy.apiKey === "local" &&
		legacy.models?.some((model) => model.id === "workfree-local")
	)
		delete config.providers["workfree-local"];
	const provider = (config.providers["llama.cpp"] ??= { models: [] });
	const old = new Map((provider.models ?? []).map((model) => [model.id, model]));
	for (const model of profiles.models)
		old.set(model.id, {
			...old.get(model.id),
			id: model.id,
			name: model.embedding ? `${model.name} (embeddings only)` : model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		});
	provider.models = [...old.values()];
});
edit(join(root, "ui-data/client-state.json"), (state) => {
	for (const client of Object.values(state)) {
		if (!client || typeof client !== "object") continue;
		if (client.defaultModel) client.defaultModel = migrate(client.defaultModel);
		for (const [cwd, model] of Object.entries(client.projectModels ?? {})) {
			client.projectModels[cwd] = migrate(model);
		}
	}
	state.__settings__ ??= {};
	state.__settings__.defaultModel ??= fallback;
});
console.log(`Local startup model: ${selected}; startup is idle until you send a message.`);

// A fresh deployment previously denied every tool read, including user uploads.
// Initialize narrowly scoped rules once; never overwrite a user-managed policy.
// No work folder is pre-granted: with PI_WEB_REQUIRE_PROJECT=1 the user picks
// the folder(s) to expose on first use, and selection grants the access.
const policyPath = join(root, "ui-data/filesystem-policy.json");
if (!existsSync(policyPath)) {
	const blocked = { read: "block", create: "block", write: "block", edit: "block", delete: "block", execute: "block" };
	edit(policyPath, (policy) => {
		policy.defaultPermissions = blocked;
		policy.rules = [
			{ path: join(root, "ui-data/uploads"), permissions: { ...blocked, read: "allow" } },
			{ path: join(root, "ui-data/attachments"), permissions: { ...blocked, read: "allow" } },
		];
		for (const rule of [...policy.rules]) {
			if (existsSync(rule.path) || existsSync(dirname(rule.path))) {
				const physical = existsSync(rule.path)
					? realpathSync(rule.path)
					: join(realpathSync(dirname(rule.path)), basename(rule.path));
				if (physical !== rule.path) policy.rules.push({ ...rule, path: physical });
			}
		}
	});
	console.log("Initialized read-only upload permissions; work folders are granted on first selection.");
}
