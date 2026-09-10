# Passenger

An interesting experiment: a YouTube and Twitch player that decodes video on a browser canvas instead of a video element, with a Cloudflare Worker doing the fetching. No Node server, containers, yt-dlp, or FFmpeg processes. Decoding and audio run in the browser on self-hosted AVPlayer WebAssembly assets.

Personal deployment: https://passenger.autorun.sh

The Workers custom domain is configured in `wrangler.toml`. The original https://tesla-video-drive.alexanderjunior2478.workers.dev address also remains available. Browser history and YouTube connections are separate for each hostname; pair accounts on the custom domain.

## Run locally

Requires Node.js 22 or later.

```sh
npm ci
npx playwright install chromium # only for browser tests
npm run dev
```

Open http://localhost:8787. The first build downloads and verifies the pinned player assets and bundles the browser code from `web/` into `public/` with esbuild. `npm run dev` creates a private random media-signing key in the ignored `.dev.vars` file if it does not exist. Wrangler simulates KV locally.

Search YouTube by title, topic, or channel, or paste a public video link. Explore offers real public search results by topic. Select Shorts for a vertical feed with scroll/swipe and next/previous controls; playback starts after a user gesture and only one clip owns the canvas/audio player. Select Twitch for a live channel name/link.

The player includes pause and seek for recordings, stop, volume, fullscreen where supported, and recent items stored on this browser. Videos with multiple audio tracks show an **Audio** language menu in the player and Shorts controls. YouTube's explicitly marked original track plays first; switching languages preserves the playback position. Live streams use Stop; the browser decoder does not support live pause. Twitch OAuth and importing followed channels are deferred.

## Connect a YouTube account

Choose **Connect YouTube**, then scan the QR code with the phone that has the desired account. The QR code opens Google's activation page with the pairing code filled in. The code also appears for manual entry. This uses the [YouTube on TV flow supported by YouTube.js](https://ytjs.dev/guide/authentication), rather than this app's own Google OAuth client. Google displays the permissions required by that TV flow. The TV client rejects the narrower `youtube.readonly` scope, so the app requests the legacy YouTube scope; it omits paid-content access and only reads feeds.

After pairing, Home, Subscriptions, Liked videos, and account Shorts use that browser's TV session. Shorts recommendations use a real reel sequence; if Home supplies no Short to start from, choose a Short first. The official Data API does not expose the user's Home feed, so these account feeds depend on TV InnerTube responses and need verification after the user pairs an account.

When this browser has a connected account, playback resolves through that signed-in session first, because YouTube's bot check judges address reputation and a signed-in session passes where anonymous datacenter requests are refused. Without one, or if it is refused, the public VISIONOS session is tried. Connecting an account does not enable restricted media. Passenger never sends YouTube's playback-tracking pings, so watching here does not add to watch history. The account connection also supplies browsing feeds.

Each browser has a separate random HttpOnly/Secure cookie. Device codes and tokens are encrypted with AES-GCM in KV, using a key derived from the signing secret and a separate account-storage context. Pending pairing expires after at most 30 minutes; account sessions expire after 30 days. No credentials are returned to JavaScript or logged. **Disconnect this browser** deletes its stored connection without revoking the shared YouTube TV application grant on unrelated devices.

## Who can watch (sign-in)

