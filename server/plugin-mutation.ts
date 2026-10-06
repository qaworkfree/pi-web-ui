/** Explicitly mutating plugin tools retain conversation gates after dynamic reload. */
export interface PluginMutationContext {
	permissionPreset?: string;
	planMode?: boolean;
	delegateMode?: boolean;
	goalReview?: boolean;
}

export function withPluginMutationGate<T extends { execute: (...args: any[]) => any }>(
	tool: T,
	getContext: () => PluginMutationContext | undefined,
): T {
	return {
		...tool,
		execute: async (...args: Parameters<T["execute"]>) => {
			const context = getContext();
			if (
				!context ||
				context.permissionPreset === "read-only" ||
				context.planMode ||
				context.delegateMode ||
				context.goalReview
			)
				throw new Error(
					"[Permission Denied] This conversation cannot change external app data while read-only, planning or reviewing.",
				);
			return tool.execute(...args);
		},
	};
}
