# Cloudflare Workers deployment

The first release serves the PWA with **fictional demo data** using Workers Static Assets. It does not publish the local API or database. Static asset requests are free and unlimited, with no additional asset-storage charge. Worker code execution has separate quotas/pricing; this release has no server-side Worker script. See [current billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). A custom domain purchase and second-phase API/database are separate costs.

## Publish from this repository

Requires Node.js 22.12+ and an existing Cloudflare account. The project configuration is in `wrangler.jsonc`. Credentials remain in Wrangler's local configuration, outside this repository.

```sh
npm ci
npx wrangler whoami
# Only if no existing login is available:
npx wrangler login
# Build and publish after the Git commit:
npm run deploy:web
```

For this first release use `VITE_DATA_SOURCE=mock` and an empty `VITE_API_URL`. Local `.env.local` overrides must be reviewed before publishing: Vite includes public configuration in browser assets. Publish from the verified `main` branch. `wrangler deploy` updates production; it is not a branch-preview command. Upload output is `apps/web/dist/`, not the repository or API source.

Publishing uses existing Wrangler CLI authentication. Pushing GitHub triggers the verification workflow; deployment is a separate `npm run deploy:web` step. For automatic deployment later, connect Workers Builds to this GitHub repository or add a GitHub Actions deployment job with a scoped account token stored as a repository secret. See [Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

The production address is [crime-radar.w-siteee.workers.dev](https://crime-radar.w-siteee.workers.dev). It is hosted by Cloudflare, while GitHub stores the source. The repository's configuration and publish command target only Workers.

## Routing, headers and updates

The `_redirects` rule `/incident/* / 200` serves the root app shell for incident links while keeping the address unchanged. `assets.not_found_handling = "none"` preserves real 404 responses for missing assets and API URLs instead of returning HTML. This avoids caching HTML under a missing JavaScript asset name. See [Workers static redirects](https://developers.cloudflare.com/workers/static-assets/redirects/).

Vite copies `_headers` and `_redirects` from `apps/web/public/` into the release. Hashed `/assets/*` files receive immutable caching; HTML, service worker and manifest revalidate. Camera/microphone permissions are disabled and geolocation is limited to this origin, where the UI requests it only after a tap.

After upload, verify HTTPS, the map, a direct incident link, manifest/icons, missing-asset 404 responses and cache headers. Load once online before checking the offline shell. Map tiles are not guaranteed offline. Physical phone installation/Web Share and Lighthouse are separate release checks; scores are not claimed without an audit.

## Release verification

Open `/`, refresh a direct `/incident/demo-0001` link, inspect the manifest and icons, and install from HTTPS. Load the application once, disconnect, and verify the shell and fictional demo data. API responses have a five-minute network-first cache; base map tiles are not precached and are not guaranteed offline. Reconnect and accept the update prompt for a new service worker.

Check browser console, map provider terms/capacity, and Lighthouse on the deployed HTTPS build. The requested >90 Lighthouse scores are targets, not claimed measurements. The MapLibre engine and worker are intentionally separate lazy chunks.
