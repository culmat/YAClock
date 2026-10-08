// SuperClock — WebGL2-rendered, API-compatible reimplementation of YAClock.
// Public surface (matches clock.js):
//   new YAClock(selector, options)
//   instance.{svg, center, edgeLength, now, points, units, HOUR/MINUTE/SECOND, options}
//   instance.{start, stop, tick, setTime, setSeconds/Minutes/Hours,
//             transitionMark, transition, animate, cPoint, defaultDial}

import { WebGLRenderer } from "./renderer-webgl.js";
import { SVGOverlay } from "./compat.js";
import { TickLoop } from "./tick.js";
import { Tilt } from "./tilt.js";
import { ClockAudio } from "./audio.js";
import { XRSession } from "./xr.js";
import { sunPosition, moonPhase, daylightArc } from "./astro.js";

const PREFERS_REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

function toObject(a) {
    if (a instanceof Array) {
        const ret = {};
        for (let i = 0; i < a.length; i++) ret[a[i]] = null;
        return ret;
    }
    return a;
}

// Keys that hold config bundles (deep-merged so users can override just one field).
// All other keys (marks, circleRadii, dials, curveTypes) shallow-replace, matching
// the original Object.assign semantics — e.g. `marks: {}` still means "no marks".
const DEEP_MERGE_KEYS = new Set(["tilt", "bloom", "astronomical", "audio", "xr", "theme"]);

function mergeOptions(defaults, opts) {
    const out = { ...defaults };
    if (!opts) return out;
    for (const k in opts) {
        if (DEEP_MERGE_KEYS.has(k) && opts[k] && defaults[k]
            && typeof opts[k] === "object" && !Array.isArray(opts[k])) {
            out[k] = { ...defaults[k], ...opts[k] };
        } else {
            out[k] = opts[k];
        }
    }
    return out;
}

