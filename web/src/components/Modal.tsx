import {
	useEffect,
	useLayoutEffect,
	useRef,
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../shortcut-stack";
import { useT } from "../i18n";

/**
 * 全局 body 滚动锁定引用计数。
 * 多个 Modal 同时存在时，只有最后一个关闭才真正解锁 body，避免滚轮穿透到背景聊天列表。
 */
let bodyScrollLockCount = 0;
let previousBodyOverflow = "";

function lockBodyScroll() {
	if (typeof document === "undefined") return;
	if (bodyScrollLockCount === 0) {
		previousBodyOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
	}
	bodyScrollLockCount++;
}

function unlockBodyScroll() {
	if (typeof document === "undefined") return;
	bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
	if (bodyScrollLockCount === 0) {
		document.body.style.overflow = previousBodyOverflow;
	}
}

export interface ModalProps {
	/** 是否打开（默认 true）。 */
	open?: boolean;
	/** 关闭回调。 */
	onClose: () => void;
	/** 弹窗标题（若传入，自动渲染带有标题与关闭按钮的标准 modal-head）。 */
	title?: ReactNode;
	/** 标题左侧图标。 */
	icon?: ReactNode;
	/** 弹窗内容。 */
	children: ReactNode;
	/** 附加在 .modal 上的类名（如 "plugin-modal", "bg-tasks-modal"）。 */
	className?: string;
	/** 附加在 .modal-backdrop 上的类名。 */
	backdropClassName?: string;
	/** 弹窗容器 style。 */
	style?: CSSProperties;
	/** 点击背景遮罩是否关闭（默认 true）。 */
	closeOnBackdropClick?: boolean;
	/** 按 Escape 是否关闭（默认 true）。 */
	closeOnEscape?: boolean;
	/** 是否渲染右上角关闭按钮 ✕（默认 true）。 */
	showCloseButton?: boolean;
	/** 可访问性 label（未传时尝试从 title 推断）。 */
	ariaLabel?: string;
	/** 是否锁定页面背景滚动防滚轮穿透（默认 true）。 */
	lockScroll?: boolean;
}

/**
 * 统一模态弹窗原语组件。
 *
 * 核心保障：
 * 1. 【Portal 到 body】：摆脱父容器的 overflow 裁剪；
 * 2. 【防滚轮穿透】：打开时锁定 body 滚动，支持多层嵌套弹窗的引用计数；
 * 3. 【分层 Esc 调度】：通过 shortcut-stack 保证内层弹窗优先消费 Esc；
 * 4. 【遮罩与防冒泡】：背景点击关闭，内部点击 stopPropagation；
 * 5. 【可访问性】：标准 role="dialog" 和 aria-modal="true"。
 */
export function Modal({
	open = true,
	onClose,
	title,
	icon,
	children,
	className = "",
	backdropClassName = "",
	style,
	closeOnBackdropClick = true,
	closeOnEscape = true,
	showCloseButton = true,
	ariaLabel,
	lockScroll = true,
}: ModalProps) {
	const t = useT();
	const onCloseRef = useRef(onClose);
	useLayoutEffect(() => {
		onCloseRef.current = onClose;
	});

	// Esc 栈调度
	useEscapeKey(() => {
		if (closeOnEscape) {
			onCloseRef.current();
			return true;
		}
		return false;
	}, open);

	// 背景滚动锁定
	useEffect(() => {
		if (!open || !lockScroll) return;
		lockBodyScroll();
		return () => {
			unlockBodyScroll();
		};
	}, [open, lockScroll]);

	if (!open) return null;

	const handleBackdropClick = (e: ReactMouseEvent) => {
		if (e.target === e.currentTarget && closeOnBackdropClick) {
			onCloseRef.current();
		}
	};

	const computedAriaLabel = ariaLabel ?? (typeof title === "string" ? title : undefined);

	return createPortal(
		<div className={`modal-backdrop ${backdropClassName}`.trim()} onClick={handleBackdropClick} role="presentation">
			<div
				className={`modal ${className}`.trim()}
				role="dialog"
				aria-modal="true"
				aria-label={computedAriaLabel}
				style={style}
				onClick={(e) => e.stopPropagation()}
			>
				{showCloseButton && (
					<button type="button" className="modal-close" aria-label={t("close")} onClick={() => onCloseRef.current()}>
						✕
					</button>
				)}
				{title ? (
					<div className="modal-head">
						{icon ? (
							<span className="modal-head-icon" aria-hidden>
								{icon}
							</span>
						) : null}
						<span>{title}</span>
					</div>
				) : null}
				{children}
			</div>
		</div>,
		document.body,
	);
}
