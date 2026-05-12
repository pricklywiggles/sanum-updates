# sanum-updates

A Cloudflare Worker that fronts releases of the Sanum desktop app so it can auto-update without the source or release binaries being public.

The worker holds a fine-grained GitHub PAT with read-only access to the releases repo. Clients never see the token. Downloaded updates are verified against a minisign public key embedded in the app at build time, so a compromised worker still cannot ship a tampered update.

## Setup

Cloudflare account (free is enough) and Node 22+.

```bash
pnpm install
pnpm wrangler login
pnpm wrangler secret put GITHUB_OWNER     # who owns the releases repo
pnpm wrangler secret put GITHUB_REPO      # the releases repo name
pnpm wrangler secret put GITHUB_TOKEN     # fine-grained PAT, Contents: Read
pnpm wrangler deploy
```

Wrangler prints the deployed URL. That goes into `plugins.updater.endpoints[0]` in the app's `tauri.conf.json`, with `/update/{{target}}/{{arch}}/{{current_version}}` appended.

## Routes

`GET /update/{target}/{arch}/{current_version}` returns `204` when the requested version is at or past the latest release, otherwise `200` with Tauri's dynamic updater JSON: `version`, `pub_date`, `notes`, `url`, `signature`. Only macOS `aarch64` and `x86_64` are recognized; everything else gets a `204`.

`GET /download/{asset_id}` streams the asset back. GitHub redirects release-asset downloads to a presigned S3 URL, and S3 rejects requests that include a bearer token alongside the presigned query, so the worker follows the redirect manually and drops the `Authorization` header on the second hop.

## Operating

`pnpm wrangler tail` for live logs. Rotate the PAT with `pnpm wrangler secret put GITHUB_TOKEN`; the next request picks it up. The worker is stateless and does not cache; if usage ever pressures GitHub's 5000/hour authenticated rate limit, wrap the `releases/latest` call in `caches.default` with a short TTL.

## License

MIT
