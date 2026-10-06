import type { Map } from "maplibre-gl";
import { categories } from "@crime-radar/shared";
import { categoryColors } from "../components/Icon";
// Compact vector pictograms, rasterized once per style for native GPU map layers.
const paths = {
  violence:
    "M12 2 L21 6 L20 14 Q18 20 12 23 Q6 20 4 14 L3 6 Z M12 7 L12 13 M12 17 L12 18",
  theft:
    "M9 7 L14 7 L18 15 M9 7 L5 16 L12 16 L9 7 M12 16 L16 9 M7 4 L11 4 M3 12 A4 4 0 1 0 3 20 A4 4 0 1 0 3 12 M20 12 A4 4 0 1 0 20 20 A4 4 0 1 0 20 12",
  robbery:
    "M3 7 L20 7 L20 20 L3 20 Z M3 7 L17 3 L20 7 M16 12 L22 12 L22 16 L16 16 Z",
  fraud:
    "M3 4 L21 4 L21 20 L3 20 Z M3 9 L21 9 M7 14 L11 14 M7 17 L9 17 M17 12 L17 18 M15 14 Q19 12 19 15 Q15 16 15 17 Q16 20 19 18",
  drugs:
    "M8 3 Q14 -1 19 4 Q24 9 20 13 L12 21 Q6 25 2 19 Q-1 15 4 10 Z M7 7 L17 17",
  weapons:
    "M12 4 A8 8 0 1 0 12 20 A8 8 0 1 0 12 4 M12 0 L12 7 M12 17 L12 24 M0 12 L7 12 M17 12 L24 12",
  traffic:
    "M4 11 L7 4 L17 4 L20 11 M3 11 L21 11 L21 19 L3 19 Z M5 19 L5 22 M19 19 L19 22 M6 14 L8 14 M16 14 L18 14",
  fire: "M12 2 Q13 8 18 10 Q23 17 18 21 Q12 26 5 20 Q0 14 8 8 Q6 14 10 13 Q14 10 12 2 Z M12 15 Q7 19 12 22 Q17 19 12 15",
  other: "M12 2 A10 10 0 1 0 12 22 A10 10 0 1 0 12 2 M12 10 L12 17 M12 6 L12 7",
};
export function addCategoryImages(map: Map) {
  for (const category of categories) {
    if (map.hasImage(`category-${category}`)) continue;
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    const context = canvas.getContext("2d");
    if (!context) continue;
    context.scale(2, 2);
    context.fillStyle = categoryColors[category];
    context.strokeStyle = "#fff";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(24, 24, 21, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.save();
    context.translate(14, 14);
    context.scale(0.83, 0.83);
    context.lineWidth = 1.8;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke(new Path2D(paths[category]));
    context.restore();
    map.addImage(`category-${category}`, context.getImageData(0, 0, 96, 96), {
      pixelRatio: 2,
    });
  }
}
