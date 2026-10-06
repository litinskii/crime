import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en/common.json";
import uk from "./locales/uk/common.json";
import enIncidents from "./locales/en/incidents.json";
import ukIncidents from "./locales/uk/incidents.json";
import enFilters from "./locales/en/filters.json";
import ukFilters from "./locales/uk/filters.json";
let saved: string | null = null;
try {
  saved = localStorage.getItem("crime-radar-locale");
} catch {
  /* Private browsing may block persistence. */
}
const locale =
  saved === "en" || saved === "uk"
    ? saved
    : navigator.language
      ? navigator.language.startsWith("uk")
        ? "uk"
        : "en"
      : "uk";
void i18n.use(initReactI18next).init({
  lng: locale,
  fallbackLng: "uk",
  resources: {
    en: { common: en, incidents: enIncidents, filters: enFilters },
    uk: { common: uk, incidents: ukIncidents, filters: ukFilters },
  },
  defaultNS: "common",
  interpolation: { escapeValue: false },
});
i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
  try {
    localStorage.setItem("crime-radar-locale", lng);
  } catch {
    /* No persistence available. */
  }
});
document.documentElement.lang = locale;
export default i18n;
