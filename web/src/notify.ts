/**
 * Desktop / OS (PWA) notifications for pi-web-ui.
 *
 * Lightweight, frontend-only notifications via the browser Notification API.
 * They are routed through the registered service worker (reg.showNotification)
 * so they still appear when the installed PWA is running in the background /
 * minimised — exactly the "a session finished / needs your input while I'm in
 * another app" case from issue #13. No server-side web push (that would need a
 * subscription + VAPID + push endpoint; out of scope).
 *
 * Notifications only fire while the user is NOT watching the page (not focused
 * OR not visible) so they never spam someone who is actively looking at the
 * chat — that case is covered by the in-app sound cues.
 *
 * Windows notes (why this file is not just "focus ? skip : show"):
 *
 *   - Focus alone is not a reliable "the user is watching" signal: Chromium
 *     does not always blur the document when a window is minimised. On Windows
 *     a minimised window can keep reporting `document.hasFocus() === true`
 *     (macOS blurs it), so gating on focus only silently ate every
 *     notification exactly in the "I switched to another app and minimised the
 *     PWA" case this feature exists for. We therefore require BOTH focus AND
 *     visibility before swallowing one (see `shouldSuppressNotify`) — Page
 *     Visibility reports `hidden` on minimise/occlusion/background tabs on
 *     every platform we care about.
 *   - `new Notification()` is a valid fallback in Chrome/Edge on Windows when
 *     no service worker is registered yet (dev mode), but such a toast has no
 *     click handling at all; through the SW path a click focuses / reopens the
 *     app window (`notificationclick` in `sw.js`).
 *   - Windows toasts are additionally gated by the OS: the browser (or the
 *     installed PWA) must be allowed under Settings → System → Notifications
 *     and Focus assist must be off. Nothing in the page can override that, so
 *     the settings UI shows a hint (`notifyWindowsHint`).
 */

import { appUrl } from "./base-url";

export interface NotifySettings {
	/** Master switch — kills every OS notification. */
	enabled: boolean;
}

const STORAGE_KEY = "pi-web-notify";

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { enabled: false };

/** Read persisted settings, falling back to defaults on any failure. */
export function loadNotifySettings(): NotifySettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_NOTIFY_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<NotifySettings>;
		return { enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_NOTIFY_SETTINGS.enabled };
	} catch {
		return { ...DEFAULT_NOTIFY_SETTINGS };
	}
}

export function saveNotifySettings(settings: NotifySettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// storage unavailable (private mode etc.) — notifications just won't persist
	}
}

export function notificationsSupported(): boolean {
	return typeof window !== "undefined" && "Notification" in window;
}

/** Why OS notifications are unavailable (null = available and usable). */
export type NotifyBlockReason = "insecure" | "unsupported";

/**
 * Classify *why* notifications are unavailable so the UI can say something
 * true instead of the blanket "this browser does not support notifications".
 *
 * The interesting case is `insecure`: Chromium only exposes the Notification
 * API in a secure context (https, or http on localhost/127.0.0.1/::1).
 * Opening pi-web-ui over plain http on a LAN IP or machine hostname — the
 * usual Windows "serve here, open it from another PC" setup — has no
 * `Notification` object at all even though the browser supports notifications
 * perfectly well; only the address is at fault. Fix = open via 127.0.0.1 or put
 * HTTPS in front (nginx/tailscale/caddy).
 */
export function notifyBlockReason(): NotifyBlockReason | null {
	if (notificationsSupported()) return null;
	if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure";
	return "unsupported";
}

/**
 * Swallow the notification because the user is already looking at it?
 *
 * Requires both window focus and a visible page. Focus alone is not a reliable
 * "the user is watching" signal — a minimised window can still report
 * `document.hasFocus() === true` (notably on Windows), while Page Visibility
 * reports `hidden` on minimise/occlusion/background tabs everywhere. Pure
 * function → unit tested.
 */
export function shouldSuppressNotify(hasFocus: boolean, visibilityState: string): boolean {
	return hasFocus && visibilityState === "visible";
}

/** True on Windows (the platform whose OS-level notification gate needs an
 *  extra hint — Focus assist / per-app notification toggles). */
export function isWindowsPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return /windows/i.test(navigator.userAgent ?? "");
}

export function notificationPermission(): NotificationPermission {
	if (!notificationsSupported()) return "denied";
	return Notification.permission;
}

/** Request the notification permission. MUST be called from a user gesture
 *  (e.g. toggling the switch) or the browser rejects it. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
	if (!notificationsSupported()) return "denied";
	try {
		return await Notification.requestPermission();
	} catch {
		return "denied";
	}
}

/** Show an OS notification when enabled + granted AND the user is not watching
 *  this page (blurred or hidden/minimised). Otherwise it is a safe no-op —
 *  including when the browser withholds the API (insecure context / old
 *  browser), where the settings UI explains the reason instead. Never throws. */
export async function notify(title: string, body?: string): Promise<void> {
	if (!notificationsSupported()) return;
	// User is watching (focused AND visible) — don't spam; sound covers it.
	if (shouldSuppressNotify(document.hasFocus(), document.visibilityState)) return;
	if (!loadNotifySettings().enabled) return;
	if (Notification.permission !== "granted") return;

	const options: NotificationOptions = {
		body,
		// appUrl keeps the icon path valid under nginx sub-path deployments
		// (e.g. /pi/); root deployments resolve to the exact same URL.
		icon: appUrl("/icons/icon-192.png"),
		badge: appUrl("/icons/icon-192.png"),
		tag: "pi-web-ui",
		// Click target for the service worker's `notificationclick` handler
		// (brings the window back on Windows/Linux, where a toast click would
		// otherwise do nothing). `location.href` keeps PI_WEB_TOKEN intact.
		data: { url: typeof location !== "undefined" ? location.href : appUrl("/") },
	};
	try {
		// Prefer the service worker's showNotification so it works even while
		// the PWA is backgrounded; fall back to a page Notification.
		const reg = await navigator.serviceWorker?.getRegistration();
		if (reg && typeof reg.showNotification === "function") {
			reg.showNotification(title, options);
		} else {
			new Notification(title, options);
		}
	} catch {
		// notifications can't be shown right now — ignore
	}
}
