import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useRegisterSW } from "virtual:pwa-register/react";
import { usePreferences } from "./stores/preferences";
import MapPage from "./pages/MapPage";
const IncidentPage = lazy(() => import("./pages/IncidentPage"));
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
export default function App() {
  const { t } = useTranslation();
  const { theme } = usePreferences();
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [online, setOnline] = useState(navigator.onLine);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#15241f" : "#176b53");
  }, [dark]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    const network = () => setOnline(navigator.onLine);
    const installation = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallEvent);
    };
    media.addEventListener("change", change);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    window.addEventListener("beforeinstallprompt", installation);
    return () => {
      media.removeEventListener("change", change);
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
      window.removeEventListener("beforeinstallprompt", installation);
    };
  }, []);
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="map-loading">{t("loading")}</div>}>
        <Routes>
          <Route path="/" element={<MapPage dark={dark} online={online} />} />
          <Route path="/incident/:id" element={<IncidentPage dark={dark} />} />
          <Route
            path="*"
            element={
              <main className="empty-page">
                <h1>{t("notFound")}</h1>
                <Link to="/">{t("back")}</Link>
              </main>
            }
          />
        </Routes>
      </Suspense>
      {install && (
        <button
          className="install-prompt"
          onClick={async () => {
            await install.prompt();
            await install.userChoice;
            setInstall(null);
          }}
        >
          {t("install")}
        </button>
      )}
      {needRefresh && (
        <div className="update-prompt" role="status">
          <span>{t("update")}</span>
          <button onClick={() => void updateServiceWorker(true)}>
            {t("updateNow")}
          </button>
          <button onClick={() => setNeedRefresh(false)}>{t("notNow")}</button>
        </div>
      )}
    </BrowserRouter>
  );
}
