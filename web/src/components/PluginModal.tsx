import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { UiSlotEntry } from "../ui-slots";
import type { LoadedPluginView } from "../plugin-loader";
import { PluginView } from "./PluginView";
import { useT } from "../i18n";

interface PluginModalProps {
	/** 已打开的 modal.dialog 条目（App 按 openModalId 解析，hidden 的打不开）。 */
	entry: UiSlotEntry;
	/** 该条目插件已加载的视图（kind="view" 用；还没加载好时为 undefined → 显示 loading）。 */
	pluginView?: LoadedPluginView;
	/** kind="action" 等非视图条目：点即分发（调用方决定关不关，一般是关）。 */
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	onClose: () => void;
}

/**
 * 插件弹窗壳（`modal.dialog` 槽位的渲染层）。
 *
 * 分工与其它 slot 一致：插件只声明条目（manifest "ui" 的 modal 组或
 * host.ui.register），宿主负责壳（遮罩/Esc/✕/标题/布局），内容按 kind 分发：
 *   - kind="view" → 插件视图（PluginView，与右栏 tab 同一个挂载逻辑）；
 *   - 其余 → 一个大按钮（点了回 onUiAction，关不关由调用方定）；
 *   - divider → 分隔线。
 * 同一时刻只开一个（状态在 App 的 openModalId，不在这里）。
 */
export function PluginModal({ entry, pluginView, onUiAction, onClose }: PluginModalProps) {
	const t = useT();

	// Esc 关弹窗（其它 modal 同款；输入框聚焦时也照关 —— 弹窗里的输入是插件的，
	// Esc 优先还给宿主，插件真要拦可以在自己 DOM 里 stopPropagation）。
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const label = entry.label || entry.id;
	const isView = entry.kind === "view";

	return createPortal(
		<div className="modal-backdrop" onClick={onClose}>
			<div
				className="modal plugin-modal"
				role="dialog"
				aria-modal="true"
				aria-label={label}
				onClick={(e) => e.stopPropagation()}
			>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					✕
				</button>
				<div className="modal-head">
					{entry.icon ? <span aria-hidden>{entry.icon}</span> : null}
					<span>{label}</span>
				</div>
				<div className="modal-body plugin-modal-body">
					{isView ? (
						pluginView ? (
							<PluginView entry={pluginView} />
						) : (
							<div className="plugin-modal-loading">{t("loading")}</div>
						)
					) : entry.kind === "divider" ? (
						<hr className="plugin-modal-divider" />
					) : (
						<button type="button" className="btn primary plugin-modal-action" onClick={() => onUiAction?.(entry)}>
							{entry.badge ?? label}
						</button>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
