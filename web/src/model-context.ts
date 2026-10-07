export interface ContextDraft {
	contextLimit?: number;
	contextWindow: string;
	maxTokens: string;
}

export function validLocalContext(model: ContextDraft): boolean {
	if (!model.contextLimit) return true;
	const context = Number(model.contextWindow);
	const output = Number(model.maxTokens);
	return (
		Number.isSafeInteger(context) &&
		context >= 2 &&
		context <= model.contextLimit &&
		Number.isSafeInteger(output) &&
		output >= 1 &&
		output < context
	);
}

export function boundedPresets<T extends { value: string }>(presets: T[], limit?: number): T[] {
	return limit === undefined ? presets : presets.filter((preset) => Number(preset.value) <= limit);
}
