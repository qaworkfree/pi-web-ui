import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";

interface StoredUser {
	username: string;
	salt: string;
	hash: string;
	role: "admin" | "user";
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
			this.users.push({ ...this.hashUser(bootstrapUsername, bootstrapPassword), role: "admin" });
			this.persist();
		}
	}

	isConfigured(): boolean {
		return this.users.length > 0;
	}

	verify(username: string, password: string): boolean {
		if (username.length > 64 || password.length > 1024) return false;
		const user = this.users.find((candidate) => candidate.username === username);
		const expected = user ? Buffer.from(user.hash, "base64") : Buffer.alloc(SCRYPT_KEY_BYTES);
		const actual = scryptSync(password, user ? Buffer.from(user.salt, "base64") : Buffer.alloc(16), SCRYPT_KEY_BYTES);
		return timingSafeEqual(expected, actual) && Boolean(user);
	}

	listUsers(): { username: string; role: "admin" | "user" }[] {
		return this.users.map(({ username, role }) => ({ username, role }));
	}

	isAdmin(username: string): boolean {
		return this.users.some((user) => user.username === username && user.role === "admin");
	}

	addUser(username: string, password: string): void {
		const normalized = username.trim();
		if (!/^[A-Za-z0-9_.-]{1,64}$/.test(normalized)) throw new Error("Invalid username");
		if (password.length < 8 || password.length > 1024) throw new Error("Password must be 8-1024 characters");
		if (this.users.some((user) => user.username === normalized)) throw new Error("User already exists");
		this.users.push({ ...this.hashUser(normalized, password), role: "user" });
		this.persist();
	}

	removeUser(username: string): void {
		if (this.users.length <= 1) throw new Error("Cannot remove the last user");
		const index = this.users.findIndex((user) => user.username === username);
		if (index < 0) throw new Error("User not found");
		if (this.users[index].role === "admin" && this.users.filter((user) => user.role === "admin").length <= 1) {
			throw new Error("Cannot remove the last administrator");
		}
		this.users.splice(index, 1);
		this.persist();
	}

	private hashUser(username: string, password: string): StoredUser {
		const salt = randomBytes(16);
		const hash = scryptSync(password, salt, SCRYPT_KEY_BYTES);
		return { username, salt: salt.toString("base64"), hash: hash.toString("base64"), role: "user" };
	}

	private load(): StoredUser[] {
		if (!existsSync(this.filePath)) return [];
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<CredentialFile>;
			if (parsed.version !== 1 || !Array.isArray(parsed.users) || parsed.users.length === 0)
				throw new Error("Invalid credential file");
			const names = new Set<string>();
			for (const user of parsed.users) {
				if (
					!user ||
					typeof user.username !== "string" ||
					!/^[A-Za-z0-9_.-]{1,64}$/.test(user.username) ||
					typeof user.salt !== "string" ||
					Buffer.from(user.salt, "base64").length !== 16 ||
					typeof user.hash !== "string" ||
					Buffer.from(user.hash, "base64").length !== SCRYPT_KEY_BYTES ||
					names.has(user.username)
				) {
					throw new Error("Invalid credential record");
				}
				names.add(user.username);
			}
			return parsed.users.map((user, index) => ({
				...user,
				role: user.role === "admin" || index === 0 ? "admin" : "user",
			}));
		} catch {
			throw new Error(`Cannot load authentication credentials from ${this.filePath}; refusing unauthenticated startup`);
		}
	}

	private persist(): void {
		writeJsonAtomicSync(this.filePath, { version: 1, users: this.users });
		chmodSync(this.filePath, 0o600);
	}
}
