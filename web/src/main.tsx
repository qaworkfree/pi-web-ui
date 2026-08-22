import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LanguageProvider } from "./i18n";
import "./styles.css";
import "highlight.js/styles/github-dark.css";
import { applyTheme, loadTheme } from "./theme";
import { initAuthToken } from "./auth-token";

// 吸收地址栏 ?token=（PI_WEB_TOKEN 鉴权入口）并持久化，须在首次请求前执行
initAuthToken();

// Apply the persisted theme before first render so there's no flash of the
// wrong palette. The full stylesheet swap happens via an injected <link>.
applyTheme(loadTheme());

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<LanguageProvider>
			<App />
		</LanguageProvider>
	</StrictMode>,
);
