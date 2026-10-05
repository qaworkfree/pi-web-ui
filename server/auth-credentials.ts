import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
		const user = this.users.find((candidate) => candidate.username === username);
		if (!user) return false;
		const expected = Buffer.from(user.hash, "base64");
		const actual = scryptSync(password, Buffer.from(user.salt, "base64"), SCRYPT_KEY_BYTES);
		return expected.length === actual.length && timingSafeEqual(expected, actual);
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
			if (parsed.version !== 1 || !Array.isArray(parsed.users)) return [];
			return parsed.users
				.filter(
					(user): user is StoredUser =>
						typeof user?.username === "string" && typeof user.salt === "string" && typeof user.hash === "string",
				)
				.map((user, index) => ({ ...user, role: user.role === "admin" || index === 0 ? "admin" : "user" }));
		} catch {
			return [];
		}
	}

	private persist(): void {
		writeJsonAtomicSync(this.filePath, { version: 1, users: this.users });
	}
}
