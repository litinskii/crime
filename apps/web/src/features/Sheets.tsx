import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Search, MapPin, Check, Info } from "lucide-react";
import {
  categories,
  type Incident,
  type IncidentStatistics,
} from "@crime-radar/shared";
import BottomSheet from "../components/BottomSheet";
import { CategoryIcon, categoryColors } from "../components/Icon";
import { IncidentDate } from "../components/IncidentCard";
import { getSourceStatus, isDemo } from "../repositories/incidents";
import { usePreferences, type Period } from "../stores/preferences";
import {
  analytics,
  geocoding,
  localized,
  type LocationResult,
} from "../services";
export function FiltersSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const preferences = usePreferences();
  const [draft, setDraft] = useState({
    categories: preferences.categories,
    period: preferences.period,
    keyword: preferences.keyword,
    customFrom: preferences.customFrom,
    customTo: preferences.customTo,
  });
  const valid =
    draft.period !== "custom" ||
    Boolean(
      draft.customFrom &&
      draft.customTo &&
      draft.customFrom <= draft.customTo &&
      Date.parse(`${draft.customTo}T23:59:59.999`) -
        Date.parse(`${draft.customFrom}T00:00:00`) <=
        366 * 86400000,
    );
  return (
    <BottomSheet title={t("filters")} onClose={onClose} initial="expanded">
      <h3 className="section-label">{t("categories")}</h3>
      <button
        className={`category-option ${draft.categories.length === 0 ? "selected" : ""}`}
        onClick={() => setDraft({ ...draft, categories: [] })}
      >
        <span>{t("all")}</span>
        {draft.categories.length === 0 && <Check size={17} />}
      </button>
      <div className="category-grid">
        {categories.map((category) => (
          <button
            key={category}
            className={`category-option ${draft.categories.includes(category) ? "selected" : ""}`}
            aria-pressed={draft.categories.includes(category)}
            onClick={() =>
              setDraft({
                ...draft,
                categories: draft.categories.includes(category)
                  ? draft.categories.filter((c) => c !== category)
                  : [...draft.categories, category],
              })
            }
          >
            <CategoryIcon category={category} size={17} />
            <span>{t(`incidents:category.${category}`)}</span>
            {draft.categories.includes(category) && <Check size={15} />}
          </button>
        ))}
      </div>
      <h3 className="section-label">{t("period")}</h3>
      <div className="period-options">
        {(["24h", "7d", "30d", "1y", "custom"] as Period[]).map((p) => (
          <button
            key={p}
            aria-pressed={draft.period === p}
            className={draft.period === p ? "selected" : ""}
            onClick={() => setDraft({ ...draft, period: p })}
          >
            {t(p)}
          </button>
        ))}
      </div>
      {draft.period === "custom" && (
        <div className="date-inputs">
          <label>
            {t("from")}
            <input
              type="date"
              value={draft.customFrom}
              onChange={(e) =>
                setDraft({ ...draft, customFrom: e.target.value })
              }
            />
          </label>
          <label>
            {t("to")}
            <input
              type="date"
              value={draft.customTo}
              onChange={(e) => setDraft({ ...draft, customTo: e.target.value })}
            />
          </label>
        </div>
      )}
      {!valid && <p className="error-text">{t("invalidDates")}</p>}
      <label className="input-label">
        {t("keyword")}
        <input
          placeholder={t("keywordHint")}
          value={draft.keyword}
          onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
        />
      </label>
      <p className="small subtle">{t("dateFilterNote")}</p>
      <div className="sheet-actions">
        <button
          className="text-button"
          onClick={() =>
            setDraft({
              categories: [],
              period: "7d",
              keyword: "",
              customFrom: "",
              customTo: "",
            })
          }
        >
          {t("reset")}
        </button>
        <button
          className="primary-button"
          disabled={!valid}
          onClick={() => {
            preferences.set(draft);
            analytics.track("filter_changed");
            onClose();
          }}
        >
          {t("apply")}
        </button>
      </div>
    </BottomSheet>
  );
}
export function SearchSheet({
  onClose,
  onPlace,
}: {
  onClose: () => void;
  onPlace: (place: LocationResult) => void;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(query), 350);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useQuery({
    queryKey: ["places", searchTerm],
    queryFn: ({ signal }) => geocoding.search(searchTerm, signal),
    staleTime: 60000,
  });
  return (
    <BottomSheet title={t("search")} onClose={onClose}>
      <div className="search-field">
        <Search size={20} />
        <input
          aria-label={t("search")}
          placeholder={t("searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      {!import.meta.env.VITE_GEOCODING_URL && (
        <p className="small subtle">{t("searchCityOnly")}</p>
      )}
      {results.isPending ? (
        <p>{t("loading")}</p>
      ) : results.isError ? (
        <p>{t("error")}</p>
      ) : results.data.length ? (
        results.data.map((place) => (
          <button
            key={place.id}
            className="place-result"
            onClick={() => {
              onPlace(place);
              onClose();
            }}
          >
            <MapPin size={19} />
            <span>{localized(place.name, i18n.language)}</span>
            <span className="subtle small">{t("ukraine")}</span>
          </button>
        ))
      ) : (
        <p>{t("noPlaces")}</p>
      )}
    </BottomSheet>
  );
}
export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { theme, set } = usePreferences();
  const sources = useQuery({
    queryKey: ["source-status"],
    queryFn: ({ signal }) => getSourceStatus(signal),
    enabled: !isDemo,
    staleTime: 60000,
  });
  return (
    <BottomSheet title={t("settings")} onClose={onClose}>
      <h3 className="section-label">{t("language")}</h3>
      <div className="period-options">
        {(["uk", "en"] as const).map((locale) => (
          <button
            key={locale}
            className={i18n.language === locale ? "selected" : ""}
            aria-pressed={i18n.language === locale}
            onClick={() => {
              void i18n.changeLanguage(locale);
              analytics.track("language_changed", { locale });
            }}
          >
            {locale === "uk" ? "Українська" : "English"}
          </button>
        ))}
      </div>
      <h3 className="section-label">{t("theme")}</h3>
      <div className="period-options">
        {(["light", "dark", "system"] as const).map((value) => (
          <button
            key={value}
            className={theme === value ? "selected" : ""}
            aria-pressed={theme === value}
            onClick={() => set({ theme: value })}
          >
            {t(value)}
          </button>
        ))}
      </div>
      <div className="info-box">
        <Info size={20} />
        <div>
          <strong>{t("about")}</strong>
          <p>{t("coverage")}</p>
          <p>{t("installIos")}</p>
        </div>
      </div>
      {!isDemo && (
        <>
          <h3 className="section-label">{t("dataSources")}</h3>
          {sources.data?.sources.map((source) => (
            <div className="source-status" key={source.id}>
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                {source.name}
              </a>
              <p className="small subtle">
                {t(`sourceKind${source.kind}`)} ·{" "}
                {t("sourceReports", { count: source.published ?? 0 })}
              </p>
              <p className="small subtle">
                {source.last_error
                  ? t("sourceRetry", {
                      date: source.next_attempt_at
                        ? new Date(source.next_attempt_at).toLocaleString(
                            i18n.language === "uk" ? "uk-UA" : "en-GB",
                          )
                        : "—",
                    })
                  : source.last_success_at
                    ? t("dataUpdated", {
                        date: new Date(source.last_success_at).toLocaleString(
                          i18n.language === "uk" ? "uk-UA" : "en-GB",
                        ),
                      })
                    : t("sourcePending")}
              </p>
            </div>
          ))}
          <p className="small subtle">
            {t("coordinateAttribution")}{" "}
            <a
              href="https://www.geonames.org/"
              target="_blank"
              rel="noopener noreferrer"
            >
              GeoNames
            </a>{" "}
            ·{" "}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              rel="noopener noreferrer"
            >
              CC BY 4.0
            </a>
          </p>
        </>
      )}
    </BottomSheet>
  );
}
export function StatisticsSheet({
  stats,
  onClose,
}: {
  stats: IncidentStatistics | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const change = stats?.previousPeriodTotal
    ? Math.round(
        ((stats.total - stats.previousPeriodTotal) /
          stats.previousPeriodTotal) *
          100,
      )
    : null;
  return (
    <BottomSheet title={t("statistics")} onClose={onClose}>
      <div className="stats-total">
        <strong>{stats?.total ?? "—"}</strong>
        <span>{t("visibleArea")}</span>
      </div>
      {stats &&
        categories
          .slice()
          .sort((a, b) => stats.categories[b] - stats.categories[a])
          .map((category) => (
            <div className="stat-category" key={category}>
              <CategoryIcon category={category} size={18} />
              <span>{t(`incidents:category.${category}`)}</span>
              <div className="stat-bar">
                <div
                  style={{
                    width: `${stats.total ? (stats.categories[category] / stats.total) * 100 : 0}%`,
                    background: categoryColors[category],
                  }}
                />
              </div>
              <strong>{stats.categories[category]}</strong>
            </div>
          ))}
      <p className="small subtle">
        {change === null
          ? t("noPrevious")
          : `${change > 0 ? "+" : ""}${change}% · ${t("previous")}`}
      </p>
      <p className="small subtle">{t("densityNote")}</p>
    </BottomSheet>
  );
}
export function ListSheet({
  incidents,
  total,
  onSelect,
  onClose,
  loadMore,
  loadingMore,
}: {
  incidents: Incident[];
  total: number;
  onSelect: (id: string) => void;
  onClose: () => void;
  loadMore?: () => void;
  loadingMore: boolean;
}) {
  const { t, i18n } = useTranslation();
  return (
    <BottomSheet title={t("list")} onClose={onClose} initial="expanded">
      <p className="small subtle">{t("listHint")}</p>
      {incidents.length ? (
        incidents.map((item) => (
          <button
            key={item.id}
            className="incident-list-item"
            onClick={() => onSelect(item.id)}
          >
            <CategoryIcon category={item.category} />
            <div>
              <strong>{localized(item.title, i18n.language)}</strong>
              <span>
                {i18n.language === "en"
                  ? item.location.cityEn
                  : item.location.city}
              </span>
              <div className="date-info">
                <IncidentDate incident={item} />
              </div>
            </div>
          </button>
        ))
      ) : (
        <p>{t("noResults")}</p>
      )}
      <p className="small subtle">
        {t("loaded", { loaded: incidents.length, total })}
      </p>
      {loadMore && (
        <button
          className="primary-button"
          disabled={loadingMore}
          onClick={loadMore}
        >
          {t(loadingMore ? "loading" : "loadMore")}
        </button>
      )}
    </BottomSheet>
  );
}
