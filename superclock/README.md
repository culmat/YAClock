# SuperClock

A WebGL2-rendered, API-compatible reimplementation of [YAClock](../clock.js). Same `new YAClock(selector, options)` constructor, same options schema, every existing consumer hook still works — but rendered with extruded GPU ribbons, post-process bloom, sub-second smooth sweep, 3D tilt, astronomical sun/moon overlays, Web Audio chimes, and optional WebXR/AR mode.

## What it is

A *demo of what's possible* on the modern web. The original `clock.js` is 200 lines of approachable D3+SVG; SuperClock is roughly 1500 lines spread across a dozen modules and shaders. Pick whichever fits your taste.

## Run it

No build step. Serve the repo over any static HTTP server:

```sh
cd ..                          # to YAClock/
python3 -m http.server 8080
# then open http://localhost:8080/superclock/superclock.html
```

The fullscreen demo lives at [superclock.html](superclock.html). A multi-clock showcase mirroring the original [../index.html](../index.html) is at [index.html](index.html).

## Features

| Feature | How |
|---|---|
| GPU-rendered curves | Catmull-Rom sampling → triangle-strip ribbons → GLSL hand shader |
| Sub-second smooth sweep | `requestAnimationFrame` loop with wall-clock fractional anchoring; hand angles are continuous |
| 3D tilt | Pointer or DeviceOrientation input → tilt matrix uniform; critically-damped lerp toward target |
| Bloom | Threshold extract → 9-tap Gaussian ping-pong → ACES tonemap composite |
| Procedural face | Radial gradient + value noise + (when astronomical is on) a daylight band arc |
| Astronomical | Sun position / sunrise / sunset / moon phase via simplified Meeus equations (JS only, no WASM) |
| Web Audio chimes | Hour chime = additive sine bell with exponential envelope; optional second-tick noise burst. Autoplay-policy compliant via 🔔 gesture button. |
| WebXR / AR | Opt-in `Enter AR` button; uses `immersive-ar` session with the same renderer |
| Page Visibility | rAF loop pauses on tab hide, resumes + snaps on tab show |
| `prefers-reduced-motion` | Automatically falls back to discrete ticking + disables tilt |
| Capability fallback | If WebGL2 is unavailable, silently degrades to a pure-SVG render path |

## API compatibility

SuperClock exports `class YAClock`. Every constructor option, every public method, and every consumer hook from the original [clock.js](../clock.js) is preserved:

- `new YAClock(selector, options)` — identical signature
- `options.{ curveTypes, circleRadii, marks, dials, transitionDuration, drawCenter, decorate, background, onSetTime }` — identical defaults and semantics
- `this.{ svg, center, edgeLength, now, points, units, HOUR/MINUTE/SECOND, options }` — same shapes
- `this.{ cPoint, transition, transitionMark, animate, setTime, setSeconds, setMinutes, setHours, tick, start, stop, defaultDial }` — same signatures

`this.svg` is an `<svg>` overlay layered on top of the WebGL canvas (`pointer-events: none`), so legacy `decorate`, `drawCenter`, `background`, custom `dials.<UNIT> = function(...)`, and any `onSetTime` body that touches `this.svg` Just Works.

### New options (all opt-in, defaults preserve clock-like visuals)

```js
{
    renderer: "webgl2" | "svg",
    sweep: "smooth" | "tick",
    tilt:        { source: "pointer"|"gyro"|"none", magnitude: 0.18, smoothing: 0.18 },
    bloom:       { enabled: true, threshold: 0.55, intensity: 0.8 },
    astronomical:{ enabled: false, lat: null, lon: null },   // null = geolocation prompt
    audio:       { hourChime: true, secondTick: false, volume: 0.35 },
    xr:          { enabled: false },
    theme:       { bg, accent, dial, hand, handGlow }       // vec3 RGB 0..1 + scalar
}
```

## Loading

ES module:
```html
<script src="https://d3js.org/d3.v6.min.js"></script>
<script type="module">
    import { YAClock } from "./src/superclock.js";
    new YAClock("#clockDiv", { /* options */ });
</script>
```

Or as a global (no module wrapper on consumer side):
```html
<script src="https://d3js.org/d3.v6.min.js"></script>
<script type="module" src="./src/superclock.js"></script>
<script>
    // wait for module to register window.YAClock
    queueMicrotask(() => new YAClock("#clockDiv", { /* options */ }));
</script>
```

## Browser support

| Feature | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| WebGL2 | ✅ | ✅ | ✅ 15+ |
| HDR float16 framebuffer | ✅ | ✅ | ⚠️ falls back to RGBA8 if unavailable |
| WebXR `immersive-ar` | ✅ Android Chrome | ❌ | ❌ |
| DeviceOrientation tilt | ✅ | ✅ | ⚠️ requires `requestPermission` flow not implemented |
| Web Audio | ✅ all (after gesture) | | |

If WebGL2 is unavailable, SuperClock falls back to a pure-SVG mode and the user callbacks render unchanged.

## File layout

```
superclock/
├── README.md
├── superclock.html        -- fullscreen demo
├── index.html             -- multi-clock showcase
└── src/
    ├── superclock.js      -- class YAClock; orchestrator
    ├── renderer-webgl.js  -- WebGL2 pipeline (face → dial → hand → bloom → tonemap)
    ├── shaders.js         -- all GLSL ES 3.00 sources inline
    ├── compat.js          -- SVG overlay, marks, default-dial path collapse
    ├── tick.js            -- rAF loop + Page Visibility
    ├── tilt.js            -- input → 3D tilt matrix
    ├── astro.js           -- sun position, sunrise/sunset, moon phase
    ├── audio.js           -- WebAudio bell synthesis
    └── xr.js              -- WebXR session lifecycle
```
