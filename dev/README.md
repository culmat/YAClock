# Adaptive clock — dev harness

Everything in this folder exists to **test** the adaptive clock. Nothing here is loaded by the
production page. Keep it that way: PROD must not be steerable.

| Page | What it loads | Purpose |
|---|---|---|
| [`../clock.html`](../clock.html) | `clock.js`, `clock-adaptive.js` | **PROD.** Wall clock, real location, real weather. No hash, no shortcuts. |
| [`clock.html`](clock.html) | same + `clock-adaptive-dev.js`, cache-busted | **DEV.** Simulation, jump-to events, scenario gallery. |

## Run locally

Any static server from the repo root works. No build step.

```sh
cd YAClock
python3 -m http.server 8765
# PROD: http://localhost:8765/clock.html
# DEV:  http://localhost:8765/dev/clock.html
```

The dev page appends `?t=<timestamp>` to every script, so a plain reload picks up edits.
The prod page does not, so hard-reload (Cmd+Shift+R) after editing `clock-adaptive.js`.

Location and weather are fetched live (ipapi.co / ipwho.is, then api.open-meteo.com) and cached in
`localStorage` under `yaclock.loc.v1` and `yaclock.wx.v1`. Clear those two keys to force a refetch.
Without network the clock falls back to Basel and neutral weather.

## Dev controls

| Control | Effect |
|---|---|
| **Shift+S** | Toggle the SIM overlay. Turning it off returns to wall time and clears the hash. |
| **Shift+G** / **Esc** | Open / close the scenario gallery: 16 fixed states rendered as static SVGs. |
| datetime, speed | Sim time anchor and rate (`pause`, 1×, 60×, 3600×, 86400×). |
| cloud, precip, code | Weather override. `code` is a WMO weather code (0 clear … 95 thunder). |
| lat, lon | Location override. "use my location" writes browser geolocation into the cache instead. |
| ↑sun ↓sun | Jump to next sunrise / sunset at the current location. |
| ●moon ○moon | Jump to next full / new moon. |
| solst, equi | Jump to next solstice / equinox. |
| ☼ecl ☾ecl | Jump to the next solar / lunar eclipse in the built-in table (2026–2035). |

Sim state round-trips through the URL hash, so a scenario is a link:

```
dev/clock.html#sim=2026-08-12T17:46&speed=1&lat=64&lon=-22&weather=code:0,cloudCover:0.2
dev/clock.html#sim=2026-06-21T21:20&speed=60                       # golden hour, 1 min/s
dev/clock.html#sim=2026-03-03T11:33&lat=35&lon=-120                 # lunar eclipse, blood tint
```

`weather=` takes comma-separated `key:value` pairs from `{code, cloudCover (0–1), precip (mm), temp}`.

### Scenario gallery

Shift+G renders every entry of `GALLERY_SCENARIOS` in `clock-adaptive-dev.js` (midnight, dawn, rain,
thunderstorm, snow, golden hour, full moon, solstices, both eclipse kinds, …) side by side with the
sun altitude, moon illumination and the surprise detectors that fired. Add a scenario there when you
add a detector in prod. The gallery draws its own static SVG, so it shows target colours without easing.

## How dev attaches to prod

`clock-adaptive.js` exposes `window.AdaptiveClock = { init, _dev }`. The dev page calls
`AdaptiveClock.init(".square")` and then `AdaptiveClockDev.attach(AdaptiveClock._dev)`. The hooks are:

- `setTimeSource({ now(), speed() } | null)` — the only way to move the clock off wall time
- `setOverrides({ location, weather })` — the only way to fake location or weather
- `getClock()`, `getNow()`, `tick()` and `internals` — pure functions and caches for the gallery and jump search

The harness also swaps the YAClock instance's `tick` so the hands follow sim time. Prod never reads
`location.hash`, never registers key handlers, and never references `AdaptiveClockDev`.

## Headless smoke test

`smoke.mjs` serves the repo on a local port, opens both pages in headless Chromium and checks that
prod ignores `#sim=`, Shift+S and Shift+G, while dev honours the hash, jumps, opens the gallery with
16 cells and returns to wall time when sim is switched off. Screenshots go to `dev/.smoke/`.

```sh
npx -y playwright@1.58.1 install chromium            # once per machine
npx -y -p playwright@1.58.1 -c "node dev/smoke.mjs"  # from the repo root
```

Run it before committing anything that touches `clock-adaptive.js`.

## Testing with the shared browser (agents)

With the shared Playwright MCP running (see `shared-browser-mcp`), an agent can drive
`http://localhost:8765/dev/clock.html#…` directly, take screenshots and read the console, while you
watch the same browser window.
