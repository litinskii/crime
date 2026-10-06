import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Radar,
  Search,
  SlidersHorizontal,
  Settings2,
  Plus,
  Minus,
  LocateFixed,
  Scan,
  Layers,
  List,
  ArrowUpRight,
  WifiOff,
} from "lucide-react";
import {
  kyivCalendarRange,
  type Bounds,
  type IncidentQuery,
} from "@crime-radar/shared";
import {
  usePreferences,
  initialBounds,
  type Period,
} from "../stores/preferences";
import {
  incidentsRepository,
  isDemo,
  getSourceStatus,
} from "../repositories/incidents";
import { analytics } from "../services";
import type { MapController } from "../features/IncidentMap";
import {
  FiltersSheet,
  SearchSheet,
  SettingsSheet,
  StatisticsSheet,
  ListSheet,
} from "../features/Sheets";
import BottomSheet from "../components/BottomSheet";
import { IncidentCard } from "../components/IncidentCard";
import { categoryColors } from "../components/Icon";
const IncidentMap = lazy(() => import("../features/IncidentMap"));
type Sheet = "filters" | "search" | "settings" | "statistics" | "list" | null;
export default function MapPage({
  dark,
  online,
}: {
  dark: boolean;
  online: boolean;
}) {
  const { t, i18n } = useTranslation();
  const preferences = usePreferences();
  const [bounds, setBounds] = useState(initialBounds);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const controls = useRef<MapController | null>(null);
  useEffect(() => {
    if (!online) return;
    const timer = setInterval(() => setNow(Date.now()), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [online]);
  const closeSheet = useCallback(() => setSheet(null), []);
  const closeIncident = useCallback(() => setSelected(null), []);
  const onBounds = useCallback((b: Bounds) => {
    setBounds(b);
    analytics.track("map_area_changed");
  }, []);
  const select = useCallback((id: string) => {
    setSheet(null);
    setSelected(id);
    analytics.track("incident_opened");
  }, []);
  const query = useMemo<IncidentQuery>(() => {
    const days = { "24h": 1, "7d": 7, "30d": 30, "1y": 365 };
    const custom =
      preferences.period === "custom"
        ? kyivCalendarRange(preferences.customFrom, preferences.customTo)
        : null;
    return {
      ...bounds,
      dateBasis: preferences.dateBasis,
      from:
        preferences.period === "custom"
          ? custom!.from
          : new Date(now - days[preferences.period] * 86400000).toISOString(),
      to:
        preferences.period === "custom"
          ? custom!.to
          : new Date(now).toISOString(),
      categories: preferences.categories,
      query: preferences.keyword,
      limit: 500,
    };
  }, [
    bounds,
    now,
    preferences.period,
    preferences.dateBasis,
    preferences.customFrom,
    preferences.customTo,
    preferences.categories,
    preferences.keyword,
  ]);
  const incidents = useInfiniteQuery({
    queryKey: ["incidents", query],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      incidentsRepository.getIncidents({ ...query, cursor: pageParam, signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30000,
    retry: 1,
    networkMode: "always",
  });
  const stats = useQuery({
    queryKey: ["statistics", query],
    queryFn: ({ signal }) =>
      incidentsRepository.getStatistics({ ...query, signal }),
    staleTime: 30000,
    retry: 1,
    networkMode: "always",
  });
  const sourceStatus = useQuery({
    queryKey: ["source-status"],
    queryFn: ({ signal }) => getSourceStatus(signal),
    enabled: !isDemo,
    staleTime: 60 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
    retry: 1,
    networkMode: "always",
  });
  const updated = sourceStatus.data?.sources
    .map((s) => s.last_success_at)
    .filter((s): s is string => Boolean(s))
    .sort()
    .at(-1);
  const detail = useQuery({
    queryKey: ["incident", selected],
    queryFn: ({ signal }) => incidentsRepository.getIncident(selected!, signal),
    enabled: Boolean(selected),
    networkMode: "always",
  });
  const items = useMemo(
    () => incidents.data?.pages.flatMap((p) => p.items) ?? [],
    [incidents.data],
  );
  const total = stats.data?.total ?? incidents.data?.pages[0]?.total ?? 0;
  const demo = isDemo || items.some((item) => item.synthetic);
  const change = stats.data?.previousPeriodTotal
    ? Math.round((stats.data.total / stats.data.previousPeriodTotal - 1) * 100)
    : null;
  const open = (value: Sheet) => {
    setSelected(null);
    setSheet(value);
  };
  const locate = () => {
    analytics.track("location_requested");
    if (!navigator.geolocation) {
      setNotice(t("locationDenied"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => controls.current?.locate(position),
      () => setNotice(t("locationDenied")),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };
  return (
    <main className="map-page">
      <Suspense fallback={<div className="map-loading">{t("loading")}</div>}>
        <IncidentMap
          incidents={items}
          mode={preferences.mode}
          dark={dark}
          onBounds={onBounds}
          onSelect={select}
          onReady={(controller) => {
            controls.current = controller;
          }}
        />
      </Suspense>
      <div className="top-controls">
        <header className="top-bar">
          <a href="/" className="brand">
            <span className="brand-icon">
              <Radar size={26} />
            </span>
            <div>
              <strong>Crime Radar</strong>
              {isDemo ? (
                <span>{t("tagline")}</span>
              ) : (
                <span className="database-total" aria-live="polite">
                  {t("databaseTotal")}{" "}
                  <b>
                    {sourceStatus.data?.total?.toLocaleString(i18n.language) ??
                      "—"}
                  </b>
                </span>
              )}
            </div>
          </a>
          <button
            className="icon-button"
            aria-label={t("search")}
            onClick={() => open("search")}
          >
            <Search size={21} />
          </button>
          <button
            className="icon-button"
            aria-label={t("settings")}
            onClick={() => open("settings")}
          >
            <Settings2 size={21} />
          </button>
        </header>
        <div className="time-bar" aria-label={t("period")}>
          {(["24h", "7d", "30d", "1y"] as Period[]).map((period) => (
            <button
              key={period}
              className={preferences.period === period ? "active" : ""}
              aria-pressed={preferences.period === period}
              onClick={() => {
                preferences.set({ period });
                analytics.track("time_range_changed", { period });
              }}
            >
              {t(period)}
            </button>
          ))}
        </div>
        <div className="context-row">
          <span className="country-pill">
            <span className="country-dot" />
            {t("ukraine")}
          </span>
          {demo && <span className="demo-pill">{t("demo")}</span>}
          {!demo && <span className="live-pill">{t("liveReports")}</span>}
        </div>
      </div>
      <div className="map-mode" role="group" aria-label={t("heatmap")}>
        <button
          className={preferences.mode === "markers" ? "active" : ""}
          aria-pressed={preferences.mode === "markers"}
          onClick={() => preferences.set({ mode: "markers" })}
        >
          <MapModeIcon />
          {t("markers")}
        </button>
        <button
          className={preferences.mode === "heatmap" ? "active" : ""}
          aria-pressed={preferences.mode === "heatmap"}
          onClick={() => {
            preferences.set({ mode: "heatmap" });
            analytics.track("heatmap_enabled");
          }}
        >
          <Layers size={17} />
          {t("heatmap")}
        </button>
      </div>
      <div className="navigation-controls">
        <div className="zoom-controls">
          <button
            className="icon-button"
            aria-label={t("zoomIn")}
            onClick={() => controls.current?.zoomIn()}
          >
            <Plus size={22} />
          </button>
          <button
            className="icon-button"
            aria-label={t("zoomOut")}
            onClick={() => controls.current?.zoomOut()}
          >
            <Minus size={22} />
          </button>
        </div>
        <button
          className="icon-button control-surface"
          aria-label={t("home")}
          onClick={() => controls.current?.home()}
        >
          <Scan size={21} />
        </button>
        <button
          className="icon-button control-surface"
          aria-label={t("locate")}
          onClick={locate}
        >
          <LocateFixed size={21} />
        </button>
      </div>
      <div className="bottom-controls">
        <div className="area-panel">
          <button
            className="area-summary"
            onClick={() => open("statistics")}
            aria-label={t("statistics")}
          >
            <span className="eyebrow">
              {t("visibleArea")}
              <ArrowUpRight size={16} />
            </span>
            <span className="count-text">
              {incidents.isPending
                ? t("loading")
                : t("incidents", { count: total })}
            </span>
            <span className="small subtle">
              {preferences.period === "custom"
                ? t("dateRange", {
                    from: preferences.customFrom,
                    to: preferences.customTo,
                  })
                : t(preferences.period)}
              {" · "}
              {t(
                preferences.dateBasis === "event"
                  ? "dateBasisEvent"
                  : "dateBasisPublication",
              )}
              {change !== null && (
                <span className="period-change">
                  {" "}
                  · {change > 0 ? "+" : ""}
                  {change}%
                </span>
              )}
            </span>
          </button>
          <div className="category-strip">
            {stats.data &&
              Object.entries(stats.data.categories)
                .filter(([, v]) => v > 0)
                .map(([category, count]) => (
                  <span
                    key={category}
                    style={{
                      background:
                        categoryColors[category as keyof typeof categoryColors],
                      flexGrow: count,
                    }}
                    title={`${t(`incidents:category.${category}`)}: ${count}`}
                  />
                ))}
          </div>
          <div className="area-actions">
            <button onClick={() => open("filters")}>
              <SlidersHorizontal size={18} />
              {t("filters")}
              {(preferences.categories.length > 0 || preferences.keyword) && (
                <span className="filter-dot" />
              )}
            </button>
            <button onClick={() => open("list")}>
              <List size={19} />
              {t("list")}
            </button>
          </div>
        </div>
        <p className="data-caption">
          {demo ? t("demoNote") : t("liveCoverage")}
          {!demo && updated && (
            <span className="updated-caption">
              {t("dataUpdated", {
                date: new Date(updated).toLocaleString(
                  i18n.language === "uk" ? "uk-UA" : "en-GB",
                  {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  },
                ),
              })}
            </span>
          )}
        </p>
      </div>
      {preferences.mode === "heatmap" && (
        <div className="density-key">
          <span />
          <p>{t("densityNote")}</p>
        </div>
      )}
      <div className="status-stack" aria-live="polite">
        {!online && (
          <div className="status-message">
            <WifiOff size={17} />
            {t("offline")}
          </div>
        )}
        {incidents.isError && (
          <div className="status-message error-text">
            {t("error")}
            <button onClick={() => void incidents.refetch()}>
              {t("retry")}
            </button>
          </div>
        )}
        {!incidents.isPending && !incidents.isError && total === 0 && (
          <div className="status-message">{t("noResults")}</div>
        )}
        {notice && (
          <button className="status-message" onClick={() => setNotice("")}>
            {notice}
          </button>
        )}
        {incidents.hasNextPage && (
          <button
            className="status-message"
            disabled={incidents.isFetchingNextPage}
            onClick={() => void incidents.fetchNextPage()}
          >
            {t("loaded", { loaded: items.length, total })} · {t("loadMore")}
          </button>
        )}
      </div>
      {sheet === "filters" && <FiltersSheet onClose={closeSheet} />}
      {sheet === "search" && (
        <SearchSheet
          onClose={closeSheet}
          onPlace={(place) => controls.current?.goTo(place)}
        />
      )}
      {sheet === "settings" && <SettingsSheet onClose={closeSheet} />}
      {sheet === "statistics" && (
        <StatisticsSheet stats={stats.data} onClose={closeSheet} />
      )}
      {sheet === "list" && (
        <ListSheet
          incidents={items}
          total={total}
          onSelect={select}
          onClose={closeSheet}
          loadMore={
            incidents.hasNextPage
              ? () => {
                  void incidents.fetchNextPage();
                }
              : undefined
          }
          loadingMore={incidents.isFetchingNextPage}
        />
      )}
      {selected && (
        <BottomSheet
          title={
            detail.data
              ? t(`incidents:category.${detail.data.category}`)
              : t("details")
          }
          onClose={closeIncident}
        >
          {detail.isPending ? (
            <p>{t("loading")}</p>
          ) : detail.isError ? (
            <p>
              {t("error")}
              <button onClick={() => void detail.refetch()}>
                {t("retry")}
              </button>
            </p>
          ) : (
            <IncidentCard incident={detail.data} />
          )}
        </BottomSheet>
      )}
    </main>
  );
}
function MapModeIcon() {
  return (
    <span className="mode-dots" aria-hidden="true">
      ⠿
    </span>
  );
}
