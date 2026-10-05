interface AttemptRecord {
	count: number;
	resetAt: number;
}

export class LoginRateLimiter {
	private readonly attempts = new Map<string, AttemptRecord>();

	constructor(
		private readonly maxAttempts = 5,
		private readonly windowMs = 15 * 60_000,
		private readonly now: () => number = Date.now,
	) {}

	check(key: string): { allowed: boolean; retryAfterSeconds: number } {
		const current = this.attempts.get(key);
		const now = this.now();
		if (!current || current.resetAt <= now) return { allowed: true, retryAfterSeconds: 0 };
		return {
			allowed: current.count < this.maxAttempts,
			retryAfterSeconds: Math.ceil(Math.max(0, current.resetAt - now) / 1000),
		};
	}

	recordFailure(key: string): void {
		const now = this.now();
		const current = this.attempts.get(key);
		if (!current || current.resetAt <= now) {
			this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
			return;
		}
		current.count += 1;
	}

	clear(key: string): void {
		this.attempts.delete(key);
	}
}
