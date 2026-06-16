# figager-relay

Always-on, serverless WebSocket relay for FIGAGER / Voxel.
Cloudflare Worker + 1 Durable Object. Implements `CLOUDFLARE-RELAY-BRIEF.md`.

## One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USERNAME/YOUR_REPO)

> Replace `YOUR_USERNAME/YOUR_REPO` in the URL above with the GitHub repo
> that contains this `relay-cf/` directory (or fork it). The button opens
> Cloudflare in the user's browser, runs OAuth, reads `wrangler.toml`, and
> deploys — no CLI, no laptop required.

After the deploy finishes, Cloudflare shows the Worker URL
(`https://figager-relay.<sub>.workers.dev`). Copy it — that's what you paste
into the Make app and the Figma plugin.

## What gets deployed

- `wss://figager-relay.<sub>.workers.dev` — fan-out hub (WS Hibernation API)
- `https://figager-relay.<sub>.workers.dev/published.json` — player snapshot
- `POST https://figager-relay.<sub>.workers.dev/publish` — freeze snapshot
- 1 Durable Object (`Relay`, SQLite-backed) — free plan eligible

## Manual deploy (alternative)

```bash
cd relay-cf
npm install
npx wrangler login
npx wrangler deploy
npx wrangler tail        # live logs
```

## After deploy

1. **Make app:** open the preview, paste the Worker URL into the onboarding
   screen. The URL is remembered in `localStorage`.
2. **Plugin:** set `RELAY_URL` in `plugin/ui.html` and add the origin to
   `networkAccess.allowedDomains` in `plugin/manifest.json`:
   ```json
   "networkAccess": {
     "allowedDomains": [
       "wss://figager-relay.<sub>.workers.dev",
       "https://figager-relay.<sub>.workers.dev"
     ]
   }
   ```
