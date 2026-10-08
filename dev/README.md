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

The overlay is a remote control for PROD's inputs: time, location and weather. Everything else
(colours, moon, surprises) is computed by the unchanged prod code from those three inputs. The
**state** block at the bottom shows what prod sees right now: sun altitude, moon illumination,
the effective weather and which surprise detectors fired.

| Control | Effect |
|---|---|
| **Shift+S** | Toggle the overlay. Turning it off returns to wall time, real place and live weather, and clears the hash. |
| **Shift+G** / **Esc** | Open / close the scenario gallery: 17 fixed states rendered as static SVGs. |
| time, **now** | Sim time. The field follows the clock while you are not editing it. **now** jumps back to wall-clock time. |
| step | Nudge sim time by −1 d, −1 h, +1 h, +1 d, +7 d. With snap mode this is the calm way to inspect states one by one. |
| speed | `paused`, `real time`, `1 min / s`, `1 hour / s`, `1 day / s`, `1 week / s`. Above real time the hands are driven at 4 Hz without transitions, so the clock flows like a time-lapse video instead of re-animating every second. |
| mode | **snap**: every change jumps straight to the final colours, the same thing the gallery shows. **ease**: colours drift in like PROD does (inner sky ~5 min, divided by speed). |
| weather, cloud, precip | Weather override: WMO code (0 clear … 95 thunderstorm), cloud cover, precipitation. While no override is active the controls track the live weather; touching one creates the override, **real weather** drops it again. Besides tinting the sky window, weather draws thin line-art glyphs inside it: cloud outlines scale with cloud cover, rain strokes / snow asterisks / fog hatching follow the code and get denser with precipitation, a thunderstorm adds a bolt that flashes now and then. |
| place | Smart input: a place name (geocoded via open-meteo), `47.56, 7.59`, `47.56N 7.59E` or `64°09'N 21°56'W`. Enter or **go**. Presets cover the astronomically interesting latitudes. **prod location** drops the override and shows what PROD itself uses: the IP-based lookup (ipapi / ipwho), Basel as fallback. **browser GPS** asks the browser for a precise position and installs it as a sim override; PROD never asks for geolocation and the dev harness never writes to PROD's caches. |
| ↑sun ↓sun | Jump to next sunrise / sunset at the current place. |
| ●moon ○moon | Jump to next full / new moon. |
| solst, equi | Jump to next solstice / equinox. |
| ☼ecl ☾ecl | Jump to the next solar / lunar eclipse in the built-in table (2026–2035). |

Sim state round-trips through the URL hash, so a scenario is a link:

```
dev/clock.html#sim=2026-08-12T17:46&speed=1&lat=64&lon=-22&weather=code:0,cloudCover:0.2
dev/clock.html#sim=2026-06-21T21:20&speed=60&ease=1                # golden hour easing in, 1 min/s
dev/clock.html#sim=2026-03-03T11:33&lat=35&lon=-120                 # lunar eclipse, blood tint
```

`weather=` takes comma-separated `key:value` pairs from `{code, cloudCover (0–1), precip (mm/h), temp}`.
`ease=1` selects ease mode; snap is the default.

### Scenario gallery

Shift+G renders every entry of `GALLERY_SCENARIOS` in `clock-adaptive-dev.js` (midnight, dawn, rain,
thunderstorm, snow, golden hour, full moon, solstices, both eclipse kinds, …) side by side with the
sun altitude, moon illumination and the surprise detectors that fired. Add a scenario there when you
add a detector in prod. The gallery draws its own static SVG, so it shows target colours without easing. It uses the same ink rule as prod: strokes are warm near-black on a light page and parchment-light on a dark one (prod adds hysteresis and a 15 s ease so dusk never flickers).

## How dev attaches to prod

`clock-adaptive.js` exposes `window.AdaptiveClock = { init, _dev }`. The dev page calls
`AdaptiveClock.init(".square")` and then `AdaptiveClockDev.attach(AdaptiveClock._dev)`. The hooks are:

- `setTimeSource({ now(), speed() } | null)` — the only way to move the clock off wall time
- `setOverrides({ location, weather })` — the only way to fake location or weather
- `snap()` — makes the next tick copy target colours instead of easing (used by snap mode)
- `getClock()`, `getNow()`, `tick()` and `internals` — pure functions and caches for the gallery and jump search

The harness also swaps the YAClock instance's `tick` so the hands follow sim time. Prod never reads
`location.hash`, never registers key handlers, and never references `AdaptiveClockDev`.

## Headless smoke test

`smoke.mjs` serves the repo on a local port, opens both pages in headless Chromium and checks that
prod ignores `#sim=`, Shift+S and Shift+G, while dev honours the hash, jumps, opens the gallery with
17 cells and returns to wall time when sim is switched off. Screenshots go to `dev/.smoke/`.

```sh
npx -y playwright@1.58.1 install chromium            # once per machine
npx -y -p playwright@1.58.1 -c "node dev/smoke.mjs"  # from the repo root
```

Run it before committing anything that touches `clock-adaptive.js`.

## Testing with the shared browser (agents)

With the shared Playwright MCP running (see `shared-browser-mcp`), an agent can drive
`http://localhost:8765/dev/clock.html#…` directly, take screenshots and read the console, while you
watch the same browser window.
