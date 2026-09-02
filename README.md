# CouchTube

Control YouTube on your computer from your phone. Click the extension, scan the QR code with your phone camera, and you get a remote: play/pause, seek, volume, speed, captions, theater, fullscreen, like, skip ads, sleep timer, search, home feed, subscriptions, live streams and "up next", all from bed.

No app to install on the phone. The phone just opens a web page.

```
┌──────────────┐   WebSocket    ┌──────────────┐   WebSocket   ┌──────────────┐
│  Extension   │ ─────────────▶ │  Relay       │ ◀──────────── │  Phone       │
│  (Chrome)    │   role=host    │  apps/relay  │  role=remote  │  /r/#ROOM.TK │
│  YouTube tab │ ◀───────────── │  Node + ws   │ ────────────▶ │  web remote  │
└──────────────┘                └──────────────┘               └──────────────┘
```

The relay never interprets messages; it just forwards JSON between the two sides of a room. A room is a 6-character id plus a random secret token, both encoded in the QR. Same architecture works on your LAN today and on the internet later, only the URL changes.

## Project layout

A pnpm workspace. Each folder under `apps/` is one deployable thing, `packages/` holds shared assets, `tests/` holds cross-app tests. Nothing has a build step except zipping the extension.

```
couchtube/
├── apps/
│   ├── extension/      the Chrome extension (Manifest V3). Load this folder unpacked.
│   │   ├── manifest.json
│   │   ├── background.js   service worker: WebSocket to the relay, tab/window management, routing
│   │   ├── content.js      isolated world: state reporting, scraping of video lists, web-fullscreen CSS
│   │   ├── bridge.js       page (MAIN) world: drives YouTube's real player API
│   │   ├── popup.html/js   the QR code popup + relay setting
│   │   ├── icons/          rendered from packages/brand
│   │   ├── vendor/         qrcode.js (MIT)
│   │   └── scripts/zip.js  packs dist/couchtube-extension-<version>.zip for the store
│   ├── relay/          the server: WebSocket relay + static hosting of website and remote
│   │   ├── src/index.js    rooms, tokens, forwarding, heartbeat (only dependency: ws)
│   │   └── test/           relay tests
│   ├── remote/         the phone page (served at /r/). One HTML file.
│   └── website/        landing page + privacy policy (served at /). Static.
├── packages/
│   └── brand/          logo sources (SVG), rendered PNGs, store tiles, render script
├── tests/
│   └── e2e/            Playwright end-to-end test (real extension, faked youtube.com)
├── package.json        workspace scripts (below)
└── pnpm-workspace.yaml
```

## Commands (run from the root)

| command | what it does |
|---|---|
| `pnpm install` | installs everything (ws for the relay, Playwright for tests and brand, adm-zip for packing) |
| `pnpm dev` | starts the relay with auto-reload on `http://localhost:8787` (website at `/`, phone remote at `/r/`) |
| `pnpm start` | starts the relay for production |
| `pnpm test` | relay tests |
| `pnpm e2e` | end-to-end test in headless Chromium (needs `pnpm exec playwright install chromium` once, or `CHROME_PATH=...`) |
| `pnpm check` | syntax-checks the extension and relay |
| `pnpm build:extension` | zips the extension into `dist/` for the Chrome Web Store / Edge Add-ons |
| `pnpm brand:render` | re-renders icons, tiles and lockups from the SVG logo |

## Run it locally (same Wi-Fi)

1. Start the relay

   ```bash
   pnpm install
   pnpm dev
   ```

   It prints something like:

   ```
   CouchTube relay running
     local:   http://localhost:8787
     network: http://192.168.1.20:8787   <- phones use this (same Wi-Fi)
     ws:      ws://localhost:8787/ws     <- relay URL in the extension
   ```

   Windows: the first time, Windows Firewall will ask to allow Node on private networks. Say yes, otherwise the phone cannot reach the server. If the "network" IP it picked is wrong (VPN, virtual adapters), run `set PUBLIC_URL=http://<your-lan-ip>:8787` before `npm start` (PowerShell: `$env:PUBLIC_URL="http://192.168.1.20:8787"`).

