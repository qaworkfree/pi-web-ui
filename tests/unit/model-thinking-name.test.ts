// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelThinking } from "../../web/src/components/ModelThinking.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import type { ModelInfo, UiState } from "../../server/protocol.js";

let root: Root | null = null;
const model = { id: "workfree-local", name: "Workfree local GGUF", provider: "local", vision: false };
const state: Pick<UiState, "model" | "thinkingLevel" | "availableThinkingLevels"> = {
	model,
	thinkingLevel: "off",
	availableThinkingLevels: ["off"],
};
const filename = "Qwen3-2B-Q4_K_M.gguf";
const catalog: ModelInfo[] = [{ ...model, id: "local/workfree-local", name: filename, reasoning: false }];

function render(models: ModelInfo[], only?: "model") {
	if (!root) {
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	}
	act(() =>
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(ModelThinking, {
					state,
					models,
					modelsLoading: false,
					onManageModels: () => {},
					providerKeys: {},
					defaultModel: "local/workfree-local",
					only,
				}),
			),
		),
	);
}

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	resetAppGlobals();
	setAppSend(null);
	vi.unstubAllGlobals();
});

describe("selected model display", () => {
	it.each([undefined, "model"] as const)("updates the %s trigger after catalog refresh without reselecting", (only) => {
		render([], only);
		expect(document.body.textContent).toContain(model.name);
		render(catalog, only);
		expect(document.body.textContent).toContain(filename);
		expect(document.body.textContent).not.toContain(model.name);
		expect(state.model?.id).toBe("workfree-local");
	});

	it("shows the same name in the picker and default banner while retaining the routing id", () => {
		// jsdom does not implement the browser's scrolling method.
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
		const send = vi.fn(() => true);
		setAppSend(send);
		render(catalog, "model");
		act(() => document.querySelector<HTMLButtonElement>(".chip")!.click());
		expect(document.querySelector(".dd-model-name")?.textContent).toBe(filename);
		expect(document.querySelector(".dd-default-banner-name")?.textContent).toBe(filename);
		expect(document.querySelector(".dd-model-id")?.textContent).toBe("workfree-local");
		expect(document.querySelector(".dd-item.active")).not.toBeNull();
		expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "set_model" }));
	});

	it("does not substitute a model with the same bare id from another provider", () => {
		render([{ ...catalog[0], id: "other/workfree-local", provider: "other" }], "model");
		expect(document.querySelector(".chip-model")?.textContent).toBe(model.name);
	});
});