export class YAClock {
    constructor(selector, options) {
        const d3 = window.d3;
        if (!d3) throw new Error("d3 must be loaded globally (D3 v6+)");

        const defaults = {
            curveTypes: ["curveNatural"],
            transitionDuration: 1000,
            circleRadii: { HOUR: 50, MINUTE: 100, SECOND: 150 },
            marks: { HOUR: { attr: { r: 3 } }, MINUTE: { attr: { r: 4 } }, SECOND: { attr: { r: 5 } } },
            dials: ["SECOND"],
            drawCenter: function () {
                return this.svg.append("circle")
                    .attr("cx", this.center[0]).attr("cy", this.center[1])
                    .attr("stroke", "rgba(255,255,255,0.85)")
                    .attr("fill", "rgba(255,255,255,0.85)")
                    .attr("r", this.edgeLength / 80);
            },
            decorate: function () {},
            background: function () {},
            onSetTime: function () {},
            // SuperClock-specific
            renderer: "webgl2",
            sweep: PREFERS_REDUCED_MOTION ? "tick" : "smooth",
            tilt: { source: PREFERS_REDUCED_MOTION ? "none" : "pointer", magnitude: 0.18, smoothing: 0.18 },
            bloom: { enabled: true, threshold: 0.55, intensity: 0.8 },
            astronomical: { enabled: false, lat: null, lon: null },
            audio: { hourChime: true, secondTick: false, volume: 0.35 },
            xr: { enabled: false },
            theme: {
                bg: [0.06, 0.07, 0.12],
                accent: [0.95, 0.78, 0.35],
                dial: [1.0, 1.0, 1.0],
                hand: [0.95, 0.95, 1.0],
                handGlow: 1.8
            }
        };

        this.options = mergeOptions(defaults, options);
        // toObject convert arrays (for back-compat: curveTypes/dials as array)
        this.options.curveTypes = toObject(this.options.curveTypes);
        this.options.dials = toObject(this.options.dials);
        this.options.marks = toObject(this.options.marks);
        this.options.onSetTime = this.options.onSetTime.bind(this);
        this.options.decorate = this.options.decorate.bind(this);
        this.options.background = this.options.background.bind(this);

        this.HOUR = 0; this.MINUTE = 1; this.SECOND = 2;
        this.edgeLength = 400;
        this.units = { HOUR: 12, MINUTE: 60, SECOND: 60 };
        this.center = [this.edgeLength / 2, this.edgeLength / 2];
        this.points = { HOUR: [...this.center], MINUTE: [...this.center], SECOND: [...this.center] };
        this.now = new Date();

        // Build DOM: wrapper -> canvas + SVG overlay
        this.host = d3.select(selector)
            .append("div")
            .attr("style", "display:inline-block;position:relative;width:100%;padding-bottom:100%;vertical-align:top;overflow:hidden;")
            .node();
        this.canvas = document.createElement("canvas");
        this.canvas.setAttribute("style", "position:absolute;inset:0;width:100%;height:100%;display:block;");
        this.host.appendChild(this.canvas);

        // WebGL or SVG fallback
        let rendererOk = this.options.renderer === "webgl2";
        if (rendererOk) {
            try { this.renderer = new WebGLRenderer(this.canvas, this.options); }
            catch (e) { console.warn("SuperClock: WebGL2 failed, falling back to SVG", e); rendererOk = false; }
        }
        this.svgMode = !rendererOk;
        if (this.svgMode) this.canvas.remove();

        // SVG overlay (for compat hooks; also used as primary in svg fallback mode)
        this.overlay = new SVGOverlay(d3, this.host, this.edgeLength);
        this.svg = this.overlay.svg;

        // Modules
        this.tilt = new Tilt(this.options.tilt);
        this.audio = new ClockAudio(this.options.audio);
        this.xr = this.renderer ? new XRSession(this.canvas, this.renderer) : null;

        // toValue helper (for marks.attr values that are functions)
        const toValue = (a) => (typeof a === "function") ? a.bind(this)() : a;
        this._toValue = toValue;

        // Run user background() first (drawn behind everything on the SVG overlay)
        this.options.background();

        // Initialize internal "handles" state (used only by transitionMark/setTime for points update)
        this.handles = {};
        for (const ct in this.options.curveTypes) this.handles[ct] = ct;

        // Marks on SVG overlay
        this.marks = {};
        for (const p in this.options.marks) {
            const cfg = this.options.marks[p];
            const m = this.overlay.addMark(p, this.center, cfg?.attr, toValue);
            this.marks[p] = m;
        }

        // User decorate + drawCenter, on overlay
        this.centerCircle = this.options.drawCenter.bind(this)();
        this.options.decorate();

        // Dials: WebGL instance buffer + (for clockDiv compat) SVG paths
        this._initDials(toValue);

        // Tilt
        if (this.renderer) this.tilt.mount(this.canvas);

        // Audio + XR mount
        this.audio.mount(this.host);
        if (this.options.xr?.enabled && this.xr) this.xr.mount(this.host);

        // ResizeObserver
        if (this.renderer && "ResizeObserver" in window) {
            this._ro = new ResizeObserver(() => this.renderer.resize());
            this._ro.observe(this.host);
        }

        // Astronomical: geolocation if enabled
        this._astro = { ready: false, lat: null, lon: null, lastDay: null };
        if (this.options.astronomical?.enabled) this._initAstro();

        // Tick state
        this._lastWhole = { s: -1, m: -1, h: -1 };
        this.loop = new TickLoop((dt, time) => this._frame(dt, time));

        // Initial tick + start. Seed _lastWhole so the first rAF frame doesn't
        // double-fire onSetTime / transitionMark for boundaries this.tick() already handled.
        this.tick();
        this._lastWhole = {
            s: this.now.getSeconds(),
            m: this.now.getMinutes(),
            h: this.now.getHours()
        };
        this.loop.mount();
    }