2. Load the extension

   - Chrome (or Edge/Brave): `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the `apps/extension/` folder.
   - Pin the CouchTube icon.

3. Pair

   - Open any YouTube video on the computer.
   - Click the CouchTube icon. It shows a QR code (default relay is `ws://localhost:8787`).
   - Scan the QR with the phone camera. The remote opens in the phone browser and shows "Connected".

4. Lie down.

## Deploy it (server + extension on the internet)

The relay is a single Node process with no database, so any Node host works: Railway, Render, Fly.io, a VPS with pm2, etc.

1. Deploy the repo with `pnpm install` as the build command and `pnpm start` as the start command (the relay serves the website and the phone remote from `apps/website` and `apps/remote`, so one deployment covers all three). Set env vars:
   - `PORT` (most hosts set this for you)
   - `PUBLIC_URL=https://your-domain.com` (this is what goes into the QR)
   The host must support WebSockets (all the ones above do). Use HTTPS: the phone page then automatically uses `wss://`.
2. In the extension popup, open **Relay server** and set `wss://your-domain.com`, then **Save & reconnect**. (Or change `DEFAULT_RELAY` in `background.js` before publishing.)
3. To publish on the Chrome Web Store: `pnpm build:extension` gives you the zip in `dist/`, use the tiles and icon in `packages/brand/`, add real screenshots, and link the privacy policy at `https://your-domain/privacy.html`.
4. In `apps/website/index.html`, set `CHROME_STORE_URL` once the listing is live so the site's buttons point to the store.

Because the relay is on the internet, the phone no longer needs to be on the same Wi-Fi, which is a nice side effect.

## How it works, in more detail

**Pairing.** The extension connects as `role=host`. The relay creates a room `{id, token}` and returns `remoteUrl = PUBLIC_URL/r/#ID.TOKEN`. The popup turns that into a QR. The token lives in the URL hash, so it never hits server logs. A phone joining with the wrong token gets closed with code `4001`. "New code" in the popup closes the socket with code `4003`, which destroys the room, so old QRs die immediately; connected phones see "Session ended".

**Keeping the worker alive.** MV3 service workers are killed when idle. The extension pings the relay every 20 s (Chrome 116+ keeps a worker alive while a WebSocket is active) and a 30 s alarm reconnects if the worker was restarted. The room id/token are stored in `chrome.storage.session` so a restarted worker resumes the same room and the QR on screen stays valid.

**Controlling the player.** Content scripts run in an isolated world and cannot call YouTube's player API. `bridge.js` runs in the page's MAIN world and talks to `document.getElementById('movie_player')` (`playVideo`, `seekTo`, `setVolume`, `nextVideo`…), which keeps YouTube's own UI in sync. It falls back to the raw `<video>` element if the API is missing. `content.js` and `bridge.js` talk through DOM CustomEvents with string payloads.

**Fullscreen without a click.** Browsers only honour `requestFullscreen()` within a few seconds of a real click on the page, and the click is consumed by the first fullscreen, which is why a remote command was refused. `bridge.js` still tries the real API first (it works if you just clicked), and otherwise switches to *web fullscreen*: a CSS class pins `#movie_player` over the whole page, and the extension puts the browser window itself into fullscreen with `chrome.windows.update({ state: 'fullscreen' })`, which needs no gesture. It looks the same as YouTube's fullscreen, toggles on and off from the phone as often as you like, survives picking the next video from the phone (the extension re-applies it after the page loads), and `Esc` on the computer exits it. The previous window state (maximized/normal) is restored on exit.

One trap worth knowing: YouTube sets `view-transition-name: player-resize` on `#player-container`, which makes that element a stacking context, so the player stays *under* the masthead and sidebar no matter how high its `z-index` is. `bridge.js` tags every ancestor of the player with `data-couchtube-ancestor` and the CSS resets `view-transition-name`, `isolation`, `contain`, `container-type`, `transform` and `filter` on them, and hides the masthead outright. Verified on the live site.

**Up next, like YouTube.** Every time a watch page loads, or the playing video changes (autoplay, a click on the computer), the extension scrapes the sidebar and the phone's "Up next" card refreshes. When the video ends (`ended-mode`), it scrapes YouTube's end screen instead: the autoplay pick (tagged NEXT) plus the wall of suggestions (`.ytp-videowall-still`), the card turns red with a Replay button and scrolls into view. The Autoplay chip mirrors YouTube's toggle.

