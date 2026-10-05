import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { normalizeFilesystemPolicy, type FilesystemPolicy } from "./filesystem-policy.js";

/** Persistent global policy file shared by all browser clients. */
export class FilesystemPolicyStore {
	private readonly filePath: string;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "filesystem-policy.json");
	}

	load(): FilesystemPolicy | undefined {
		if (!existsSync(this.filePath)) return undefined;
		try {
			const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<FilesystemPolicy>;
			return normalizeFilesystemPolicy(raw);
		} catch {
			return undefined;
		}
	}

	save(policy: FilesystemPolicy): void {
		writeJsonAtomicSync(this.filePath, normalizeFilesystemPolicy(policy));
	}
}
