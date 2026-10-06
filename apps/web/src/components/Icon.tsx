import {
  ShieldAlert,
  Bike,
  HandCoins,
  WalletCards,
  Pill,
  Crosshair,
  Car,
  Flame,
  MapPin,
  type LucideIcon,
} from "lucide-react";
import type { IncidentCategory } from "@crime-radar/shared";
export const categoryColors: Record<IncidentCategory, string> = {
  violence: "#a33d57",
  theft: "#bb791b",
  robbery: "#c15f37",
  fraud: "#7857a6",
  drugs: "#467861",
  weapons: "#52668f",
  traffic: "#287f9e",
  fire: "#c44131",
  other: "#707a76",
};
export const categoryIcons: Record<IncidentCategory, LucideIcon> = {
  violence: ShieldAlert,
  theft: Bike,
  robbery: HandCoins,
  fraud: WalletCards,
  drugs: Pill,
  weapons: Crosshair,
  traffic: Car,
  fire: Flame,
  other: MapPin,
};
export const categorySymbols: Record<IncidentCategory, string> = {
  violence: "!",
  theft: "B",
  robbery: "R",
  fraud: "$",
  drugs: "+",
  weapons: "W",
  traffic: "T",
  fire: "F",
  other: "•",
};
export function CategoryIcon({
  category,
  size = 20,
}: {
  category: IncidentCategory;
  size?: number;
}) {
  const Icon = categoryIcons[category];
  return (
    <span
      className="category-icon"
      style={{
        color: categoryColors[category],
        background: `${categoryColors[category]}16`,
      }}
    >
      <Icon size={size} aria-hidden="true" />
    </span>
  );
}
