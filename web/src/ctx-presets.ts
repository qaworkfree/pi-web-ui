/**
 * Context-size presets for the composer context chip (local llama.cpp models).
 * Options are bounded by the model's verified GGUF contextLimit; the saved
 * current value is always present so the active choice never disappears.
 */

const PRESET_STEPS = [4096, 8192, 16384, 32768, 65536, 131072, 200000, 262144];

export interface CtxOption {
	value: number;
	/** The model's GGUF limit itself (labeled as the maximum). */
	isLimit: boolean;
}

export function buildContextOptions(contextLimit: number, current: number): CtxOption[] {
	const values = new Set<number>(PRESET_STEPS.filter((v) => v >= 2048 && v < contextLimit));
	values.add(contextLimit);
	if (current >= 2048 && current <= contextLimit) values.add(current);
	return [...values].sort((a, b) => a - b).map((value) => ({ value, isLimit: value === contextLimit }));
}

/** Compact human label: powers of 1024 render as K (32768 → "32K"), other
 *  values as rounded decimal k (200000 → "200k"). */
export function formatCtx(value: number): string {
	if (value % 1024 === 0) return `${value / 1024}K`;
	if (value >= 10_000) return `${Math.round(value / 1000)}k`;
	return String(value);
}
