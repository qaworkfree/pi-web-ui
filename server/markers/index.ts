/**
 * markers/index.ts — 聚合内置标记并提供便捷初始化。
 */

import { registerMarker } from "./registry.js";
import { todoMarker } from "./builtins/todo.js";
import { servicesMarker } from "./builtins/services.js";
import { notifyMarker } from "./builtins/notify.js";
import { renameMarker, renameAliasMarker, titleAliasMarker } from "./builtins/rename.js";

let initialized = false;

export function ensureMarkersRegistered(): void {
	if (initialized) return;
	registerMarker(todoMarker);
	registerMarker(servicesMarker);
	registerMarker(notifyMarker);
	registerMarker(renameMarker);
	registerMarker(renameAliasMarker);
	registerMarker(titleAliasMarker);
	initialized = true;
}

export { todoMarker, servicesMarker, notifyMarker, renameMarker, renameAliasMarker, titleAliasMarker };
export * from "./marker.js";
export * from "./registry.js";
export * from "./store.js";