Passenger is open to anyone with the address until Google sign-in is configured. After that, every API call needs a signed-in session and the player shows a sign-in screen instead. Any Google account can sign in; there is no list to maintain. Sessions, users and device codes live in the `passenger-auth` D1 database, managed by [Better Auth](https://www.better-auth.com/) with its device-authorization plugin. The tables are defined with Drizzle in `src/db/schema.ts`.

Signing in on a screen without a keyboard works like the YouTube pairing:

1. The screen shows a QR code and a 6-character code.
2. The phone scans the QR code (or opens `passenger.autorun.sh/approve` and types the code).
3. The phone signs in with Google and taps **Approve this screen**. The screen signs in within a few seconds. The phone is signed in too.

Sessions last 90 days per browser. **Sign out** in the sidebar ends the session on that device. Laptops can use **Sign in with Google on this screen instead**.

### Set up Google sign-in once

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project, for example `Passenger`.
2. Under **APIs & Services → OAuth consent screen**, choose **External** and fill in the app name and support email. Basic `openid email profile` scopes need no verification.
3. Under **Credentials**, create an **OAuth client ID** of type **Web application** with these authorized redirect URIs:
   - `https://passenger.autorun.sh/api/auth/callback/google`
   - `https://tesla-video-drive.alexanderjunior2478.workers.dev/api/auth/callback/google`
   - `http://localhost:8787/api/auth/callback/google` (local development)
4. Put the client ID in `wrangler.toml` under `[vars]` as `GOOGLE_CLIENT_ID`.
5. Store the secret and deploy. `BETTER_AUTH_SECRET` is already set on this deployment; set a new random one for a different account.

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run db:migrate   # applies migrations/*.sql to the passenger-auth D1 database
npm run deploy
```

Locally, put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.dev.vars` and run `npm run db:migrate:local` once. `AUTH_DEV_PASSWORD=true` in `.dev.vars` enables email/password sign-in for browser tests without Google.

`npm run db:generate` (drizzle-kit) writes a new migration after a schema change, for example after a Better Auth upgrade adds fields. Better Auth's [admin plugin](https://www.better-auth.com/docs/plugins/admin) can ban accounts later if that becomes necessary.

`npm run smoke` needs an open player. Run it locally without Google settings, or against a deployment where sign-in is not configured.

## Working on this repo

Prerequisites: Node.js 22.18 or later, npm, and Chromium for Playwright (`npx playwright install chromium`).

```sh
npm ci
npm run typecheck   # generates Cloudflare runtime types, then checks the Worker, tests, browser code and smoke script
npm test            # unit tests on Node's test runner (in-memory D1 stand-in for auth tests)
npm run dev         # vendors the player, bundles web/, creates .dev.vars secrets, starts wrangler dev on :8787
npm run smoke       # real-browser playback check against the dev server (needs sign-in off, see below)
npm run check       # everything above plus a dry-run deploy bundle
```

Conventions:

- Everything is TypeScript with `strict` on. Relative imports carry `.ts` extensions and only erasable syntax is used (no enums), because tests and scripts run directly on Node's type stripping.
- `src/` runs in the Worker (Web APIs and Cloudflare bindings only), `web/` runs in the browser (DOM), `scripts/` and `test/` run in Node. Keep those boundaries; the three tsconfigs enforce them.
- Cloudflare config lives in `wrangler.toml`. Database tables are Drizzle schema in `src/db/schema.ts`; change the schema, then `npm run db:generate`, and commit the files under `migrations/`.
- Secrets never enter the repo. Local values go in the ignored `.dev.vars`; production values are Wrangler secrets.
- Behaviour that touches YouTube or Twitch gets a test with a recorded fixture, and the smoke test is the final gate before a deploy.
- Deploys go to the owner's personal Cloudflare account through the `personal` wrangler profile (next section). To run a copy under your own account, change `account_id` in `wrangler.toml`, create your own KV namespace and D1 database, and point the bindings at them.

## Personal Cloudflare account

Use the project-local CLI:

```sh
npx wrangler whoami
npx wrangler auth list
```

This checkout is bound locally to the `personal` authentication profile. `wrangler.toml` pins the personal account. The older globally installed `wrangler` does not support this profile setup; use `npx wrangler` here.

On another machine, create and activate your own profile:

```sh
npx wrangler auth create personal
npx wrangler auth activate personal .
```

The profile and its credentials live outside this repository. The checked-in account ID is an identifier, not a credential.

## Deploy

```sh
npm test
npm run check
npm run deploy
npx wrangler secret put MEDIA_SIGNING_SECRET
```

Use a new random secret of at least 32 characters when configuring a new deployment. This personal deployment already has its secret and `APP_DATA` KV namespace configured. Normal deployments retain the secret; the local `.dev.vars` file is never uploaded automatically. For a different account, change `account_id` and remove the KV `id` so Wrangler can provision a new namespace. No R2 credentials or Twitch application credentials are needed.

`npm run check` bundles the Worker without publishing. Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) apply, including the free plan's 10 ms CPU allowance. Provider resolution is the most CPU-intensive request; check actual request measurements before relying on the free tier for sustained use.

## How playback works

1. `POST /api/search` returns up to 12 public YouTube video results. `POST /api/resolve` validates a YouTube URL/video ID or Twitch channel and asks that provider for its current media sources.
2. For YouTube, the Worker creates a real public session using YouTube.js’s VISIONOS client and resolves segmented HLS for recordings and compatible live videos. It does not execute upstream player scripts. YouTube playlists are restricted to H.264 video up to 480p with AAC audio.
3. Twitch also uses HLS. Every variant, segment, map, and key URL is rewritten to the same origin.
4. The shared media endpoint verifies an expiring HMAC signature, enforces the provider's CDN domains on every redirect, forwards byte ranges, and streams the response body without buffering the video.
5. AVPlayer fetches the media, demuxes it, decodes it in baseline WASM, and renders to a canvas. Audio and video use one player clock.

Signed playback links expire after at most six hours, or sooner if the upstream URLs expire. KV stores browser diagnostic reports, which expire after seven days; media is streamed directly and never stored. The probe at `/probe/` can download a complete JSON report or save one to Worker KV; it only requests microphone permission when its test button is clicked.

## Code layout

Everything is TypeScript. The Worker in `src/` is bundled by wrangler, the browser code in `web/` by esbuild, and tests and scripts run directly under Node 22's type stripping (so they use only erasable syntax and `.ts` import specifiers). `npm run typecheck` generates the Cloudflare runtime types and checks the three programs: Worker plus tests and scripts, the browser code, and the Playwright smoke script.


