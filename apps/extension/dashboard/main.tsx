import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { initializeLanguage, t } from "../shared/i18n";
import { initializeTheme } from "../shared/theme";
import { Badge, Brand, LanguageSwitcher, useLanguage } from "../shared/ui";
import { CodexView } from "./views/CodexView";
function App() {
  const language = useLanguage();
  useEffect(() => { document.title = t("extensionName"); }, [language]);
  return <div className="dashboard-shell"><aside className="dashboard-sidebar"><div className="sidebar-brand"><Brand /></div><div className="sidebar-foot"><Badge tone="good">{t("statusReady")}</Badge><small>{t("brandTagline")}</small></div></aside><div className="dashboard-main"><header className="dashboard-topbar"><span className="dashboard-breadcrumb"><strong>{t("codexTitle")}</strong></span><div className="dashboard-topbar-right"><LanguageSwitcher /><Badge tone="good">{t("statusReady")}</Badge></div></header><main className="dashboard-content"><CodexView /></main></div></div>;
}
void Promise.all([initializeLanguage(), initializeTheme()]).catch(() => undefined).finally(() => createRoot(document.getElementById("root")!).render(<App />));
