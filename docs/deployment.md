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

The resulting address uses `<worker>.<account-subdomain>.workers.dev`. It is hosted by Cloudflare, while GitHub stores the source. An earlier trial Pages upload exists separately; the repository's current configuration and publish command target Workers.

## Routing, headers and updates

Workers uses `assets.not_found_handling = "single-page-application"` to serve the app shell for browser navigation, including direct incident links. Future API routes need explicit routing so they do not receive the SPA shell. See [SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).

Vite copies `_headers` from `apps/web/public/` into the release. Hashed `/assets/*` files receive immutable caching; HTML, service worker and manifest revalidate. Camera/microphone permissions are disabled and geolocation is limited to this origin, where the UI requests it only after a tap.

After upload, verify HTTPS, the map, a direct incident link, manifest/icons, missing-asset 404 responses and cache headers. Load once online before checking the offline shell. Map tiles are not guaranteed offline. Physical phone installation/Web Share and Lighthouse are separate release checks; scores are not claimed without an audit.

## S3 + CloudFront alternative

Build from the repository root: `npm ci && npm run build`. Upload **apps/web/dist/**; the API is an independent server and cannot run inside S3. Set Vite environment values before the build; they are public configuration.

### Distribution

1. Create a private S3 bucket with Block Public Access and bucket-owner-enforced ownership. Use its REST origin, not its website endpoint.
2. Create CloudFront with that origin, an Origin Access Control (OAC), and signed requests. Grant `s3:GetObject` to the CloudFront service principal, constrained to your distribution ARN. Follow the [AWS OAC guide](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html).
3. Set `index.html` as default root object and redirect HTTP to HTTPS. Allow GET/HEAD; keep query strings out of the static asset cache key.
4. For a custom domain, request an ACM certificate in **us-east-1**, add the alternate domain to CloudFront, and create the DNS alias/CNAME after certificate validation.
5. Publish [cloudfront-spa.js](./cloudfront-spa.js) as a viewer-request CloudFront Function attached to the static default behavior. It rewrites `/incident/:id` to `/index.html`; assets and `/api/` remain untouched. AWS documents [viewer-request rewrites](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/example_cloudfront_functions_url_rewrite_single_page_apps_section.html).
6. If the API shares this domain, configure `/api/*` as a separate behavior to the HTTPS API origin, with caching disabled and query strings forwarded. Set the API's `ALLOWED_ORIGINS` to your actual frontend origin. Do not apply the SPA rewrite to API requests.

Prefer the function over globally mapping every S3 403/404 to HTML: missing JavaScript and API failures must not silently return index.html. If a function is unavailable, map 403 and 404 to `/index.html` with response 200 and error TTL 0 only on a dedicated static distribution, understanding this limitation.

### Cache headers

| Files                                                             | Cache-Control                        |
| ----------------------------------------------------------------- | ------------------------------------ |
| `/assets/*` (hashed names)                                        | `public,max-age=31536000,immutable`  |
| `/icons/*`, `/icon.svg`                                           | `public,max-age=86400`               |
| `/index.html`, `/sw.js`, `/workbox-*.js`, `/manifest.webmanifest` | `no-cache,max-age=0,must-revalidate` |

Use a CloudFront cache policy with **Minimum TTL 0** for HTML and the service worker; otherwise the origin's no-cache header can be overridden. Add an `/assets/*` behavior with immutable caching. Preserve content types: JavaScript must not be served as HTML; manifest uses `application/manifest+json`.

Example AWS CLI upload commands, to be run with your actual bucket and distribution IDs:

```sh
aws s3 sync apps/web/dist/assets/ s3://YOUR_BUCKET/assets/ --cache-control "public,max-age=31536000,immutable"
aws s3 sync apps/web/dist/ s3://YOUR_BUCKET/ --exclude "assets/*" --cache-control "no-cache,max-age=0,must-revalidate"
aws cloudfront create-invalidation --distribution-id YOUR_DISTRIBUTION --paths /index.html /sw.js /manifest.webmanifest '/workbox-*'
```

Upload the hashed assets **before** updating HTML in an actual release. Keep older asset versions during the rollout so tabs and installed PWAs can finish loading them. No AWS infrastructure has been created by this repository. Exclude the Cloudflare-specific `_headers` file from the AWS upload.

## Release verification

Open `/`, refresh a direct `/incident/demo-0001` link, inspect the manifest and icons, and install from HTTPS. Load the application once, disconnect, and verify the shell and fictional demo data. API responses have a five-minute network-first cache; base map tiles are not precached and are not guaranteed offline. Reconnect and accept the update prompt for a new service worker.

Check browser console, map provider terms/capacity, and Lighthouse on the deployed HTTPS build. The requested >90 Lighthouse scores are targets, not claimed measurements. The MapLibre engine and worker are intentionally separate lazy chunks.
