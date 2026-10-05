import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";

interface StoredUser {
	username: string;
	salt: string;
	hash: string;
}

interface CredentialFile {
	version: 1;
	users: StoredUser[];
}

const SCRYPT_KEY_BYTES = 64;

export class AuthCredentialStore {
	private readonly filePath: string;
	private readonly users: StoredUser[];

	constructor(dataDir: string, bootstrapUsername = "", bootstrapPassword = "") {
		this.filePath = join(dataDir, "auth-users.json");
		this.users = this.load();
		if (this.users.length === 0 && bootstrapUsername && bootstrapPassword) {
			this.users.push(this.hashUser(bootstrapUsername, bootstrapPassword));
			this.persist();
		}
	}

	isConfigured(): boolean {
		return this.users.length > 0;
	}

	verify(username: string, password: string): boolean {
		const user = this.users.find((candidate) => candidate.username === username);
		if (!user) return false;
		const expected = Buffer.from(user.hash, "base64");
		const actual = scryptSync(password, Buffer.from(user.salt, "base64"), SCRYPT_KEY_BYTES);
		return expected.length === actual.length && timingSafeEqual(expected, actual);
	}

	private hashUser(username: string, password: string): StoredUser {
		const salt = randomBytes(16);
		const hash = scryptSync(password, salt, SCRYPT_KEY_BYTES);
		return { username, salt: salt.toString("base64"), hash: hash.toString("base64") };
	}

	private load(): StoredUser[] {
		if (!existsSync(this.filePath)) return [];
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<CredentialFile>;
			if (parsed.version !== 1 || !Array.isArray(parsed.users)) return [];
			return parsed.users.filter(
				(user): user is StoredUser =>
					typeof user?.username === "string" && typeof user.salt === "string" && typeof user.hash === "string",
			);
		} catch {
			return [];
		}
	}

	private persist(): void {
		writeJsonAtomicSync(this.filePath, { version: 1, users: this.users });
	}
}
