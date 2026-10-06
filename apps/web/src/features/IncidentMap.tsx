import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import {
  type GeoJSONSource,
  type Map as MapInstance,
  type StyleSpecification,
} from "maplibre-gl";
import type { FeatureCollection, Point } from "geojson";
import { useTranslation } from "react-i18next";
import { type Incident, type Bounds } from "@crime-radar/shared";
import type { LocationResult } from "../services";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { addCategoryImages } from "./markerImages";
maplibregl.setWorkerUrl(workerUrl);
export interface MapController {
  zoomIn: () => void;
  zoomOut: () => void;
  home: () => void;
  locate: (position: GeolocationPosition) => void;
  goTo: (place: LocationResult) => void;
}
interface Props {
  incidents: Incident[];
  mode: "markers" | "heatmap";
  dark: boolean;
  onBounds: (bounds: Bounds) => void;
  onSelect: (id: string) => void;
  onReady: (controller: MapController) => void;
  center?: [number, number];
  zoom?: number;
  interactive?: boolean;
}
function style(dark: boolean): StyleSpecification | string {
  if (import.meta.env.VITE_MAP_STYLE_URL)
    return import.meta.env.VITE_MAP_STYLE_URL;
  return `https://tiles.openfreemap.org/styles/${dark ? "dark" : "positron"}`;
}
const collection = (items: Incident[]): FeatureCollection<Point> => ({
  type: "FeatureCollection",
  features: items.map((i) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [i.location.longitude, i.location.latitude],
    },
    properties: {
      id: i.id,
      category: i.category,
    },
  })),
});
export default function IncidentMap(props: Props) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<MapInstance | null>(null);
  const current = useRef(props);
  current.current = props;
  const [error, setError] = useState<"tiles" | "webgl" | null>(null);
  const [retry, setRetry] = useState(0);
  const userMarker = useRef<maplibregl.Marker | null>(null);
  useEffect(() => {
    if (!host.current) return;
    let map: MapInstance;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    try {
      map = new maplibregl.Map({
        container: host.current,
        style: style(current.current.dark),
        center: current.current.center ?? [31.2, 48.4],
        zoom: current.current.zoom ?? 5,
        minZoom: 3,
        maxZoom: 19,
        interactive: current.current.interactive ?? true,
        attributionControl: { compact: true },
        renderWorldCopies: false,
      });
      instance.current = map;
    } catch {
      setError("webgl");
      return;
    }
    const bounds = () => {
      const b = map.getBounds();
      current.current.onBounds({
        north: Math.min(85, b.getNorth()),
        south: Math.max(-85, b.getSouth()),
        east: Math.min(180, b.getEast()),
        west: Math.max(-180, b.getWest()),
      });
    };
    const layers = () => {
      if (map.getSource("incidents")) return;
      map.addSource("incidents", {
        type: "geojson",
        data: collection(current.current.incidents),
        cluster: true,
        clusterMaxZoom: 13,
        clusterRadius: 48,
      });
      map.addSource("density", {
        type: "geojson",
        data: collection(current.current.incidents),
      });
      map.addLayer({
        id: "heatmap",
        type: "heatmap",
        source: "density",
        paint: {
          "heatmap-weight": 1,
          "heatmap-intensity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5,
            0.8,
            14,
            2,
          ],
          "heatmap-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4,
            18,
            14,
            40,
          ],
          "heatmap-opacity": 0.72,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(33,138,110,0)",
            0.25,
            "#b5dcc2",
            0.5,
            "#5db28d",
            0.75,
            "#e8c760",
            1,
            "#c87143",
          ],
        },
      });
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "incidents",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#176b53",
          "circle-radius": ["step", ["get", "point_count"], 23, 20, 27, 80, 32],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "incidents",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 14,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#fff" },
      });
      addCategoryImages(map);
      map.addLayer({
        id: "points",
        type: "symbol",
        source: "incidents",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": ["concat", "category-", ["get", "category"]],
          "icon-size": 1,
          "icon-allow-overlap": true,
        },
      });
      const mode = current.current.mode;
      for (const id of ["clusters", "cluster-count", "points"])
        map.setLayoutProperty(
          id,
          "visibility",
          mode === "markers" ? "visible" : "none",
        );
      map.setLayoutProperty(
        "heatmap",
        "visibility",
        mode === "heatmap" ? "visible" : "none",
      );
    };
    map.on("style.load", layers);
    map.on("load", () => {
      bounds();
      setError(null);
    });
    map.on("moveend", () => {
      clearTimeout(debounce);
      debounce = setTimeout(bounds, 400);
    });
    map.on("error", (event) => {
      if (
        event.error?.message?.includes("tile") ||
        event.error?.message?.includes("Failed to fetch")
      )
        setError("tiles");
    });
    map.on("click", "clusters", async (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const source = map.getSource("incidents") as GeoJSONSource;
      const zoom = await source.getClusterExpansionZoom(
        Number(feature.properties.cluster_id),
      );
      if (instance.current === map && feature.geometry.type === "Point")
        map.easeTo({
          center: feature.geometry.coordinates as [number, number],
          zoom,
          duration: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? 0
            : 450,
        });
    });
    map.on("click", "points", (e) => {
      const id = e.features?.[0]?.properties.id;
      if (id) current.current.onSelect(String(id));
    });
    for (const id of ["clusters", "points"]) {
      map.on("mouseenter", id, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", id, () => {
        map.getCanvas().style.cursor = "";
      });
    }
    current.current.onReady({
      zoomIn: () => map.zoomIn(),
      zoomOut: () => map.zoomOut(),
      home: () => map.flyTo({ center: [31.2, 48.4], zoom: 5 }),
      goTo: (place) =>
        map.flyTo({
          center: [place.longitude, place.latitude],
          zoom: place.zoom ?? 12,
        }),
      locate: (position) => {
        const coords: [number, number] = [
          position.coords.longitude,
          position.coords.latitude,
        ];
        userMarker.current?.remove();
        userMarker.current = new maplibregl.Marker({ color: "#287f9e" })
          .setLngLat(coords)
          .addTo(map);
        map.flyTo({ center: coords, zoom: 13 });
      },
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      clearTimeout(debounce);
      userMarker.current?.remove();
      map.remove();
      instance.current = null;
    };
  }, [retry]);
  useEffect(() => {
    const map = instance.current;
    if (!map) return;
    const source = map.getSource("incidents") as GeoJSONSource | undefined;
    source?.setData(collection(props.incidents));
    (map.getSource("density") as GeoJSONSource | undefined)?.setData(
      collection(props.incidents),
    );
  }, [props.incidents]);
  useEffect(() => {
    const map = instance.current;
    if (!map || !map.getLayer("points")) return;
    for (const id of ["clusters", "cluster-count", "points"])
      map.setLayoutProperty(
        id,
        "visibility",
        props.mode === "markers" ? "visible" : "none",
      );
    map.setLayoutProperty(
      "heatmap",
      "visibility",
      props.mode === "heatmap" ? "visible" : "none",
    );
  }, [props.mode]);
  const lastTheme = useRef(props.dark);
  useEffect(() => {
    if (lastTheme.current === props.dark) return;
    lastTheme.current = props.dark;
    instance.current?.setStyle(style(props.dark));
  }, [props.dark]);
  return (
    <div className="map-wrapper">
      <div
        ref={host}
        className="map-canvas"
        role="region"
        aria-label={t("mapLabel")}
      />
      {error && (
        <div className="map-error" role="status">
          <p>{t(error === "webgl" ? "mapUnavailable" : "mapError")}</p>
          <button
            onClick={() => {
              setError(null);
              setRetry((v) => v + 1);
            }}
          >
            {t("retry")}
          </button>
        </div>
      )}
    </div>
  );
}