    _initDials(toValue) {
        for (const unit in this.options.dials) {
            const cfg = this.options.dials[unit];
            const units = this.units[unit];
            if (!units) continue;
            // SVG path overlay for back-compat (clockDiv default behavior)
            if (typeof cfg === "function") {
                const fn = cfg.bind(this);
                for (let value = 0; value < units; value++) fn(unit, value);
            } else if (this.svgMode) {
                const withDetails = typeof cfg === "boolean" ? cfg : true;
                this.overlay.drawDefaultDial(unit, units, this.center, this.options.circleRadii[unit], withDetails, (n, v, r, c) => this.cPoint(n, v, r, c));
            }
            // WebGL instanced dial: only for the default (non-function) case
            if (this.renderer && typeof cfg !== "function") {
                const withDetails = typeof cfg === "boolean" ? cfg : true;
                const bold = unit === "HOUR" ? 3 : 5;
                const r = this.options.circleRadii[unit];
                const rClip = r / (this.edgeLength / 2);
                const instances = [];
                for (let value = 0; value < units; value++) {
                    const isDetail = value % bold !== 0;
                    if (isDetail && !withDetails) continue;
                    const angle = (2 * Math.PI / units) * value;
                    instances.push({
                        angle,
                        radius: rClip,
                        length: (isDetail ? 0.012 : 0.022),
                        bold: !isDetail
                    });
                }
                this.renderer.setDial(unit, instances);
            }
        }
    }

    async _initAstro() {
        const o = this.options.astronomical;
        const apply = (lat, lon) => {
            this._astro.lat = lat; this._astro.lon = lon; this._astro.ready = true;
        };
        if (o.lat != null && o.lon != null) { apply(o.lat, o.lon); return; }
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(
            (pos) => apply(pos.coords.latitude, pos.coords.longitude),
            () => { /* silent fallback */ },
            { timeout: 5000 }
        );
    }

    // ----- API surface (compat with clock.js) -----

    cPoint(unit, value, radius, center) {
        const k = (2 * Math.PI) / unit;
        const a = k * (unit - value) + Math.PI;
        return [Math.sin(a) * radius + center[0], Math.cos(a) * radius + center[1]];
    }

    animate(it, x, y) { it.attr("cx", x).attr("cy", y); }

    transition(it) { return it.transition().duration(this.options.transitionDuration); }

    transitionMark(r, value) {
        const newPoint = this.cPoint(this.units[r], value, this.options.circleRadii[r], this.center);
        const oldPoint = this.points[r];
        this.points[r] = newPoint;
        if (oldPoint && oldPoint[0] === newPoint[0] && oldPoint[1] === newPoint[1]) return;
        if (this.marks[r]) this.overlay.transitionMark(r, newPoint, this.options.transitionDuration);
    }

    setSeconds(s) { this.now.setSeconds(s); this.transitionMark("SECOND", s); }
    setMinutes(m) { this.now.setMinutes(m); this.transitionMark("MINUTE", m); }
    setHours(h)   { this.now.setHours(h);   this.transitionMark("HOUR", h); }

    setTime(now) {
        this.now = now;
        this.setSeconds(now.getSeconds());
        this.setMinutes(now.getMinutes());
        this.setHours(now.getHours());
        this.options.onSetTime();
    }

    tick() { this.setTime(new Date()); }

    start() { this.loop.start(); }
    stop()  { this.loop.stop(); }

    defaultDial() { /* legacy stub; overlay path collapsing replaces it */ }

    // ----- per-frame rendering -----