**Live.** The "Live now" tab opens YouTube's Live destination (`/channel/UC4R8DWoMoI7CAwX8_LjQHig`) and lists what's streaming; items with a LIVE badge or "N watching" are tagged red in every list (home, subscriptions, search, up next). While watching a stream the phone shows a LIVE tag, hides the duration and offers "Jump to live".

**Sleep timer.** Runs as a `chrome.alarms` alarm in the extension, so it fires even if the phone's screen is off or the phone disconnected. The phone shows a countdown.

**Which tab.** The background worker controls the YouTube tab that is playing; if none is, the active one; if there is no YouTube tab, it opens one when you search from the phone.

**Browsing from the phone.** Search / Home / Subscriptions navigate the tab, then the content script scrapes the video list (`ytd-video-renderer`, `ytd-rich-item-renderer`, `yt-lockup-view-model`…) and sends title, channel, duration, thumbnail and URL to the phone. Tapping a result opens it in the tab. "Up next" scrapes the sidebar of the current watch page without navigating.

## Message protocol

Phone → extension: `{ "type": "cmd", "action": "...", "value": ... }`

| action | value | effect |
|---|---|---|
| `toggle`, `play`, `pause` | – | play/pause |
| `seek` | seconds (±) | relative seek |
| `seekTo` | seconds | absolute seek |
| `volume` | 0..1 | set volume (unmutes) |
| `mute` | – | toggle mute |
| `rate` | 0.25..2 | playback speed |
| `next`, `prev` | – | next / previous video |
| `captions`, `theater`, `fullscreen`, `like` | – | toggle |
| `skipAd` | – | click YouTube's "Skip" button |
| `replay`, `autoplay` | – | restart the video / toggle YouTube's autoplay |
| `goLive` | – | jump to the live edge of a stream |
| `sleep` | minutes (0 = off) | pause playback after N minutes (runs in the extension) |
| `search` | query | navigate to results, then send `results` |
| `home`, `subscriptions`, `live`, `related` | – | send `results` for that list (`live` = YouTube's Live destination) |

Unprompted, the extension also sends `results` with kind `related` on every video change and kind `endscreen` when a video ends.
| `open` | youtube.com URL | open a video |
| `sync` | – | resend current state |

Extension → phone: `{ "type": "state", ... }` (title, channel, thumb, currentTime, duration, paused, volume, muted, rate, live, atLiveEdge, ended, autoplay, fullscreen, captions, liked, ad, canSkip, sleepUntil), `{ "type": "results", "kind", "items": [{ title, url, thumb, channel, meta, duration, live, viewers, autoplayNext? }] }`, `{ "type": "notice", "text" }`.

## Tests

```bash
pnpm test    # relay: rooms, tokens, forwarding both ways, host reconnect, ping/pong, static + health
pnpm e2e     # headless Chromium: loads the real extension, fakes youtube.com, drives the phone page:
             # popup QR → phone → controls → fullscreen → sleep → up next → end screen → live → search → pick → new code
```

The e2e test needs full Chromium (extensions don't run in the headless shell): `pnpm exec playwright install chromium` once, or set `CHROME_PATH` to a Chrome binary. Set `HEADED=1` to watch it.

## Known limits

- Web fullscreen is a CSS overlay + browser-window fullscreen; YouTube's own fullscreen UI (bigger control bar, end screens) only appears when the real API is allowed, i.e. right after a click on the page.
- YouTube changes its DOM regularly and currently ships two markups side by side (Polymer `ytd-*` components and camelCase "view model" classes such as `ytLockupMetadataViewModelTitle`). The scraper matches both with substring selectors, but "lists look empty" is the first thing to check after a YouTube redesign (`scrapeOnce` / `CONTAINERS` in `apps/extension/content.js`).
- Only `www.youtube.com` for now. YouTube Music (`music.youtube.com`) needs the same bridge with different selectors.

## License

MIT. `apps/extension/vendor/qrcode.js` is MIT, © Kazuhiko Arase.
