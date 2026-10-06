import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { IncidentCategory, Bounds } from "@crime-radar/shared";
export type Period = "24h" | "7d" | "30d" | "1y" | "custom";
export type Theme = "system" | "light" | "dark";
export const initialBounds: Bounds = {
  north: 53,
  south: 44,
  west: 22,
  east: 40,
};
interface Preferences {
  period: Period;
  categories: IncidentCategory[];
  keyword: string;
  customFrom: string;
  customTo: string;
  mode: "markers" | "heatmap";
  theme: Theme;
  set: (value: Partial<Omit<Preferences, "set">>) => void;
}
export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      period: "7d",
      categories: [],
      keyword: "",
      customFrom: "",
      customTo: "",
      mode: "markers",
      theme: "system",
      set: (value) => set(value),
    }),
    {
      name: "crime-radar-session",
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);
