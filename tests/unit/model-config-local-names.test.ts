// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAppSend, resetAppGlobals } from "../../web/src/app-globals.js";
import { ModelConfigModal } from "../../web/src/components/ModelConfigModal.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiProviderConfig } from "../../server/protocol.js";

let root: Root | null = null;
const provider: UiProviderConfig = {
	providerId: "local",
	baseUrl: "http://127.0.0.1:8080/v1",
	api: "openai-completions",
	models: [{ id: "route", name: "Made up name", contextWindow: 8192, maxTokens: 2048 }],
};
function render(overrides: Partial<Parameters<typeof ModelConfigModal>[0]> = {}) {
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
				createElement(ModelConfigModal, {
					providers: [provider],
					providerStatus: [],
					providerKeys: {},
					providerOAuthFlows: [],
					providerOAuthResults: {},
					onClose: () => {},
					...overrides,
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
});
describe("model management local names", () => {
	it("limits the existing context/output controls and prevents saving excessive custom values", () => {
		const send = vi.fn(() => true);
		setAppSend(send);
		render({
			providers: [
				{
					...provider,
					models: [{ id: "route", name: "Qwen.gguf", contextLimit: 2048, contextWindow: 2048, maxTokens: 512 }],
				},
			],
		});
		const [context, output] = [...document.querySelectorAll<HTMLSelectElement>(".spec-combobox-select")];
		expect(
			[...context.options]
				.filter((option) => option.value !== "custom")
				.every((option) => Number(option.value) <= 2048),
		).toBe(true);
		expect(
			[...output.options].filter((option) => option.value !== "custom").every((option) => Number(option.value) < 2048),
		).toBe(true);
		expect(document.body.textContent).toContain("GGUF limit: 2048 tokens");
		act(() => {
			context.value = "custom";
			context.dispatchEvent(new Event("change", { bubbles: true }));
		});
		const input = document.querySelector<HTMLInputElement>(".spec-combobox-custom-input")!;
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "1000000");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Save",
		)!;
		expect(save.disabled).toBe(true);
		expect(document.querySelector('[role="alert"]')).not.toBeNull();
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "1536");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(save.disabled).toBe(false);
		act(() => save.click());
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "save_model_config",
				config: expect.objectContaining({ models: [expect.objectContaining({ contextWindow: 1536, maxTokens: 512 })] }),
			}),
		);
	});
	it("adopts a fetched name for an existing routing ID without losing configured parameters", () => {
		const send = vi.fn(() => true);
		setAppSend(send);
		render({
			fetchModelsResult: { reqId: 1, ok: true, models: [{ id: "route", name: "Qwen.gguf", contextWindow: 4096 }] },
		});
		act(() => document.querySelector<HTMLButtonElement>(".candidate-actions-footer .primary")!.click());
		expect(document.querySelector<HTMLInputElement>('input[value="Qwen.gguf"]')).not.toBeNull();
		const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Save",
		)!;
		act(() => save.click());
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "save_model_config",
				config: expect.objectContaining({
					models: [expect.objectContaining({ id: "route", name: "Qwen.gguf", contextWindow: 8192, maxTokens: 2048 })],
				}),
			}),
		);
	});
	it("updates an untouched draft when automatic discovery returns", () => {
		render();
		render({ providers: [{ ...provider, models: [{ ...provider.models![0], name: "Qwen.gguf" }] }] });
		expect(document.querySelector<HTMLInputElement>('input[value="Qwen.gguf"]')).not.toBeNull();
	});
	it("keeps user edits made while automatic discovery is pending", () => {
		render();
		const input = document.querySelector<HTMLInputElement>('input[value="Made up name"]')!;
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "My edit");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		render({ providers: [{ ...provider, models: [{ ...provider.models![0], name: "Qwen.gguf" }] }] });
		expect(input.value).toBe("My edit");
	});
});
