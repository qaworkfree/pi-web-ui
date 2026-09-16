import { useState } from "react";
import type { UiPluginInfo } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";

/**
 * 插件声明式设置表单（manifest "settings" schema → 自动渲染）。
 * 值保存在 storage.json 的 "settings" 键（宿主统一管理），保存时发
 * plugin_settings，服务端校验 + 持久化 + 通知插件（onSettingsChanged）。
 * secret 类型例外：存加密 secrets，settingsValues 里只有有无（布尔），
 * 表单里永远是空输入框（留空 = 不改），明文只在提交那一刻经过内存。
 */
export function PluginSettingsForm({ plugin }: { plugin: UiPluginInfo }) {
	const t = useT();
	const schema = plugin.settingsSchema ?? [];
	// secret 的 settingsValues 是有无布尔：draft 里恒置空串（不把布尔发回去）。
	const [draft, setDraft] = useState<Record<string, unknown>>(() => {
		const init: Record<string, unknown> = { ...plugin.settingsValues };
		for (const f of schema) if (f.type === "secret") init[f.key] = "";
		return init;
	});
	const [saving, setSaving] = useState(false);

	if (schema.length === 0) return null;

	const set = (key: string, v: unknown) => setDraft((prev) => ({ ...prev, [key]: v }));
	// secret 字段的脏判定看输入框是否非空（settingsValues 里是有无布尔，不可直接比）。
	const isDirty = schema.some((f) =>
		f.type === "secret" ? String(draft[f.key] ?? "") !== "" : draft[f.key] !== plugin.settingsValues?.[f.key],
	);

	const save = () => {
		setSaving(true);
		appSend({ type: "plugin_settings", pluginId: plugin.id, values: draft });
		setTimeout(() => setSaving(false), 800);
	};

	const reset = () => {
		const init: Record<string, unknown> = { ...plugin.settingsValues };
		for (const f of schema) if (f.type === "secret") init[f.key] = "";
		setDraft(init);
	};

	return (
		<div className="plugin-settings-form">
			<div className="plugin-settings-fields">
				{schema.map((f) => (
					<label key={f.key} className="plugin-settings-field" title={f.hint}>
						<span className="plugin-settings-label">{f.label}</span>
						{f.type === "boolean" ? (
							<input type="checkbox" checked={Boolean(draft[f.key])} onChange={(e) => set(f.key, e.target.checked)} />
						) : f.type === "secret" ? (
							<input
								type="password"
								value={String(draft[f.key] ?? "")}
								placeholder={t(plugin.settingsValues?.[f.key] ? "pluginSecretSet" : "pluginSecretUnset")}
								autoComplete="new-password"
								onChange={(e) => set(f.key, e.target.value)}
							/>
						) : f.type === "select" ? (
							<select value={String(draft[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
								{(f.options ?? []).map((o) => (
									<option key={o} value={o}>
										{o}
									</option>
								))}
							</select>
						) : (
							<input
								type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
								value={String(draft[f.key] ?? "")}
								min={f.min}
								max={f.max}
								onChange={(e) => set(f.key, f.type === "number" ? Number(e.target.value) : e.target.value)}
							/>
						)}
					</label>
				))}
			</div>
			<div className="plugin-settings-actions">
				<button type="button" className="btn plugin-settings-save" disabled={!isDirty || saving} onClick={save}>
					{saving ? t("pluginSettingsSaving") : t("pluginSettingsSave")}
				</button>
				<button type="button" className="btn plugin-settings-reset" onClick={reset}>
					{t("pluginSettingsReset")}
				</button>
			</div>
		</div>
	);
}
