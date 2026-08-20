import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LanguageProvider } from "./i18n";
import "./styles.css";
import "highlight.js/styles/github-dark.css";
import { applyTheme, loadTheme } from "./theme";

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
