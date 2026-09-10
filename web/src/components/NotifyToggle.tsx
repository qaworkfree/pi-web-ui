import { useEffect, useState } from "react";
import { FiBell } from "react-icons/fi";
import { useT } from "../i18n";
import {
	loadNotifySettings,
	saveNotifySettings,
	notifyBlockReason,
	notificationPermission,
	requestNotificationPermission,
	isWindowsPlatform,
	type NotifySettings,
} from "../notify";

/**
 * Desktop / OS (PWA) notification toggle. Rendered at the bottom of the sound
 * dropdown in the top bar. Self-contained: it owns its (persisted) enabled
 * state and requests the browser permission from the user-gesture change
 * handler. When permission is denied the switch flips back so the UI never
 * claims notifications are on.
 *
 * Unavailable cases are reported precisely (`notifyBlockReason`): a missing
 * Notification API because of an insecure address (plain http on a LAN
 * IP/hostname — the typical Windows "open it from my other machine" setup) is
 * NOT the same as an unsupported browser, and the switch is disabled instead of
 * pretending it can be turned on. On Windows an extra hint points at the
 * OS-level gate (Settings → System → Notifications, Focus assist), which is the
 * remaining reason toasts stay silent even with permission granted.
 */
export function NotifyToggle() {
	const t = useT();
	const [settings, setSettings] = useState<NotifySettings>(loadNotifySettings);
	const [perm, setPerm] = useState<NotificationPermission>(() => notificationPermission());

	// Cheap, side-effect free: re-read on every render so the panel reflects a
	// permission change made in browser settings while the page stayed open.
	const block = notifyBlockReason();
	const blocked = block !== null;
	const windows = isWindowsPlatform();

	// Permission can also change outside the page (browser settings, the native
	// prompt answered elsewhere): re-sync whenever the user comes back to us.
	useEffect(() => {
		const sync = () => setPerm(notificationPermission());
		window.addEventListener("focus", sync);
		document.addEventListener("visibilitychange", sync);
		return () => {
			window.removeEventListener("focus", sync);
			document.removeEventListener("visibilitychange", sync);
		};
	}, []);

	const toggle = async (enabled: boolean) => {
		const next: NotifySettings = { ...settings, enabled };
		setSettings(next);
		saveNotifySettings(next);
		if (enabled) {
			const p = await requestNotificationPermission();
			setPerm(p);
			if (p !== "granted") {
				// Reflect reality: notifications can't be shown, keep the switch off.
				const off: NotifySettings = { ...next, enabled: false };
				setSettings(off);
				saveNotifySettings(off);
			}
		}
	};

	return (
		<div className="sound-menu notify-menu">
			<div className="dd-header">{t("notifyHeader")}</div>

			<label className={`sound-row sound-master${blocked ? " disabled" : ""}`}>
				<span className="sound-label">
					<FiBell className="sound-icon" />
					<span>{t("notifyEnable")}</span>
				</span>
				<input
					type="checkbox"
					checked={settings.enabled && !blocked}
					disabled={blocked}
					onChange={(e) => toggle(e.target.checked)}
				/>
			</label>

			<div className="sound-hint">{t("notifyEnableDesc")}</div>

			{block === "insecure" && <div className="sound-hint">{t("notifyInsecure")}</div>}
			{block === "unsupported" && <div className="sound-hint">{t("notifyUnsupported")}</div>}
			{!blocked && perm === "denied" && <div className="sound-hint">{t("notifyDenied")}</div>}
			{!blocked && windows && <div className="sound-hint">{t("notifyWindowsHint")}</div>}
		</div>
	);
}
