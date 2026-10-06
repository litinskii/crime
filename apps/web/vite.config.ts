import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "icons/*.png"],
      manifest: {
        name: "Crime Radar",
        short_name: "Crime Radar",
        description: "Publicly reported incidents in Ukraine",
        lang: "uk",
        display: "standalone",
        start_url: "/",
        scope: "/",
        orientation: "portrait-primary",
        theme_color: "#176b53",
        background_color: "#f5f6f3",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        maximumFileSizeToCacheInBytes: 3000000,
        runtimeCaching: [
          {
            urlPattern: /\/api\/v1\//,
            handler: "NetworkFirst",
            options: {
              cacheName: "incident-api",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 60, maxAgeSeconds: 300 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: { output: { manualChunks: { map: ["maplibre-gl"] } } },
  },
});