    _frame(dt, time) {
        const now = new Date();
        const ms = now.getMilliseconds() / 1000;
        const s = now.getSeconds() + ms;
        const m = now.getMinutes() + s / 60;
        const h = (now.getHours() % 12) + m / 60;

        const wholeS = now.getSeconds();
        const wholeM = now.getMinutes();
        const wholeH = now.getHours();

        // Boundary events
        if (wholeS !== this._lastWhole.s) {
            this._lastWhole.s = wholeS;
            this.now = now;
            // SVG mark transitions only on boundaries (keeps legacy behavior cheap)
            this.transitionMark("SECOND", wholeS);
            if (this.audio.opts.secondTick) this.audio.playSecondTick();
            this.options.onSetTime();
        }
        if (wholeM !== this._lastWhole.m) {
            this._lastWhole.m = wholeM;
            this.transitionMark("MINUTE", wholeM);
        }
        if (wholeH !== this._lastWhole.h) {
            const isFirstHourTick = this._lastWhole.h === -1;
            this._lastWhole.h = wholeH;
            this.transitionMark("HOUR", wholeH);
            if (!isFirstHourTick && this.audio.opts.hourChime) {
                this.audio.playHourChime(wholeH);
            }
        }

        if (!this.renderer) return;  // SVG-only mode: nothing else to do per-frame

        // Fractional hand positions in pixel space (for cPoint compat + WebGL)
        const useSmooth = this.options.sweep === "smooth";
        const hVal = useSmooth ? h : wholeH;
        const mVal = useSmooth ? m : wholeM;
        const sVal = useSmooth ? s : wholeS;
        const cH = this.cPoint(12, hVal, this.options.circleRadii.HOUR, this.center);
        const cM = this.cPoint(60, mVal, this.options.circleRadii.MINUTE, this.center);
        const cS = this.cPoint(60, sVal, this.options.circleRadii.SECOND, this.center);

        // Convert to clip space
        const half = this.edgeLength / 2;
        const toClip = (p) => [(p[0] - half) / half, -(p[1] - half) / half];
        const centerC = [0, 0];
        const ctlPoints = [centerC, toClip(cH), toClip(cM), toClip(cS)];

        // Update GPU hand ribbons for each curveType
        for (const ct in this.options.curveTypes) {
            const closed = ct.indexOf("Closed") > -1;
            this.renderer.setHand(ct, ctlPoints, closed);
        }

        // Tilt
        this.tilt.update(dt);

        // Astronomical state
        const astro = this.options.astronomical;
        let daylight = [0, 0], moonP = 0, moonI = 0, sunDot = [-2, -2];
        if (astro?.enabled && this._astro.ready) {
            const arc = daylightArc(now, this._astro.lat, this._astro.lon);
            if (arc) daylight = arc;
            const mp = moonPhase(now);
            moonP = mp.phase; moonI = mp.illumination;
            const sp = sunPosition(now, this._astro.lat, this._astro.lon);
            // Project sun: altitude maps to radius (above horizon = inside disk),
            // azimuth maps to angle around center.
            if (sp.altitude > 0) {
                const r = 0.78 * (1 - sp.altitude / (Math.PI / 2));
                sunDot = [Math.sin(sp.azimuth) * r, Math.cos(sp.azimuth) * r];
            }
        }

        const t = this.options.theme;
        this.renderer.render({
            time,
            bg: t.bg, accent: t.accent,
            dialColor: t.dial, handColor: t.hand, handGlow: t.handGlow,
            tiltMatrix: this.tilt.matrix(),
            bloomThreshold: this.options.bloom.threshold,
            bloomIntensity: this.options.bloom.enabled ? this.options.bloom.intensity : 0,
            astro: !!astro?.enabled,
            daylightArc: daylight,
            moonPhase: moonP,
            moonIllum: moonI,
            sunDot
        });
    }

    destroy() {
        this.loop.destroy();
        this._ro?.disconnect();
        this.tilt.destroy();
        this.audio.destroy();
        this.xr?.destroy();
        this.renderer?.destroy();
        this.overlay.destroy();
    }
}

// Expose as global for non-module consumers (mirrors the old script-tag UX of clock.js)
if (typeof window !== "undefined") window.YAClock = YAClock;

export default YAClock;
