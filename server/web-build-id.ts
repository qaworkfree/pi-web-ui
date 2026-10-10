import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read the identifier baked into the frontend, not its different asset hash. */
export function readWebBuildId(webDist: string): string {
	try {
		const metadata: unknown = JSON.parse(readFileSync(join(webDist, "build-id.json"), "utf8"));
		if (typeof metadata !== "object" || metadata === null || !("id" in metadata)) return "";
		return typeof metadata.id === "string" && metadata.id.length <= 256 ? metadata.id : "";
	} catch {
		// Older builds and development servers lack metadata; skip auto-reload.
		return "";
	}
}
