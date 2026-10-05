import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { DENY_BY_DEFAULT_POLICY, normalizeFilesystemPolicy, type FilesystemPolicy } from "./filesystem-policy.js";

/** Persistent global policy file shared by all browser clients. */
export class FilesystemPolicyStore {
	private readonly filePath: string;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "filesystem-policy.json");
	}

	load(): FilesystemPolicy {
		if (!existsSync(this.filePath)) return DENY_BY_DEFAULT_POLICY;
		try {
			const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<FilesystemPolicy>;
			if (!raw || !Array.isArray(raw.rules) || !raw.defaultPermissions || typeof raw.defaultPermissions !== "object")
				return DENY_BY_DEFAULT_POLICY;
			return normalizeFilesystemPolicy(raw);
		} catch {
			return DENY_BY_DEFAULT_POLICY;
		}
	}

	save(policy: FilesystemPolicy): void {
		writeJsonAtomicSync(this.filePath, normalizeFilesystemPolicy(policy));
	}
}
