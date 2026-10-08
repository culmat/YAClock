/* clock-adaptive.js — PROD
 * Wraps YAClock with daylight/weather/moon adaptation and rare astronomical "surprises".
 * Depends on: clock.js (YAClock), d3 (already loaded by clock.html).
 *
 * PROD RULES (keep this file honest — no cheating, the comet comes when it comes):
 *   - never read location.hash, query params, or keyboard shortcuts
 *   - never touch localStorage beyond the two caches in STORAGE_KEYS
 *   - no simulation code lives here. The dev harness (dev/clock-adaptive-dev.js, loaded only by
 *     dev/clock.html) attaches through AdaptiveClock._dev; nothing in PROD calls it.
 */
(function () {
    'use strict';

    // ============================================================
    // CONSTANTS
    // ============================================================

    const FALLBACK_LOCATION = { lat: 47.5596, lon: 7.5886, tz: 'Europe/Zurich', source: 'fallback' };
    const NEUTRAL_WEATHER = { code: 0, cloudCover: 0.3, precip: 0, temp: 15, isDay: 1, isStale: true };

    const TTL = {
        geoIp: 6 * 3600 * 1000,
        weather: 15 * 60 * 1000,
        weatherStaleOk: 3 * 3600 * 1000
    };

    const TAU = {
        sky: 60000,
        inner: 300000,
        moonPhase: 600000,
        moonShape: 600000,
        dim: 30000,
        wobble: 6000,
        ink: 15000,
        weather: 20000
    };

    const STORAGE_KEYS = {
        location: 'yaclock.loc.v1',
        weather: 'yaclock.wx.v1'
    };

    // Body background stops: hue and saturation locked to #fcd6a1 = hsl(35, 94%, 81%).
    // Only lightness moves with sun altitude — the page keeps its warm parchment identity,
    // it just dims at night and brightens by day.
    const BG_STOPS = [
        { alt: -90,  hsl: [35, 94,  4] },
        { alt: -18,  hsl: [35, 94,  6] },
        { alt: -12,  hsl: [35, 94, 14] },
        { alt:  -6,  hsl: [35, 94, 30] },
        { alt: -0.5, hsl: [35, 94, 55] },
        { alt:   6,  hsl: [35, 94, 70] },
        { alt:  20,  hsl: [35, 94, 81] },
        { alt:  90,  hsl: [35, 94, 81] }
    ];

    // Ink: every stroke (splines, centre, moon rim) must read on the day parchment and on the
    // night-dark page alike. Warm near-black by day, warm parchment-light by night.
    const INK_DARK  = [35, 30, 8];
    const INK_LIGHT = [35, 60, 88];
    const INK_TO_LIGHT_BELOW = 38;   // page lightness thresholds with hysteresis, so dusk never flickers
    const INK_TO_DARK_ABOVE  = 50;

    // Inner-area stops: this IS the visible "sky" of the clock — a full daylight palette
    // tracking sun altitude (night blue → twilight orange → golden → sky blue). Weather
    // overlay is then blended on top so the inner area shows the felt sky.
    const INNER_STOPS = [
        { alt: -90,  hsl: [225, 35,  6] },
        { alt: -18,  hsl: [225, 35,  8] },
        { alt: -12,  hsl: [230, 40, 16] },
        { alt:  -6,  hsl: [235, 50, 28] },
        { alt: -0.5, hsl: [20,  60, 55] },
        { alt:   6,  hsl: [35,  85, 65] },
        { alt:  20,  hsl: [205, 70, 78] },
        { alt:  90,  hsl: [205, 70, 78] }
    ];

    // ============================================================
    // MUTABLE STATE
    // ============================================================

    // DEV SEAM — the only mutable hooks a dev harness may install (via AdaptiveClock._dev).
    // In PROD nothing ever assigns these: wall clock, real location, real weather.
    let timeSource = null;        // { now(): Date, speed(): number } or null = wall clock
    let locationOverride = null;  // { lat, lon, source } or null
    let weatherOverride = null;   // partial weather object or null

    const cache = {
        location: null,   // { lat, lon, tz, fetchedAt, source }
        weather: null,    // { code, cloudCover, precip, temp, isDay, sunrise, sunset, fetchedAt, lat, lon, isStale }
        weatherFetching: false,
        locationFetching: false
    };

    // Smoothed visual state (the eased "current"). Targets are recomputed each tick.
    const current = {
        sky:   [225, 35, 8],    // HSL
        inner: [0, 0, 70],      // HSL
        moonPhase: 0,           // continuous, never wraps abruptly
        moonRadiusScale: 1,
        dimming: 0,             // 0..1 extra dim on inner
        wobblePhase: 0,         // for thunder / golden-hour
        moonTint: null,         // HSL or null
        innerTintBoost: 0,      // golden hour saturation lift
        ink: INK_DARK.slice(),  // HSL of all strokes
        glyphs: { cloud: 0, rain: 0, snow: 0, fog: 0, bolt: 0 },   // eased layer opacities
        inkIsLight: false       // hysteresis state for the ink choice
    };

    let clock = null;
    let innerHandle = null;     // d3 selection of the curveBasisClosed path
    let moonGroup = null;       // d3 selection of <g class="moon-tip">
    let moonDark = null;        // full-disc dark backdrop (the unlit moon)
    let moonBright = null;      // bright illuminated region (SVG path)
    let moonOutline = null;     // subtle outline stroke
    let weatherGlyphs = null;   // { layers, setInk, setOpacities } from appendWeatherLayers
    let lastTickMs = 0;
    let firstPaint = true;

    // ============================================================
    // TIME (the seam)
    // ============================================================

    function getNow() {
        const wall = Date.now();
        return {
            wallTime: new Date(wall),
            simTime: timeSource ? timeSource.now() : new Date(wall),
            simSpeed: timeSource ? timeSource.speed() : 1,
            isSim: !!timeSource
        };
    }

    // ============================================================
    // HSL UTILS (linear interpolation in HSL with shortest-arc hue)
    // ============================================================

    function lerpHue(a, b, t) {
        let d = b - a;
        if (d > 180) d -= 360;
        else if (d < -180) d += 360;
        let h = a + d * t;
        if (h < 0) h += 360;
        if (h >= 360) h -= 360;
        return h;
    }

    function lerpHsl(a, b, t) {
        return [
            lerpHue(a[0], b[0], t),
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t
        ];
    }

    function fmtHsl(hsl) {
        return 'hsl(' + hsl[0].toFixed(1) + ',' + hsl[1].toFixed(1) + '%,' + hsl[2].toFixed(1) + '%)';
    }

    function lookupStops(stops, x) {
        if (x <= stops[0].alt) return stops[0].hsl.slice();
        for (let i = 1; i < stops.length; i++) {
            if (x <= stops[i].alt) {
                const a = stops[i-1], b = stops[i];
                const t = (x - a.alt) / (b.alt - a.alt);
                return lerpHsl(a.hsl, b.hsl, t);
            }
        }
        return stops[stops.length - 1].hsl.slice();
    }

    // ============================================================
    // SMOOTHING (exponential ease, framerate-independent)
    // ============================================================

    function easeScalar(cur, target, dtMs, tauMs, simSpeed) {
        const tauEff = Math.max(tauMs / Math.max(simSpeed, 1), 80);
        const alpha = 1 - Math.exp(-dtMs / tauEff);
        return cur + (target - cur) * alpha;
    }

    function easeHsl(cur, target, dtMs, tauMs, simSpeed) {
        const tauEff = Math.max(tauMs / Math.max(simSpeed, 1), 80);
        const alpha = 1 - Math.exp(-dtMs / tauEff);
        return lerpHsl(cur, target, alpha);
    }

    // ============================================================
    // ASTRO MATH (NOAA / Meeus simplified)
    // ============================================================

    const RAD = Math.PI / 180;
    const DEG = 180 / Math.PI;

    function julianDay(date) {
        return date.getTime() / 86400000 + 2440587.5;
    }

    // Returns { altitudeDeg, azimuthDeg }
    function sunPosition(date, lat, lon) {
        const jd = julianDay(date);
        const n = jd - 2451545.0;
        const L = (280.460 + 0.9856474 * n) % 360;
        const g = (357.528 + 0.9856003 * n) % 360;
        const lambda = (L + 1.915 * Math.sin(g * RAD) + 0.020 * Math.sin(2 * g * RAD)) % 360;
        const epsilon = 23.439 - 0.0000004 * n;
        const alpha = Math.atan2(Math.cos(epsilon * RAD) * Math.sin(lambda * RAD), Math.cos(lambda * RAD)) * DEG;
        const delta = Math.asin(Math.sin(epsilon * RAD) * Math.sin(lambda * RAD)) * DEG;

        // Greenwich Mean Sidereal Time
        const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
        // Local Sidereal Time
        const lst = (gmst * 15 + lon) % 360;
        const ha = ((lst - alpha) + 540) % 360 - 180;

        const latR = lat * RAD;
        const decR = delta * RAD;
        const haR = ha * RAD;

        const sinAlt = Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
        const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
        const az = Math.atan2(-Math.sin(haR), Math.tan(decR) * Math.cos(latR) - Math.sin(latR) * Math.cos(haR)) * DEG;

        return { altitudeDeg: alt, azimuthDeg: (az + 360) % 360 };
    }

    // Reference new moon: 2000-01-06 18:14 UTC
    const REF_NEW_MOON_JD = 2451550.26;
    const SYNODIC = 29.53058867;
    const ANOMALISTIC = 27.55454989;

    function moonPhase(date) {
        const jd = julianDay(date);
        let p = ((jd - REF_NEW_MOON_JD) / SYNODIC) % 1;
        if (p < 0) p += 1;
        return p; // 0..1
    }

    function moonIllumination(phase) {
        return (1 - Math.cos(2 * Math.PI * phase)) / 2;
    }

    function moonDistanceFactor(date) {
        // Approximate: anomalistic cycle. 0 = perigee, 0.5 = apogee.
        const jd = julianDay(date);
        const refPerigee = 2451534.6917; // 1999-12-22 ~ perigee
        let a = ((jd - refPerigee) / ANOMALISTIC) % 1;
        if (a < 0) a += 1;
        // Distance factor: 0.93 at perigee, 1.07 at apogee. cos shape.
        return 1.0 - 0.07 * Math.cos(2 * Math.PI * a);
    }

    // Meeus-style solstice/equinox approximations (good to a few minutes for 2000-2100).
    function solsticeEquinox(year) {
        const Y = (year - 2000) / 1000;
        const Y2 = Y*Y, Y3 = Y2*Y, Y4 = Y3*Y;
        return {
            marEquinox:  jdeToDate(2451623.80984 + 365242.37404*Y + 0.05169*Y2 - 0.00411*Y3 - 0.00057*Y4),
            junSolstice: jdeToDate(2451716.56767 + 365241.62603*Y + 0.00325*Y2 + 0.00888*Y3 - 0.00030*Y4),
            sepEquinox:  jdeToDate(2451810.21715 + 365242.01767*Y - 0.11575*Y2 + 0.00337*Y3 + 0.00078*Y4),
            decSolstice: jdeToDate(2451900.05952 + 365242.74049*Y - 0.06223*Y2 - 0.00823*Y3 + 0.00032*Y4)
        };
    }

    function jdeToDate(jde) {
        return new Date((jde - 2440587.5) * 86400000);
    }

    // ============================================================
    // ECLIPSES (NASA-published, 2026-2035; magnitudes & lat bands approximate)
    // Visible lat band is where eclipse is partially observable; null = anywhere it's night (lunar).
    // ============================================================

    const ECLIPSES = [
        // Solar
        { kind: 'solar', peakUTC: '2026-02-17T12:13Z', magnitude: 0.96, visibleLatBand: [-90, -30] },
        { kind: 'solar', peakUTC: '2026-08-12T17:46Z', magnitude: 1.04, visibleLatBand: [30, 90] },
        { kind: 'solar', peakUTC: '2027-02-06T16:00Z', magnitude: 0.93, visibleLatBand: [-60, 10] },
        { kind: 'solar', peakUTC: '2027-08-02T10:07Z', magnitude: 1.08, visibleLatBand: [10, 60] },
        { kind: 'solar', peakUTC: '2028-01-26T15:08Z', magnitude: 0.92, visibleLatBand: [-30, 50] },
        { kind: 'solar', peakUTC: '2028-07-22T02:56Z', magnitude: 1.06, visibleLatBand: [-60, 0] },
        { kind: 'solar', peakUTC: '2029-01-14T17:13Z', magnitude: 0.87, visibleLatBand: [20, 80] },
        { kind: 'solar', peakUTC: '2029-06-12T03:54Z', magnitude: 0.46, visibleLatBand: [60, 90] },
        { kind: 'solar', peakUTC: '2029-07-11T15:36Z', magnitude: 0.23, visibleLatBand: [-90, -50] },
        { kind: 'solar', peakUTC: '2029-12-05T15:03Z', magnitude: 0.89, visibleLatBand: [-90, -40] },
        { kind: 'solar', peakUTC: '2030-06-01T06:29Z', magnitude: 0.94, visibleLatBand: [20, 75] },
        { kind: 'solar', peakUTC: '2030-11-25T06:50Z', magnitude: 1.04, visibleLatBand: [-60, 10] },
        { kind: 'solar', peakUTC: '2031-05-21T07:15Z', magnitude: 0.96, visibleLatBand: [-20, 40] },
        { kind: 'solar', peakUTC: '2031-11-14T21:07Z', magnitude: 1.01, visibleLatBand: [-30, 30] },
        { kind: 'solar', peakUTC: '2032-05-09T13:25Z', magnitude: 0.95, visibleLatBand: [-10, 50] },
        { kind: 'solar', peakUTC: '2032-11-03T05:33Z', magnitude: 0.85, visibleLatBand: [40, 90] },
        { kind: 'solar', peakUTC: '2033-03-30T18:01Z', magnitude: 1.06, visibleLatBand: [50, 90] },
        { kind: 'solar', peakUTC: '2033-09-23T13:53Z', magnitude: 0.69, visibleLatBand: [-90, -40] },
        { kind: 'solar', peakUTC: '2034-03-20T10:18Z', magnitude: 1.05, visibleLatBand: [0, 50] },
        { kind: 'solar', peakUTC: '2034-09-12T16:18Z', magnitude: 0.97, visibleLatBand: [-30, 30] },
        { kind: 'solar', peakUTC: '2035-03-09T23:05Z', magnitude: 0.99, visibleLatBand: [-60, 0] },
        { kind: 'solar', peakUTC: '2035-09-02T01:55Z', magnitude: 1.03, visibleLatBand: [20, 60] },
        // Lunar
        { kind: 'lunar', peakUTC: '2026-03-03T11:33Z', magnitude: 1.15, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2026-08-28T04:12Z', magnitude: 0.93, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2028-01-12T04:13Z', magnitude: 0.07, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2028-07-06T18:19Z', magnitude: 0.39, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2028-12-31T16:52Z', magnitude: 1.25, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2029-06-26T03:22Z', magnitude: 1.84, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2029-12-20T22:42Z', magnitude: 1.12, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2030-06-15T18:33Z', magnitude: 0.50, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2032-04-25T15:14Z', magnitude: 1.19, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2032-10-18T19:02Z', magnitude: 1.13, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2033-04-14T19:13Z', magnitude: 1.10, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2033-10-08T10:55Z', magnitude: 1.35, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2034-04-03T19:06Z', magnitude: 0.74, visibleLatBand: null },
        { kind: 'lunar', peakUTC: '2034-09-28T02:46Z', magnitude: 0.41, visibleLatBand: null }
    ];

    function eclipsePeak(e) { return new Date(e.peakUTC).getTime(); }

    function findActiveEclipse(now, lat, kind, windowMs) {
        const t = now.getTime();
        for (const e of ECLIPSES) {
            if (e.kind !== kind) continue;
            const p = eclipsePeak(e);
            if (Math.abs(t - p) > windowMs) continue;
            if (e.visibleLatBand && (lat < e.visibleLatBand[0] || lat > e.visibleLatBand[1])) continue;
            // Eased intensity: 1.0 at peak, 0 at window edge.
            const intensity = 1 - Math.abs(t - p) / windowMs;
            return { eclipse: e, intensity };
        }
        return null;
    }

    function findNextEclipse(now, kind) {
        const t = now.getTime();
        let best = null;
        for (const e of ECLIPSES) {
            if (e.kind !== kind) continue;
            const p = eclipsePeak(e);
            if (p > t && (!best || p < eclipsePeak(best))) best = e;
        }
        return best;
    }

    // ============================================================
    // WEATHER → INNER COLOR
    // ============================================================

    function weatherTint(code) {
        if (code === 0) return [45, 80, 80];
        if (code >= 1 && code <= 3) return [0, 0, 85];
        if (code === 45 || code === 48) return [40, 10, 80];
        if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return [210, 40, 60];
        if ((code >= 71 && code <= 77) || code === 85 || code === 86) return [210, 15, 95];
        if (code >= 95) return [260, 30, 35];
        return [0, 0, 85];
    }

    function weatherStrength(code, cloudCover) {
        if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 0.6;
        if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 0.6;
        if (code === 45 || code === 48) return 0.5;
        if (code >= 95) return 0.55;
        return Math.min(0.5, 0.35 * cloudCover + 0.05);
    }

    // ============================================================
    // ENVIRONMENT COMPUTATION
    // ============================================================

    function computeEnvironment(nowState, loc, weather) {
        const sun = sunPosition(nowState.simTime, loc.lat, loc.lon);
        const phase = moonPhase(nowState.simTime);
        const distF = moonDistanceFactor(nowState.simTime);

        // Golden hour intensity: peaks within ~6° of horizon on either side.
        const absAlt = Math.abs(sun.altitudeDeg);
        const goldenIntensity = absAlt < 6 ? Math.max(0, 1 - absAlt / 6) : 0;

        const env = {
            now: nowState,
            location: loc,
            sun: { altitudeDeg: sun.altitudeDeg, azimuthDeg: sun.azimuthDeg, isUp: sun.altitudeDeg > -0.83 },
            goldenIntensity,
            moon: {
                phase,
                illumination: moonIllumination(phase),
                waxing: phase < 0.5,
                distanceFactor: distF
            },
            weather,
            modifiers: {
                innerHueShift: 0,
                innerSatBoost: 0,
                innerLightBoost: 0,
                wobbleAmp: 0,
                wobbleHz: 0,
                moonTint: null,
                moonRadiusScale: 1,
                dimming: 0,
                outlineThickenBoost: 0
            },
            surprises: []
        };

        // Run surprise detectors
        for (const det of detectors) {
            const mod = det(env);
            if (mod) {
                mod.apply(env);
                env.surprises.push(mod.id);
            }
        }
        return env;
    }

    // ============================================================
    // SURPRISE DETECTORS
    // ============================================================

    const detectors = [
        function goldenHourBoost(env) {
            if (env.goldenIntensity <= 0.01) return null;
            return {
                id: 'goldenHour',
                apply: (e) => {
                    e.modifiers.innerSatBoost += 0.15 * e.goldenIntensity;
                    e.modifiers.innerLightBoost += 0.03 * e.goldenIntensity;
                    e.modifiers.wobbleAmp = Math.max(e.modifiers.wobbleAmp, 0.025 * e.goldenIntensity);
                    e.modifiers.wobbleHz = 1 / 6;
                }
            };
        },

        function solsticeEquinoxMarker(env) {
            const y = env.now.simTime.getUTCFullYear();
            const ev = solsticeEquinox(y);
            const t = env.now.simTime.getTime();
            const dayMs = 86400000;
            for (const key of ['marEquinox','junSolstice','sepEquinox','decSolstice']) {
                const peak = ev[key].getTime();
                const diff = Math.abs(t - peak);
                if (diff < dayMs) {
                    const intensity = 1 - diff / dayMs;
                    return {
                        id: 'solstice-' + key,
                        apply: (e) => {
                            if (key === 'junSolstice') e.modifiers.innerHueShift += 5 * intensity;
                            if (key === 'decSolstice') e.modifiers.innerHueShift -= 5 * intensity;
                            if (key === 'marEquinox' || key === 'sepEquinox') {
                                e.modifiers.innerLightBoost += 0.02 * intensity;
                            }
                            e.modifiers.outlineThickenBoost = Math.max(
                                e.modifiers.outlineThickenBoost, 0.5 * intensity);
                        }
                    };
                }
            }
            return null;
        },

        function supermoonScale(env) {
            if (env.moon.illumination < 0.95) return null;
            if (env.moon.distanceFactor > 0.96) return null;
            const closeness = (0.96 - env.moon.distanceFactor) / 0.04;
            const scale = 1 + 0.15 * Math.min(1, Math.max(0, closeness));
            return {
                id: 'supermoon',
                apply: (e) => { e.modifiers.moonRadiusScale = Math.max(e.modifiers.moonRadiusScale, scale); }
            };
        },

        function harvestMoonTint(env) {
            if (env.moon.illumination < 0.95) return null;
            const y = env.now.simTime.getUTCFullYear();
            const sepEq = solsticeEquinox(y).sepEquinox.getTime();
            const diff = Math.abs(env.now.simTime.getTime() - sepEq);
            if (diff > 15 * 86400000) return null;
            // Pick the full moon nearest equinox: any time within 15 days that's nearly full qualifies.
            return {
                id: 'harvestMoon',
                apply: (e) => { e.modifiers.moonTint = [25, 70, 65]; }
            };
        },

        function blueMoonTint(env) {
            if (env.moon.illumination < 0.95) return null;
            // Two full moons in same calendar month → second one is "blue".
            const d = env.now.simTime;
            const month = d.getUTCMonth(), year = d.getUTCFullYear();
            // Scan back 35 days for a previous full moon in same month.
            for (let back = 20; back <= 35; back++) {
                const past = new Date(d.getTime() - back * 86400000);
                if (past.getUTCMonth() !== month || past.getUTCFullYear() !== year) break;
                if (moonIllumination(moonPhase(past)) > 0.95) {
                    return {
                        id: 'blueMoon',
                        apply: (e) => {
                            // Blend with harvest if both
                            const t = e.modifiers.moonTint;
                            e.modifiers.moonTint = t ? lerpHsl(t, [220, 40, 70], 0.5) : [220, 40, 70];
                        }
                    };
                }
            }
            return null;
        },

        function solarEclipseDimming(env) {
            if (!env.sun.isUp) return null;
            const hit = findActiveEclipse(env.now.simTime, env.location.lat, 'solar', 90 * 60 * 1000);
            if (!hit) return null;
            const mag = Math.min(1, hit.eclipse.magnitude);
            return {
                id: 'solarEclipse',
                apply: (e) => { e.modifiers.dimming = Math.max(e.modifiers.dimming, 0.4 * mag * hit.intensity); }
            };
        },

        function lunarEclipseTint(env) {
            if (env.sun.isUp) return null;
            const hit = findActiveEclipse(env.now.simTime, env.location.lat, 'lunar', 120 * 60 * 1000);
            if (!hit) return null;
            return {
                id: 'lunarEclipse',
                apply: (e) => {
                    const t = e.modifiers.moonTint;
                    const blood = [15, 60, 45];
                    e.modifiers.moonTint = t ? lerpHsl(t, blood, hit.intensity) : blood;
                }
            };
        }
    ];

    // ============================================================
    // WEATHER GLYPHS — thin line-art inside the sky window
    // Clouds, rain, snow, fog and a lightning bolt, drawn in the current ink and clipped to the
    // closed spline. Opacities come from the WMO code, cloud cover and precipitation.
    // ============================================================

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const E = 400;   // YAClock viewBox edge
    function svgEl(name, attrs, parent) {
        const n = document.createElementNS(SVG_NS, name);
        for (const k in attrs) n.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(n);
        return n;
    }
    const CLOUD_D = 'M -30 10 C -42 10 -42 -8 -30 -8 C -30 -24 -8 -28 -2 -16 C 6 -28 30 -24 28 -8 C 40 -8 40 10 28 10 Z';
    const BOLT_D  = 'M 4 -16 L -6 2 L 1 2 L -3 16 L 8 -3 L 1 -3 Z';
    const CLOUDS  = [   // a loose cluster around the centre; the clip decides what shows
        { x: 168, y: 162, s: 1.0 }, { x: 242, y: 214, s: 0.75 }, { x: 176, y: 246, s: 0.6 },
        { x: 252, y: 152, s: 0.5 }, { x: 206, y: 198, s: 0.42 }
    ];
    const LINE = { stroke: 'currentColor', 'stroke-linecap': 'round' };
    function asterisk(parent, cx, cy, r) {
        for (const a of [0, 60, 120]) {
            const dx = Math.cos(a * RAD) * r, dy = Math.sin(a * RAD) * r;
            svgEl('line', Object.assign({ x1: cx - dx, y1: cy - dy, x2: cx + dx, y2: cy + dy, 'stroke-width': 0.7 }, LINE), parent);
        }
    }

    // Appends patterns, a clip on the closed path and the glyph layers to an <svg> element.
    // `after`: the element to insert the glyph group behind (keeps the open spline and moon on top).
    function appendWeatherLayers(svgNode, innerPathId, prefix, after) {
        const defs = svgEl('defs', {}, svgNode);
        const clip = svgEl('clipPath', { id: prefix + '-clip' }, defs);
        svgEl('use', { href: '#' + innerPathId }, clip);
        const patterns = [];
        const rain = svgEl('pattern', { id: prefix + '-rain', patternUnits: 'userSpaceOnUse', width: 14, height: 16, patternTransform: 'rotate(14)' }, defs);
        svgEl('line', Object.assign({ x1: 3, y1: 1, x2: 3, y2: 8, 'stroke-width': 0.9 }, LINE), rain);
        svgEl('line', Object.assign({ x1: 10, y1: 8, x2: 10, y2: 15, 'stroke-width': 0.9 }, LINE), rain);
        const snow = svgEl('pattern', { id: prefix + '-snow', patternUnits: 'userSpaceOnUse', width: 22, height: 22 }, defs);
        asterisk(snow, 6, 6, 2.3); asterisk(snow, 17, 15, 1.7);
        const fog = svgEl('pattern', { id: prefix + '-fog', patternUnits: 'userSpaceOnUse', width: 46, height: 11 }, defs);
        svgEl('line', Object.assign({ x1: 2, y1: 5.5, x2: 30, y2: 5.5, 'stroke-width': 0.8 }, LINE), fog);
        patterns.push(rain, snow, fog);

        const g = svgEl('g', { class: 'weather-glyphs', 'clip-path': 'url(#' + prefix + '-clip)', 'pointer-events': 'none' });
        if (after && after.parentNode) after.parentNode.insertBefore(g, after.nextSibling); else svgNode.appendChild(g);
        const full = { x: 0, y: 0, width: E, height: E, opacity: 0 };
        const layers = {};
        layers.fog  = svgEl('rect', Object.assign({ id: prefix + '-layer-fog',  fill: 'url(#' + prefix + '-fog)' }, full), g);
        layers.cloud = svgEl('g', { id: prefix + '-layer-cloud', opacity: 0, fill: 'none', stroke: 'currentColor', 'stroke-width': 1, 'stroke-linejoin': 'round' }, g);
        CLOUDS.forEach(c => svgEl('path', { d: CLOUD_D, transform: 'translate(' + c.x + ',' + c.y + ') scale(' + c.s + ')' }, layers.cloud));
        layers.rain = svgEl('rect', Object.assign({ id: prefix + '-layer-rain', fill: 'url(#' + prefix + '-rain)' }, full), g);
        layers.snow = svgEl('rect', Object.assign({ id: prefix + '-layer-snow', fill: 'url(#' + prefix + '-snow)' }, full), g);
        layers.bolt = svgEl('path', { id: prefix + '-layer-bolt', d: BOLT_D, transform: 'translate(214,190) scale(1.15)', opacity: 0,
            fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }, g);
        return {
            layers,
            // Anchor the cloud cluster and the bolt where the window actually is (its centroid);
            // `sel` is an optional d3 transition factory for a smooth move with the hands.
            setAnchor(cx, cy, sel) {
                const cloudT = 'translate(' + (cx - E / 2) + ',' + (cy - E / 2) + ')';
                const boltT  = 'translate(' + cx + ',' + cy + ') scale(1.15)';
                if (sel) { sel(layers.cloud).attr('transform', cloudT); sel(layers.bolt).attr('transform', boltT); }
                else { layers.cloud.setAttribute('transform', cloudT); layers.bolt.setAttribute('transform', boltT); }
            },
            setInk(ink) { g.setAttribute('color', ink); patterns.forEach(p => p.setAttribute('color', ink)); },
            setOpacities(o) { for (const k in layers) layers[k].setAttribute('opacity', (o[k] || 0).toFixed(3)); }
        };
    }

    // Target opacity per layer for a weather object { code, cloudCover, precip }.
    function weatherLayerTargets(w) {
        const c = w.code || 0, cc = w.cloudCover || 0, p = w.precip || 0;
        const t = { cloud: 0, rain: 0, snow: 0, fog: 0, bolt: 0 };
        t.cloud = Math.min(1, Math.max(0, (cc - 0.15) / 0.7)) * 0.55;
        if (c === 45 || c === 48) { t.fog = 0.5; t.cloud = Math.min(t.cloud, 0.2); }
        const drizzle = c >= 51 && c <= 57;
        const rain = (c >= 61 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
        const snow = (c >= 71 && c <= 77) || c === 85 || c === 86;
        const strength = Math.min(1, p / 4);          // 4 mm/h and up reads as full
        if (drizzle) t.rain = 0.22;
        if (rain)    t.rain = 0.35 + 0.25 * strength;
        if (snow)    t.snow = 0.45 + 0.3 * strength;
        if (!rain && !drizzle && !snow && p > 0) t.rain = 0.2 + 0.3 * strength;   // code says dry, sensor says wet
        if (c >= 95) t.bolt = 0.4;
        return t;
    }

    // ============================================================
    // VISUALS — compute target colors from env, ease, write to DOM
    // ============================================================

    // Body bg: fixed hue/sat (the original #fcd6a1 warm parchment), lightness varies with sun.
    function computeTargetSky(env) {
        return lookupStops(BG_STOPS, env.sun.altitudeDeg);
    }

    // Inner area: the visible "sky window". Daylight palette + weather overlay + modifiers.
    function computeTargetInner(env) {
        const base = lookupStops(INNER_STOPS, env.sun.altitudeDeg);
        const w = env.weather;
        const tint = weatherTint(w.code);
        const strength = weatherStrength(w.code, w.cloudCover);
        let out = lerpHsl(base, tint, strength);
        // Precipitation darkens and desaturates the sky window a little (saturates at ~5 mm/h).
        const rain = Math.min(1, (w.precip || 0) / 5);
        out[1] = out[1] * (1 - 0.25 * rain);
        out[2] = out[2] - 10 * rain;
        out[0] = (out[0] + env.modifiers.innerHueShift + 360) % 360;
        out[1] = Math.max(0, Math.min(100, out[1] * (1 + env.modifiers.innerSatBoost)));
        out[2] = Math.max(0, Math.min(100, out[2] + env.modifiers.innerLightBoost * 100));
        out[2] = out[2] * (1 - env.modifiers.dimming);
        return out;
    }

    // Static rule (gallery, first paint): ink for a given page lightness.
    function inkForLightness(pageL) {
        return pageL < (INK_TO_LIGHT_BELOW + INK_TO_DARK_ABOVE) / 2 ? INK_LIGHT : INK_DARK;
    }

    // Live rule: same thresholds but with hysteresis on the displayed page lightness.
    function computeTargetInk(pageL) {
        if (current.inkIsLight ? pageL > INK_TO_DARK_ABOVE : pageL < INK_TO_LIGHT_BELOW) current.inkIsLight = !current.inkIsLight;
        return current.inkIsLight ? INK_LIGHT : INK_DARK;
    }

    function computeMoonBrightHsl(env) {
        if (env.modifiers.moonTint) return env.modifiers.moonTint;
        // Warm white default — slightly warmer for warm sky, cooler for cool sky.
        return [40, 20, 92];
    }

    function applyVisuals(env, dtMs) {
        const speed = env.now.simSpeed;
        const targetSky   = computeTargetSky(env);
        const targetInner = computeTargetInner(env);
        const targetMoon  = computeMoonBrightHsl(env);

        if (firstPaint) {
            current.sky = targetSky.slice();
            current.inner = targetInner.slice();
            current.moonTint = targetMoon.slice();
            current.inkIsLight = inkForLightness(targetSky[2]) === INK_LIGHT;
            current.ink = (current.inkIsLight ? INK_LIGHT : INK_DARK).slice();
            current.glyphs = weatherLayerTargets(env.weather);
            current.moonRadiusScale = env.modifiers.moonRadiusScale;
            current.dimming = env.modifiers.dimming;
            current.moonPhase = env.moon.phase;
            firstPaint = false;
        } else {
            current.sky   = easeHsl(current.sky,   targetSky,   dtMs, TAU.sky,   speed);
            current.inner = easeHsl(current.inner, targetInner, dtMs, TAU.inner, speed);
            current.moonTint = easeHsl(current.moonTint, targetMoon, dtMs, TAU.inner, speed);
            current.moonRadiusScale = easeScalar(current.moonRadiusScale, env.modifiers.moonRadiusScale, dtMs, TAU.inner, speed);
            current.dimming = easeScalar(current.dimming, env.modifiers.dimming, dtMs, TAU.dim, speed);

            // Moon phase: shortest-arc lerp so 0.99 → 0.01 doesn't wind backwards.
            const dPhase = env.moon.phase - (current.moonPhase % 1);
            let targetPhase = current.moonPhase + (
                dPhase >  0.5 ? dPhase - 1 :
                dPhase < -0.5 ? dPhase + 1 : dPhase
            );
            current.moonPhase = easeScalar(current.moonPhase, targetPhase, dtMs, TAU.moonPhase, speed);
            current.ink = easeHsl(current.ink, computeTargetInk(current.sky[2]), dtMs, TAU.ink, speed);
            const tg = weatherLayerTargets(env.weather);
            for (const k in tg) current.glyphs[k] = easeScalar(current.glyphs[k], tg[k], dtMs, TAU.weather, speed);
        }

        // Wobble (golden hour / thunder): a small periodic lightness shift on inner.
        const wobble = env.modifiers.wobbleAmp > 0
            ? Math.sin(2 * Math.PI * env.modifiers.wobbleHz * (Date.now() / 1000)) * env.modifiers.wobbleAmp * 100
            : 0;

        // Write
        document.body.style.backgroundColor = fmtHsl(current.sky);
        if (innerHandle) {
            const inner = current.inner.slice();
            inner[2] = Math.max(0, Math.min(100, inner[2] + wobble));
            innerHandle.attr('fill', fmtHsl(inner));
        }
        const ink = fmtHsl(current.ink);
        for (const ct in clock.handles) clock.handles[ct].attr('stroke', ink);
        if (clock.centerCircle) clock.centerCircle.attr('stroke', ink).attr('fill', ink);
        if (moonOutline) moonOutline.attr('stroke', ink).attr('stroke-opacity', 0.5);
        if (weatherGlyphs) {
            const o = Object.assign({}, current.glyphs);
            // Lightning: faint bolt, with an occasional flash (about one tick in eight).
            if (o.bolt > 0.05 && Math.random() < 0.125) o.bolt = Math.min(1, o.bolt * 2.4);
            weatherGlyphs.setInk(ink);
            weatherGlyphs.setOpacities(o);
            const pts = [clock.center, clock.points.HOUR, clock.points.MINUTE, clock.points.SECOND];
            const cx = pts.reduce((a, p) => a + p[0], 0) / 4, cy = pts.reduce((a, p) => a + p[1], 0) / 4;
            weatherGlyphs.setAnchor(cx, cy, (node) => clock.transition(d3.select(node)));
        }
        updateMoon(env);
    }

    // ============================================================
    // MOON RENDERING (two-circle approach)
    // ============================================================

    const MOON_R = 8;

    function ensureMoonGroup() {
        if (moonGroup) return;
        moonGroup = clock.svg.append('g').attr('class', 'moon-tip');
        // Order back-to-front: dark disc (the unlit moon), bright crescent on top, outline last.
        moonDark = moonGroup.append('circle').attr('r', MOON_R)
            .attr('fill', 'hsl(225, 28%, 14%)');
        moonBright = moonGroup.append('path');
        moonOutline = moonGroup.append('circle').attr('r', MOON_R)
            .attr('fill', 'none').attr('stroke', 'rgba(0,0,0,0.35)').attr('stroke-width', 0.7);   // recoloured with the ink each tick
    }

    // Build the illuminated-region path with a proper elliptical terminator.
    // Bright region is bounded by one half of the moon outline + a half-ellipse
    // with horizontal semi-axis |cos(π·illum)|·r.
    // A minimum visible crescent width is enforced so near-new/near-full phases
    // still read as a shape rather than a featureless disc.
    const MIN_CRESCENT_PX = 1.2;
    function moonPath(r, phase) {
        const illum = moonIllumination(phase);
        if (illum >= 0.999) {
            return 'M ' + (-r) + ',0 A ' + r + ',' + r + ' 0 1 1 ' + r + ',0 A '
                + r + ',' + r + ' 0 1 1 ' + (-r) + ',0 Z';
        }
        const c = Math.cos(Math.PI * illum); // +1 at new → -1 at full
        let rx = Math.abs(c) * r;
        // Clamp terminator so the bright sliver is at least MIN_CRESCENT_PX wide at the equator.
        // The crescent width at y=0 is (r - rx) for crescent phases (c>0)
        // and (r - rx)+0 for gibbous (the dark sliver is r-rx wide), so clamp rx upper bound.
        if (rx > r - MIN_CRESCENT_PX) rx = r - MIN_CRESCENT_PX;
        const waxing = phase < 0.5;
        const outlineSweep = waxing ? 1 : 0;
        const terminatorSweep = waxing ? (c > 0 ? 0 : 1) : (c > 0 ? 1 : 0);
        return 'M 0,' + (-r) + ' A ' + r + ',' + r + ' 0 0 ' + outlineSweep + ' 0,' + r
            + ' A ' + rx + ',' + r + ' 0 0 ' + terminatorSweep + ' 0,' + (-r) + ' Z';
    }

    function updateMoon(env) {
        ensureMoonGroup();
        const p = clock.points && clock.points.SECOND ? clock.points.SECOND : clock.center;
        const r = MOON_R * current.moonRadiusScale;

        moonDark.attr('r', r);
        moonOutline.attr('r', r);

        // Track the second-hand tip with the same transition cadence as the spline.
        clock.transition(moonGroup).attr('transform', 'translate(' + p[0] + ',' + p[1] + ')');

        const phase = ((current.moonPhase % 1) + 1) % 1;
        moonBright.attr('d', moonPath(r, phase)).attr('fill', fmtHsl(current.moonTint));
    }

    // ============================================================
    // FETCHERS
    // ============================================================

    function loadCached(key) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function saveCached(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
    }

    async function fetchLocation() {
        if (cache.locationFetching) return;
        cache.locationFetching = true;
        const endpoints = [
            { url: 'https://ipapi.co/json/', parse: (j) => ({ lat: +j.latitude, lon: +j.longitude, tz: j.timezone }) },
            { url: 'https://ipwho.is/',       parse: (j) => ({ lat: +j.latitude, lon: +j.longitude, tz: j.timezone && j.timezone.id }) }
        ];
        for (const ep of endpoints) {
            try {
                const r = await fetch(ep.url, { cache: 'no-store' });
                if (!r.ok) continue;
                const j = await r.json();
                const loc = ep.parse(j);
                if (!isFinite(loc.lat) || !isFinite(loc.lon)) continue;
                loc.source = 'ip';
                loc.fetchedAt = Date.now();
                cache.location = loc;
                saveCached(STORAGE_KEYS.location, loc);
                cache.locationFetching = false;
                // New location → refetch weather if far from cached weather coords.
                if (cache.weather && distanceKm(loc, cache.weather) > 50) cache.weather = null;
                fetchWeather();
                return;
            } catch (e) {}
        }
        cache.locationFetching = false;
    }

    function distanceKm(a, b) {
        const dLat = (a.lat - b.lat) * 111;
        const dLon = (a.lon - b.lon) * 111 * Math.cos((a.lat + b.lat) / 2 * RAD);
        return Math.sqrt(dLat*dLat + dLon*dLon);
    }

    async function fetchWeather() {
        if (cache.weatherFetching) return;
        const loc = currentLocation();
        cache.weatherFetching = true;
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat
            + '&longitude=' + loc.lon
            + '&current=weather_code,cloud_cover,precipitation,temperature_2m,is_day'
            + '&daily=sunrise,sunset&timezone=auto';
        try {
            const r = await fetch(url, { cache: 'no-store' });
            if (r.ok) {
                const j = await r.json();
                const c = j.current || {};
                const w = {
                    code: c.weather_code || 0,
                    cloudCover: (c.cloud_cover || 0) / 100,
                    precip: c.precipitation || 0,
                    temp: c.temperature_2m,
                    isDay: c.is_day,
                    sunrise: j.daily && j.daily.sunrise && j.daily.sunrise[0],
                    sunset: j.daily && j.daily.sunset && j.daily.sunset[0],
                    fetchedAt: Date.now(),
                    lat: loc.lat,
                    lon: loc.lon,
                    isStale: false
                };
                cache.weather = w;
                saveCached(STORAGE_KEYS.weather, w);
            }
        } catch (e) {}
        cache.weatherFetching = false;
    }

    // ============================================================
    // CURRENT LOCATION / WEATHER (resolves overrides)
    // ============================================================

    function currentLocation() {
        if (locationOverride) return locationOverride;
        if (cache.location) return cache.location;
        return FALLBACK_LOCATION;
    }

    function currentWeather() {
        if (weatherOverride) {
            return Object.assign({}, NEUTRAL_WEATHER, cache.weather || {}, weatherOverride);
        }
        if (cache.weather) {
            const w = cache.weather;
            const age = Date.now() - (w.fetchedAt || 0);
            w.isStale = age > TTL.weatherStaleOk;
            return w;
        }
        return NEUTRAL_WEATHER;
    }

    // ============================================================
    // MAIN TICK + INIT
    // ============================================================

    function maybeRefetch() {
        const now = Date.now();
        if (!cache.location && !cache.locationFetching) {
            fetchLocation();
        } else if (cache.location && now - (cache.location.fetchedAt || 0) > TTL.geoIp && !cache.locationFetching) {
            fetchLocation();
        }
        const loc = currentLocation();
        if (!cache.weather && !cache.weatherFetching) {
            fetchWeather();
        } else if (cache.weather && now - (cache.weather.fetchedAt || 0) > TTL.weather && !cache.weatherFetching) {
            fetchWeather();
        } else if (cache.weather && distanceKm(loc, cache.weather) > 50 && !cache.weatherFetching) {
            fetchWeather();
        }
    }

    function tick() {
        const nowState = getNow();
        const loc = currentLocation();
        const weather = currentWeather();
        const env = computeEnvironment(nowState, loc, weather);

        const wallMs = Date.now();
        const dtMs = lastTickMs ? Math.min(5000, wallMs - lastTickMs) : 1000;
        lastTickMs = wallMs;

        applyVisuals(env, dtMs);
    }

    function init(selector) {
        // 1. Load cached location/weather (non-blocking; defaults if absent)
        cache.location = loadCached(STORAGE_KEYS.location) || null;
        cache.weather = loadCached(STORAGE_KEYS.weather) || null;

        // 2. Construct YAClock. Its constructor calls start() → tick() → setTime() → onSetTime()
        //    BEFORE `clock = new YAClock(...)` returns, so capture `this` on that first call.
        clock = new YAClock(selector, {
            curveTypes: ['curveBasisClosed', 'curveNatural'],
            marks: { SECOND: { attr: { opacity: 0 } } },
            dials: { SECOND: function () {} },
            onSetTime: function () {
                if (!clock) clock = this;
                tick();
            }
        });

        // 3. Wire references to the SVG elements we mutate, then repaint
        innerHandle = clock.handles['curveBasisClosed'];
        innerHandle.attr('id', 'yaclock-inner');
        weatherGlyphs = appendWeatherLayers(clock.svg.node(), 'yaclock-inner', 'yaclock-wx', innerHandle.node());
        ensureMoonGroup();
        tick();

        // 4. Kick off fetchers (non-blocking) + periodic refetch checks
        maybeRefetch();
        setInterval(maybeRefetch, 60 * 1000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeRefetch(); });
    }

    // Hooks for the dev harness (dev/clock-adaptive-dev.js). PROD never calls any of these.
    // `internals` are pure functions and read access; the only mutators are the two setters.
    const devHooks = {
        setTimeSource: (ts) => { timeSource = ts || null; },
        setOverrides: (o) => {
            locationOverride = (o && o.location) || null;
            weatherOverride = (o && o.weather) || null;
        },
        getClock: () => clock,
        getNow,
        tick,
        snap: () => { firstPaint = true; },   // next tick jumps straight to target colours
        internals: {
            computeEnvironment, computeTargetSky, computeTargetInner, computeMoonBrightHsl, inkForLightness,
            appendWeatherLayers, weatherLayerTargets,
            moonPath, moonPhase, sunPosition, solsticeEquinox, findNextEclipse, eclipsePeak,
            currentLocation, currentWeather, fetchWeather, saveCached,
            cache, STORAGE_KEYS, NEUTRAL_WEATHER, fmtHsl
        }
    };

    window.AdaptiveClock = { init, _dev: devHooks };
})();