| Location | Responsibility |
| --- | --- |
| `src/index.ts` | Worker entry point and provider registration |
| `src/app.ts` | API routing, input validation, playback signing, sign-in gating and report persistence |
| `src/auth.ts` | Better Auth setup: Google sign-in, device codes for keyboard-less screens, session cookie adoption |
| `src/db/schema.ts` | Drizzle schema for the auth tables in D1 |
| `src/providers/youtube.ts` | Public YouTube HLS resolution |
| `src/providers/youtube-search.ts` | Public YouTube search |
| `src/providers/youtube-shorts.ts` | Actual Shorts discovery and continuation |
| `src/providers/twitch.ts` | Public Twitch metadata and HLS resolution |
| `src/account.ts` | TV pairing, encrypted per-browser account sessions, refresh and disconnect |
| `src/account-feeds.ts` | Authenticated TV Home, subscriptions, likes and reel recommendations |
| `src/media.ts` | Signed media links, redirect policy, streaming and playlist rewriting |
| `web/gate.ts` | Sign-in screen; loads the player once a session exists |
| `web/app.ts` | Source selection, request lifecycle, recent videos and controls |
| `web/player.ts` | Browser decoder lifecycle and media playback |
| `web/account.ts` | Google activation dialog and account status |
| `web/approve.ts` | Phone page that approves another screen's sign-in code |
| `scripts/build-web.ts` | Bundles `web/` into `public/` with esbuild |
| `scripts/vendor-player.ts` | Reproducible, checksum-verified player asset preparation |
| `scripts/patch-player.ts` | Pinned player fixes for HLS AAC detection and late callbacks after cancellation |

To add a source, implement its resolver, register it in `src/index.ts`, add its explicit CDN policy to `src/media.ts`, and add a source choice in the frontend. Keep service-specific discovery separate from the shared playback and proxy code. A resolver returns metadata plus an HLS or MP4 URL using a supported codec.

## Validation and practical limits

`npm test` exercises provider/search/Shorts results and failures, request validation, signed URL tampering/expiry, redirect restrictions, HLS filtering/rewriting, byte ranges, player compatibility patches, account isolation/encryption/polling, feed parsing, and browser report contents. Test fixtures do not require service accounts.

YouTube sometimes answers requests from Cloudflare's network with a sign-in check ("confirm you're not a bot"); the API reports it as `YOUTUBE_BOT_CHECK`. The Worker uses the browser's connected YouTube account first when there is one, then an anonymous session with one retry, and the player retries a refused resolve up to three more times before it shows the error. Proof-of-origin (BotGuard) tokens were tested from Cloudflare's network on 2026-09-10 and do not clear this check; it follows the egress address and its recent traffic, which matches yt-dlp's guidance that only a signed-in session or a different address does. On 2026-09-09 about half of anonymous resolves were refused. Connect a YouTube account in the browser that plays; the connected session passes the check.

Workers Logs are enabled in `wrangler.toml`. Every YouTube attempt logs a `youtube.resolve` line with the video ID, attempt number, whether the account session was used, and YouTube's status and reason. Media proxy refusals log `media.upstream_refused`. Stream them live with `npx wrangler tail`, or browse them under the Worker's Logs tab in the Cloudflare dashboard.

`npm run smoke` runs Chromium against the local Worker with real public YouTube media. It checks canvas and audio progression, pause/resume, a seek beyond the first minute, and stop cleanup. It uses real network services and can fail when an upstream video becomes unavailable.

```sh
# Local Worker must already be running, or set BASE_URL to the deployed site.
BASE_URL=https://passenger.autorun.sh npm run smoke
TWITCH_CHANNEL=eslcs npm run smoke # use a channel that is currently live
YOUTUBE_VIDEO=ID-K64Jk6JM AUDIO_LANGUAGE=es npm run smoke # original audio, dub switching, pause and position
```

`YOUTUBE_VIDEO` overrides the default test video. `AUDIO_LANGUAGE` checks that a marked original is selected, switches to a matching dub, and restores the original while paused. No service login or user browser session is used by the smoke test.

YouTube and Twitch resolution use unofficial endpoints through [YouTube.js](https://github.com/LuanRT/YouTube.js) and the playback flow documented by [yt-dlp's Twitch extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/twitch.py). Those services can change their responses, require sign-in, or block Cloudflare IPs. VISIONOS currently provides full media access in the checked flows; this is an upstream compatibility dependency, not a permanent guarantee. This app reports those failures; private, paid, DRM-protected, and sign-in-required media are not supported. Some YouTube live/post-live formats are unavailable.

Desktop playback says nothing about the target browser. It still needs testing for WASM, BigInt, WebGL, audio, sustained decoding performance, and playback behavior. The built-in probe records capabilities; it does not certify in-motion behavior.

## Player licenses

The browser player and separately hosted decoder files retain their upstream licenses and source links. See [player licenses and reproducible assets](docs/player-licenses.md). The generated `/vendor/avplayer/SOURCES.md` and license directory are shipped with the app.

The development dependency override pins Miniflare’s Sharp dependency to the compatible 0.35.4 security patch until Miniflare updates its own pin.
