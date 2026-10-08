/* dev/clock-adaptive-dev.js — DEV HARNESS ONLY
 * Simulation of time / speed / weather / location, jump-to astronomical events, and the
 * scenario gallery. Loaded ONLY by dev/clock.html, never by the PROD page (../clock.html).
 * Attaches to the PROD module through AdaptiveClock._dev after AdaptiveClock.init().
 *
 *   Shift+S  toggle SIM overlay      Shift+G  toggle scenario gallery      Esc  close gallery
 *   URL hash: #sim=2026-08-12T17:46&speed=60&lat=64&lon=-22&weather=code:63,cloudCover:0.95
 */
(function () {
    'use strict';

    let hooks = null;           // AdaptiveClock._dev
    let simOverlay = null;
    let galleryOverlay = null;
    let restartTicker = null;   // installed by attach(): drives the hands at a speed-appropriate cadence

    // PROD internals, assigned in attach() from hooks.internals (pure functions + caches).
    let currentLocation, currentWeather, NEUTRAL_WEATHER,
        computeEnvironment, computeTargetSky, computeTargetInner, computeMoonBrightHsl, inkForLightness, fmtHsl,
        moonPath, moonPhase, sunPosition, solsticeEquinox, findNextEclipse, eclipsePeak;

    // ============================================================
    // SIM STATE + TIME
    // ============================================================

    const sim = {
        enabled: false,
        anchorReal: Date.now(),
        anchorSim: Date.now(),
        speed: 1,
        weatherOverride: null,
        locationOverride: null,
        snap: true           // true: jump to final colours on every change; false: ease in like PROD
    };

    function getNow() {
        const wall = Date.now();
        const simTime = sim.enabled
            ? new Date(sim.anchorSim + (wall - sim.anchorReal) * sim.speed)
            : new Date(wall);
        return {
            wallTime: new Date(wall),
            simTime,
            simSpeed: sim.enabled ? sim.speed : 1,
            isSim: sim.enabled
        };
    }

    // Push the current sim state into the PROD seam and repaint.
    function pushToProd() {
        if (!hooks) return;
        hooks.setTimeSource(sim.enabled ? { now: () => getNow().simTime, speed: () => getNow().simSpeed } : null);
        hooks.setOverrides({
            location: sim.enabled ? sim.locationOverride : null,
            weather:  sim.enabled ? sim.weatherOverride  : null
        });
        if (sim.enabled && sim.snap) hooks.snap();
        if (restartTicker) restartTicker();           // re-point hands now; fires onSetTime → PROD tick()
    }

    function setSim(opts) {
        if (opts.simTime !== undefined) {
            sim.anchorSim = opts.simTime instanceof Date ? opts.simTime.getTime() : new Date(opts.simTime).getTime();
            sim.anchorReal = Date.now();
        }
        if (opts.speed !== undefined) {
            // Re-anchor so simTime is continuous across speed changes.
            const nowSim = getNow().simTime.getTime();
            sim.anchorSim = nowSim;
            sim.anchorReal = Date.now();
            sim.speed = opts.speed;
        }
        if (opts.enabled !== undefined) sim.enabled = opts.enabled;
        if (opts.weatherOverride !== undefined) sim.weatherOverride = opts.weatherOverride;
        if (opts.locationOverride !== undefined) sim.locationOverride = opts.locationOverride;
        writeHashFromSim();
        pushToProd();
    }

    // ============================================================
    // HASH STATE (sim mode)
    // ============================================================

    function parseHash() {
        const h = window.location.hash.replace(/^#/, '');
        if (!h) return;
        const params = {};
        h.split('&').forEach(kv => {
            const [k, v] = kv.split('=');
            if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
        });
        if (params.sim) {
            sim.enabled = true;
            sim.anchorSim = new Date(params.sim).getTime();
            if (!isFinite(sim.anchorSim)) sim.anchorSim = Date.now();
            sim.anchorReal = Date.now();
        }
        if (params.speed) sim.speed = parseFloat(params.speed) || 0;
        if (params.ease) sim.snap = false;
        if (params.lat && params.lon) {
            sim.locationOverride = { lat: parseFloat(params.lat), lon: parseFloat(params.lon), source: 'override' };
        }
        if (params.weather) {
            const wo = {};
            params.weather.split(',').forEach(pair => {
                const [k, v] = pair.split(':');
                if (k && v !== undefined) wo[k] = isFinite(+v) ? +v : v;
            });
            sim.weatherOverride = wo;
        }
    }

    function writeHashFromSim() {
        if (!sim.enabled) {
            if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
            return;
        }
        const parts = [];
        parts.push('sim=' + encodeURIComponent(new Date(getNow().simTime).toISOString().slice(0, 16)));
        parts.push('speed=' + sim.speed);
        if (!sim.snap) parts.push('ease=1');
        if (sim.locationOverride) {
            parts.push('lat=' + sim.locationOverride.lat);
            parts.push('lon=' + sim.locationOverride.lon);
        }
        if (sim.weatherOverride) {
            parts.push('weather=' + encodeURIComponent(
                Object.keys(sim.weatherOverride).map(k => k + ':' + sim.weatherOverride[k]).join(',')));
        }
        history.replaceState(null, '', '#' + parts.join('&'));
    }

    // ============================================================
    // SIM OVERLAY
    // ============================================================

    const SPEEDS = [
        { v: 0,      label: 'paused' },
        { v: 1,      label: 'real time' },
        { v: 60,     label: '1 min / s' },
        { v: 3600,   label: '1 hour / s' },
        { v: 86400,  label: '1 day / s' },
        { v: 604800, label: '1 week / s' }
    ];
    const WMO_CODES = [
        [0, '0 clear'], [1, '1 mainly clear'], [2, '2 partly cloudy'], [3, '3 overcast'], [45, '45 fog'],
        [51, '51 drizzle'], [61, '61 rain'], [63, '63 moderate rain'], [65, '65 heavy rain'],
        [71, '71 snow'], [73, '73 moderate snow'], [80, '80 showers'], [95, '95 thunderstorm']
    ];
    const PLACES = [
        ['Basel', 47.56, 7.59], ['Reykjavík', 64.15, -21.94], ['Tromsø', 69.65, 18.96],
        ['Longyearbyen', 78.22, 15.63], ['Quito', -0.18, -78.47], ['Honolulu', 21.31, -157.86],
        ['Sydney', -33.87, 151.21], ['Ushuaia', -54.80, -68.30]
    ];

    // Accepts "47.56, 7.59" · "47.56 7.59" · "47.56N 7.59E" · "7.59E 47.56N" · 64°09'N 21°56'W · 47°33'36"N 7°35'19"E
    function parseLatLon(str) {
        const re = /(-?\d+(?:\.\d+)?)\s*(?:°|º|deg)?\s*(?:(\d+(?:\.\d+)?)\s*['′])?\s*(?:(\d+(?:\.\d+)?)\s*["″])?\s*([NSEW])?/gi;
        const parts = [];
        let m;
        while (parts.length < 2 && (m = re.exec(str))) {
            let v = parseFloat(m[1]) + (m[2] ? parseFloat(m[2]) / 60 : 0) + (m[3] ? parseFloat(m[3]) / 3600 : 0);
            const h = (m[4] || '').toUpperCase();
            if (h === 'S' || h === 'W') v = -Math.abs(v);
            parts.push({ v, h });
        }
        if (parts.length !== 2) return null;
        let [a, b] = parts;
        if (a.h === 'E' || a.h === 'W' || b.h === 'N' || b.h === 'S') [a, b] = [b, a];
        if (!isFinite(a.v) || !isFinite(b.v) || Math.abs(a.v) > 90 || Math.abs(b.v) > 180) return null;
        return { lat: a.v, lon: b.v };
    }

    async function geocode(q) {
        const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q) + '&count=1&language=en');
        if (!r.ok) return null;
        const j = await r.json();
        const hit = j.results && j.results[0];
        return hit ? { lat: hit.latitude, lon: hit.longitude, label: hit.name + (hit.country_code ? ', ' + hit.country_code : '') } : null;
    }

    function fmtDt(d) {
        const pad = (n) => ('0' + n).slice(-2);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function buildSimOverlay() {
        if (simOverlay) { simOverlay.style.display = 'block'; return; }
        const root = document.createElement('div');
        root.id = 'yaclock-sim';
        root.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;background:rgba(20,22,30,0.9);'
            + 'color:#eee;font:12px/1.5 ui-monospace,Menlo,monospace;padding:10px 12px;border-radius:8px;'
            + 'box-shadow:0 4px 14px rgba(0,0,0,0.4);width:340px;backdrop-filter:blur(6px);';
        const field = 'background:#2a2d3a;color:#eee;border:1px solid #444;border-radius:3px;padding:2px 4px;font:inherit';
        const btn = 'background:#2a2d3a;color:#eee;border:1px solid #444;padding:2px 6px;border-radius:3px;font:11px ui-monospace,Menlo,monospace;cursor:pointer';
        root.innerHTML = `
<style>
  #yaclock-sim .row { display:grid; grid-template-columns:52px 1fr; gap:4px 8px; align-items:center; margin-top:5px }
  #yaclock-sim .row > label:first-child { opacity:.65 }
  #yaclock-sim .hint { font-size:10px; opacity:.55; line-height:1.4 }
  #yaclock-sim input[type=range] { width:110px; vertical-align:middle }
  #yaclock-sim hr { border:0; border-top:1px solid #3a3e4c; margin:8px 0 }
  #yaclock-sim #sim-state { font-size:11px; opacity:.9; white-space:pre-line; color:#ffd9a8 }
</style>
<div style="font-weight:700;letter-spacing:.5px">SIM</div>
<div class="row"><label>time</label><div style="display:flex;gap:4px">
  <input type="datetime-local" id="sim-dt" style="${field};flex:1;min-width:0">
  <button id="sim-now" style="${btn}" title="back to wall-clock time">now</button></div></div>
<div class="row"><label>step</label><div style="display:flex;gap:4px;flex-wrap:wrap">
  <button data-step="-86400" style="${btn}">−1 d</button><button data-step="-3600" style="${btn}">−1 h</button>
  <button data-step="3600" style="${btn}">+1 h</button><button data-step="86400" style="${btn}">+1 d</button>
  <button data-step="604800" style="${btn}">+7 d</button></div></div>
<div class="row"><label>speed</label><select id="sim-speed" style="${field}"></select></div>
<div class="row"><label>mode</label><div>
  <label><input type="radio" name="sim-mode" value="snap" id="sim-mode-snap"> snap</label>
  <label style="margin-left:10px"><input type="radio" name="sim-mode" value="ease" id="sim-mode-ease"> ease</label>
  <div class="hint" id="sim-mode-hint"></div></div></div>
<hr>
<div class="row"><label>weather</label><select id="sim-code" style="${field}"></select></div>
<div class="row"><label>cloud</label><div><input id="sim-cloud" type="range" min="0" max="100" value="30"> <span id="sim-cloud-v"></span></div></div>
<div class="row"><label>precip</label><div><input id="sim-precip" type="range" min="0" max="10" step="0.1" value="0"> <span id="sim-precip-v"></span></div></div>
<div class="row"><label></label><button id="sim-wx-clear" style="${btn};justify-self:start" title="drop the override, back to live weather">real weather</button></div>
<hr>
<div class="row"><label>place</label><div style="display:flex;gap:4px">
  <input id="sim-place" placeholder="Basel · 47.56, 7.59 · 64°09'N 21°56'W" style="${field};flex:1;min-width:0">
  <button id="sim-place-go" style="${btn}">go</button></div></div>
<div class="row"><label></label><div style="display:flex;gap:4px;flex-wrap:wrap">
  <select id="sim-preset" style="${field}"><option value="">presets…</option></select>
  <button id="sim-loc-clear" style="${btn}" title="drop the override: the IP-based location PROD itself uses">prod location</button>
  <button id="sim-geo" style="${btn}" title="browser geolocation as a sim override (PROD never asks for it)">browser GPS</button></div></div>
<div class="row"><label></label><div class="hint" id="sim-loc-status"></div></div>
<hr>
<div class="row"><label>jump</label><div style="display:flex;flex-wrap:wrap;gap:4px">
  <button data-jump="sunrise" style="${btn}">↑sun</button><button data-jump="sunset" style="${btn}">↓sun</button>
  <button data-jump="full" style="${btn}">●moon</button><button data-jump="new" style="${btn}">○moon</button>
  <button data-jump="solstice" style="${btn}">solst</button><button data-jump="equinox" style="${btn}">equi</button>
  <button data-jump="solar" style="${btn}">☼ecl</button><button data-jump="lunar" style="${btn}">☾ecl</button></div></div>
<hr>
<div id="sim-state"></div>
<div class="hint" style="margin-top:4px">Shift+S toggle · Shift+G gallery · everything above lives in the URL hash</div>`;
        document.body.appendChild(root);
        simOverlay = root;

        const $ = (id) => root.querySelector('#' + id);
        const dt = $('sim-dt'), speed = $('sim-speed'), code = $('sim-code'), cloud = $('sim-cloud'), precip = $('sim-precip');
        const cloudV = $('sim-cloud-v'), precipV = $('sim-precip-v');
        const place = $('sim-place'), preset = $('sim-preset'), locStatus = $('sim-loc-status'), state = $('sim-state');
        const modeSnap = $('sim-mode-snap'), modeEase = $('sim-mode-ease'), modeHint = $('sim-mode-hint');

        SPEEDS.forEach(s => speed.add(new Option(s.label, String(s.v))));
        WMO_CODES.forEach(([v, l]) => code.add(new Option(l, String(v))));
        PLACES.forEach(([name, lat, lon]) => preset.add(new Option(name, lat + ',' + lon)));

        // --- time / speed / mode
        dt.addEventListener('change', () => {
            const dv = new Date(dt.value);
            if (isFinite(dv.getTime())) setSim({ enabled: true, simTime: dv });
        });
        $('sim-now').addEventListener('click', () => { setSim({ enabled: true, simTime: new Date() }); refresh(); });
        root.querySelectorAll('button[data-step]').forEach(b => b.addEventListener('click', () => {
            setSim({ enabled: true, simTime: new Date(getNow().simTime.getTime() + Number(b.dataset.step) * 1000) });
            refresh();
        }));
        speed.addEventListener('change', () => setSim({ enabled: true, speed: parseFloat(speed.value) }));
        function syncMode() {
            modeHint.textContent = sim.snap
                ? 'snap: jump straight to the final colours (what the gallery shows)'
                : 'ease: colours drift in over minutes, like PROD (÷ speed)';
            modeSnap.checked = sim.snap; modeEase.checked = !sim.snap;
        }
        modeSnap.addEventListener('change', () => { sim.snap = true; syncMode(); setSim({ enabled: true }); });
        modeEase.addEventListener('change', () => { sim.snap = false; syncMode(); setSim({ enabled: true }); });

        // --- weather
        const weatherFromUI = () => ({ code: +code.value, cloudCover: +cloud.value / 100, precip: +precip.value });
        const onWx = () => setSim({ enabled: true, weatherOverride: weatherFromUI() });
        code.addEventListener('change', onWx);
        cloud.addEventListener('input', onWx);
        precip.addEventListener('input', onWx);
        $('sim-wx-clear').addEventListener('click', () => { setSim({ weatherOverride: null }); syncWeatherInputs(); });
        function syncWeatherInputs() {
            const w = currentWeather();
            if (![...code.options].some(o => o.value === String(w.code))) code.add(new Option(String(w.code), String(w.code)));
            code.value = String(w.code);
            cloud.value = Math.round((w.cloudCover || 0) * 100);
            precip.value = w.precip || 0;
        }

        // --- place
        async function applyPlace(q) {
            q = q.trim();
            if (!q) return;
            const parsed = parseLatLon(q);
            let loc = parsed ? { lat: parsed.lat, lon: parsed.lon, label: parsed.lat.toFixed(3) + ', ' + parsed.lon.toFixed(3) } : null;
            if (!loc) {
                locStatus.textContent = 'looking up "' + q + '"…';
                try { loc = await geocode(q); } catch (e) { loc = null; }
            }
            if (!loc) { locStatus.textContent = 'could not parse or find "' + q + '"'; return; }
            setSim({ enabled: true, locationOverride: { lat: loc.lat, lon: loc.lon, source: 'override', label: loc.label } });
        }
        $('sim-place-go').addEventListener('click', () => applyPlace(place.value));
        place.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPlace(place.value); });
        preset.addEventListener('change', () => {
            if (!preset.value) return;
            const [lat, lon] = preset.value.split(',').map(Number);
            setSim({ enabled: true, locationOverride: { lat, lon, source: 'override', label: preset.options[preset.selectedIndex].text } });
            preset.value = '';
        });
        $('sim-loc-clear').addEventListener('click', () => setSim({ locationOverride: null }));
        $('sim-geo').addEventListener('click', () => {
            if (!navigator.geolocation) { locStatus.textContent = 'geolocation unsupported'; return; }
            locStatus.textContent = 'requesting…';
            navigator.geolocation.getCurrentPosition(
                (pos) => setSim({ enabled: true, locationOverride: {
                    lat: pos.coords.latitude, lon: pos.coords.longitude, source: 'override', label: 'browser GPS' } }),
                (err) => { locStatus.textContent = 'denied/failed (' + err.code + ')'; },
                { timeout: 10000, maximumAge: 60000, enableHighAccuracy: false }
            );
        });

        // --- jumps
        root.querySelectorAll('button[data-jump]').forEach(b => b.addEventListener('click', () => {
            const target = jumpTo(b.dataset.jump);
            if (target) { setSim({ enabled: true, simTime: target }); refresh(); }
            else locStatus.textContent = 'no ' + b.dataset.jump + ' found ahead';
        }));

        // --- initial values from sim state / live data
        dt.value = fmtDt(getNow().simTime);
        if (![...speed.options].some(o => o.value === String(sim.speed))) speed.add(new Option(sim.speed + '×', String(sim.speed)));
        speed.value = String(sim.speed);
        syncWeatherInputs();
        syncMode();

        // --- live readout: time follows the clock, state line shows what PROD computes right now
        function refresh() {
            if (root.style.display === 'none') return;
            if (document.activeElement !== dt) dt.value = fmtDt(getNow().simTime);
            if (!(sim.enabled && sim.weatherOverride) && ![code, cloud, precip].includes(document.activeElement)) syncWeatherInputs();
            cloudV.textContent = cloud.value + '%';
            precipV.textContent = (+precip.value).toFixed(1) + ' mm/h';
            const now = getNow(), loc = currentLocation(), w = currentWeather();
            const env = computeEnvironment(now, loc, w);
            const lo = sim.enabled && sim.locationOverride;
            const coords = lo && (lo.lat.toFixed(3) + ', ' + lo.lon.toFixed(3));
            locStatus.textContent = lo
                ? 'override: ' + (lo.label && lo.label !== coords ? lo.label + ' (' + coords + ')' : coords)
                : 'prod location: ' + loc.lat.toFixed(3) + ', ' + loc.lon.toFixed(3) + ' (' + (loc.source || 'cache') + ')';
            state.textContent =
                'sun ' + env.sun.altitudeDeg.toFixed(1) + '° ' + (env.sun.isUp ? 'up' : 'down')
                + ' · moon ' + (env.moon.illumination * 100).toFixed(0) + '% ' + (env.moon.waxing ? 'waxing' : 'waning')
                + '\nweather ' + (sim.enabled && sim.weatherOverride ? 'override' : 'live') + ': code ' + w.code
                + ' · cloud ' + ((w.cloudCover || 0) * 100).toFixed(0) + '% · precip ' + (w.precip || 0) + ' mm/h'
                + (w.isStale && !(sim.enabled && sim.weatherOverride) ? ' · stale' : '')
                + '\n' + (env.surprises.length ? 'surprises: ' + env.surprises.join(', ') : 'no surprise active');
        }
        refresh();
        setInterval(refresh, 500);
    }

    function hideSimOverlay() {
        if (simOverlay) simOverlay.style.display = 'none';
    }

    // ============================================================
    // JUMP-TO TARGETS (binary search forward in time)
    // ============================================================

    function jumpTo(kind) {
        const now = getNow().simTime;
        const loc = currentLocation();
        if (kind === 'full' || kind === 'new') {
            return searchMoon(now, kind === 'full' ? 0.5 : 0);
        }
        if (kind === 'sunrise' || kind === 'sunset') {
            return searchSunCrossing(now, loc, kind === 'sunrise');
        }
        if (kind === 'solstice') {
            return nextEvent(now, ['junSolstice','decSolstice']);
        }
        if (kind === 'equinox') {
            return nextEvent(now, ['marEquinox','sepEquinox']);
        }
        if (kind === 'solar' || kind === 'lunar') {
            const e = findNextEclipse(now, kind);
            return e ? new Date(eclipsePeak(e)) : null;
        }
        return null;
    }

    function searchMoon(start, targetPhase) {
        let t = start.getTime();
        let step = 3600 * 1000;
        let lastDiff = phaseDiff(moonPhase(new Date(t)), targetPhase);
        for (let i = 0; i < 30 * 24; i++) {
            t += step;
            const d = phaseDiff(moonPhase(new Date(t)), targetPhase);
            if (Math.sign(d) !== Math.sign(lastDiff) && Math.abs(d) < 0.1) {
                // refine
                let lo = t - step, hi = t;
                for (let k = 0; k < 30; k++) {
                    const mid = (lo + hi) / 2;
                    const dm = phaseDiff(moonPhase(new Date(mid)), targetPhase);
                    if (Math.sign(dm) === Math.sign(lastDiff)) lo = mid; else hi = mid;
                }
                return new Date((lo + hi) / 2);
            }
            lastDiff = d;
        }
        return null;
    }

    function phaseDiff(p, target) {
        let d = p - target;
        if (d > 0.5) d -= 1;
        else if (d < -0.5) d += 1;
        return d;
    }

    function searchSunCrossing(start, loc, wantRising) {
        let t = start.getTime() + 60000;
        let prevAlt = sunPosition(new Date(t), loc.lat, loc.lon).altitudeDeg;
        const step = 5 * 60 * 1000;
        for (let i = 0; i < 24 * 60; i++) {
            t += step;
            const a = sunPosition(new Date(t), loc.lat, loc.lon).altitudeDeg;
            const crossing = (prevAlt < -0.83 && a > -0.83) ? 'sunrise' : (prevAlt > -0.83 && a < -0.83) ? 'sunset' : null;
            if ((crossing === 'sunrise' && wantRising) || (crossing === 'sunset' && !wantRising)) {
                // refine
                let lo = t - step, hi = t;
                for (let k = 0; k < 30; k++) {
                    const mid = (lo + hi) / 2;
                    const am = sunPosition(new Date(mid), loc.lat, loc.lon).altitudeDeg;
                    if ((am < -0.83) === (prevAlt < -0.83)) lo = mid; else hi = mid;
                }
                return new Date((lo + hi) / 2);
            }
            prevAlt = a;
        }
        return null;
    }

    function nextEvent(start, keys) {
        const t = start.getTime();
        const y = start.getUTCFullYear();
        let best = null;
        for (const yr of [y, y+1]) {
            const ev = solsticeEquinox(yr);
            for (const k of keys) {
                const dt = ev[k].getTime();
                if (dt > t && (!best || dt < best.getTime())) best = ev[k];
            }
        }
        return best;
    }

    // ============================================================
    // GALLERY MODE
    // ============================================================

    const GALLERY_SCENARIOS = [
        { label: 'now (live)',             time: 'live',                  weather: 'live',                                              loc: 'live' },
        { label: 'midnight clear (summer)',time: '2026-06-21T01:00',      weather: { code: 0,  cloudCover: 0,    precip: 0 } },
        { label: 'astronomical dawn',      time: '2026-06-21T04:00',      weather: { code: 0,  cloudCover: 0.1,  precip: 0 } },
        { label: 'sunrise clear',          time: '2026-06-21T05:30',      weather: { code: 0,  cloudCover: 0.1,  precip: 0 } },
        { label: 'midday clear (summer)',  time: '2026-06-21T13:00',      weather: { code: 0,  cloudCover: 0,    precip: 0 } },
        { label: 'midday overcast',        time: '2026-06-21T13:00',      weather: { code: 3,  cloudCover: 1,    precip: 0 } },
        { label: 'midday rain',            time: '2026-06-21T13:00',      weather: { code: 63, cloudCover: 0.95, precip: 3 } },
        { label: 'thunderstorm',           time: '2026-07-15T17:00',      weather: { code: 95, cloudCover: 1,    precip: 5 } },
        { label: 'winter snow',            time: '2026-12-21T13:00',      weather: { code: 73, cloudCover: 1,    precip: 1 } },
        { label: 'sunset golden hour',     time: '2026-06-21T21:20',      weather: { code: 0,  cloudCover: 0.1,  precip: 0 } },
        { label: 'civil twilight',         time: '2026-06-21T22:10',      weather: { code: 0,  cloudCover: 0.2,  precip: 0 } },
        { label: 'full moon night',        time: '2026-05-31T02:00',      weather: { code: 0,  cloudCover: 0,    precip: 0 } },
        { label: 'June solstice noon',     time: '2026-06-21T13:00',      weather: { code: 1,  cloudCover: 0.2,  precip: 0 } },
        { label: 'Dec solstice noon',      time: '2026-12-21T13:00',      weather: { code: 2,  cloudCover: 0.5,  precip: 0 } },
        { label: 'total solar eclipse',    time: '2026-08-12T17:46',      weather: { code: 0,  cloudCover: 0.2,  precip: 0 }, loc: { lat: 64,  lon: -22 } },
        { label: 'lunar eclipse (blood)',  time: '2026-03-03T11:33',      weather: { code: 0,  cloudCover: 0,    precip: 0 }, loc: { lat: 35,  lon: -120 } }
    ];

    function scenarioLocation(s) {
        if (!s.loc || s.loc === 'live') return currentLocation();
        return s.loc;
    }
    function scenarioWeather(s) {
        if (!s.weather || s.weather === 'live') return currentWeather();
        return Object.assign({}, NEUTRAL_WEATHER, s.weather, { isStale: false });
    }
    function scenarioTime(s) {
        if (s.time === 'live') return new Date();
        return new Date(s.time);
    }

    function cPointStatic(unit, value, radius, cx, cy) {
        const k = (2 * Math.PI) / unit;
        const a = k * (unit - value) + Math.PI;
        return [Math.sin(a) * radius + cx, Math.cos(a) * radius + cy];
    }

    // Builds a standalone SVG snapshot of the clock under a given scenario.
    // No smoothing — values are exact targets. Returns an <svg> element.
    function renderScenarioSvg(s) {
        const time = scenarioTime(s);
        const loc = scenarioLocation(s);
        const weather = scenarioWeather(s);

        const nowState = { wallTime: new Date(), simTime: time, simSpeed: 1, isSim: true };
        const env = computeEnvironment(nowState, loc, weather);
        const skyHsl = computeTargetSky(env);
        const innerHsl = computeTargetInner(env);
        const moonBrightHsl = computeMoonBrightHsl(env);
        const ink = fmtHsl(inkForLightness(skyHsl[2]));

        const E = 400, C = E / 2;
        const radii = { H: 50, M: 100, S: 150 };
        const h = time.getHours() % 12 + time.getMinutes() / 60;
        const m = time.getMinutes() + time.getSeconds() / 60;
        const sec = time.getSeconds();
        const pH = cPointStatic(12, h,   radii.H, C, C);
        const pM = cPointStatic(60, m,   radii.M, C, C);
        const pS = cPointStatic(60, sec, radii.S, C, C);

        const closedGen  = d3.line().curve(d3.curveBasisClosed);
        const naturalGen = d3.line().curve(d3.curveNatural);
        const pts = [[C, C], pH, pM, pS];

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', '0 0 ' + E + ' ' + E);
        svg.style.cssText = 'width:100%;height:auto;background:' + fmtHsl(skyHsl) + ';border-radius:6px;display:block';

        // Closed curve (inner area / "sky window")
        const closedP = document.createElementNS(svgNS, 'path');
        closedP.setAttribute('d', closedGen(pts));
        closedP.setAttribute('fill', fmtHsl(innerHsl));
        closedP.setAttribute('stroke', ink);
        closedP.setAttribute('stroke-width', '1.5');
        closedP.setAttribute('stroke-linecap', 'round');
        svg.appendChild(closedP);

        // Open curve (the second-hand spline)
        const openP = document.createElementNS(svgNS, 'path');
        openP.setAttribute('d', naturalGen(pts));
        openP.setAttribute('fill', 'none');
        openP.setAttribute('stroke', ink);
        openP.setAttribute('stroke-width', '1.5');
        openP.setAttribute('stroke-linecap', 'round');
        svg.appendChild(openP);

        // Hour markers (12 ticks)
        for (let i = 0; i < 12; i++) {
            const p1 = cPointStatic(12, i, radii.H - 4, C, C);
            const p2 = cPointStatic(12, i, radii.H + 4, C, C);
            const ln = document.createElementNS(svgNS, 'line');
            ln.setAttribute('x1', p1[0]); ln.setAttribute('y1', p1[1]);
            ln.setAttribute('x2', p2[0]); ln.setAttribute('y2', p2[1]);
            ln.setAttribute('stroke', ink);
            ln.setAttribute('stroke-width', i % 3 === 0 ? 2 : 1);
            svg.appendChild(ln);
        }

        // Center marker
        const centerC = document.createElementNS(svgNS, 'circle');
        centerC.setAttribute('cx', C); centerC.setAttribute('cy', C);
        centerC.setAttribute('r', E / 80);
        centerC.setAttribute('stroke', ink);
        centerC.setAttribute('fill', ink);
        svg.appendChild(centerC);

        // Moon at SECOND position
        const moonR = 14;
        const moonG = document.createElementNS(svgNS, 'g');
        moonG.setAttribute('transform', 'translate(' + pS[0] + ',' + pS[1] + ')');
        const dark = document.createElementNS(svgNS, 'circle');
        dark.setAttribute('r', moonR);
        dark.setAttribute('fill', 'hsl(225, 28%, 14%)');
        moonG.appendChild(dark);
        const bright = document.createElementNS(svgNS, 'path');
        bright.setAttribute('d', moonPath(moonR, env.moon.phase));
        bright.setAttribute('fill', fmtHsl(moonBrightHsl));
        moonG.appendChild(bright);
        const ol = document.createElementNS(svgNS, 'circle');
        ol.setAttribute('r', moonR); ol.setAttribute('fill', 'none');
        ol.setAttribute('stroke', ink); ol.setAttribute('stroke-opacity', '0.5'); ol.setAttribute('stroke-width', '0.8');
        moonG.appendChild(ol);
        svg.appendChild(moonG);

        return { svg, env };
    }

    function buildGalleryOverlay() {
        if (galleryOverlay) { galleryOverlay.style.display = 'block'; return; }
        const root = document.createElement('div');
        root.id = 'yaclock-gallery';
        root.style.cssText = 'position:fixed;inset:0;background:rgba(14,16,22,0.96);z-index:99998;'
            + 'overflow:auto;padding:24px 24px 48px;font:13px ui-monospace,Menlo,monospace;color:#ddd';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;max-width:1400px;margin:0 auto 16px';
        header.innerHTML = '<div style="font-size:14px;letter-spacing:0.5px;font-weight:700">GALLERY · clock states across time / weather / events</div>'
            + '<button id="gallery-close" style="background:#2a2d3a;color:#eee;border:1px solid #444;padding:6px 12px;border-radius:6px;cursor:pointer;font:12px ui-monospace,Menlo,monospace">close (Shift+G)</button>';
        root.appendChild(header);

        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;max-width:1400px;margin:0 auto';
        root.appendChild(grid);

        GALLERY_SCENARIOS.forEach(s => {
            const cell = document.createElement('div');
            cell.style.cssText = 'background:#1d2029;border:1px solid #2c303c;border-radius:10px;padding:10px;'
                + 'display:flex;flex-direction:column;gap:6px';
            const { svg, env } = renderScenarioSvg(s);
            cell.appendChild(svg);
            const title = document.createElement('div');
            title.style.cssText = 'font-weight:600;font-size:12px;color:#e8e8ec';
            title.textContent = s.label;
            cell.appendChild(title);
            const meta = document.createElement('div');
            meta.style.cssText = 'font-size:10.5px;color:#9aa0b0;line-height:1.45';
            const altDeg = env.sun.altitudeDeg.toFixed(1);
            const phasePct = (env.moon.illumination * 100).toFixed(0);
            const ts = s.time === 'live' ? 'now' : s.time.replace('T', ' ').slice(0, 16);
            const wc = (s.weather === 'live' || !s.weather) ? '(live)' : 'code=' + s.weather.code + ' c=' + (s.weather.cloudCover * 100).toFixed(0) + '%';
            meta.innerHTML = ts + '<br>sun ' + altDeg + '° · moon ' + phasePct + '%<br>' + wc
                + (env.surprises.length ? '<br><span style="color:#ffb86c">· ' + env.surprises.join(' · ') + '</span>' : '');
            cell.appendChild(meta);
            grid.appendChild(cell);
        });

        document.body.appendChild(root);
        galleryOverlay = root;

        root.querySelector('#gallery-close').addEventListener('click', hideGalleryOverlay);
    }

    function hideGalleryOverlay() {
        if (galleryOverlay) { galleryOverlay.remove(); galleryOverlay = null; }
    }


    // ============================================================
    // ATTACH (called by dev/clock.html after AdaptiveClock.init)
    // ============================================================

    function attach(devHooks) {
        hooks = devHooks;
        ({ currentLocation, currentWeather, NEUTRAL_WEATHER,
           computeEnvironment, computeTargetSky, computeTargetInner, computeMoonBrightHsl, inkForLightness, fmtHsl,
           moonPath, moonPhase, sunPosition, solsticeEquinox, findNextEclipse, eclipsePeak } = hooks.internals);

        parseHash();
        window.addEventListener('hashchange', () => { parseHash(); pushToProd(); });

        // Drive the YAClock hands from sim time. At real time (or paused) YAClock's own cadence is
        // right: one tick per second, each move animated over a second. In time-lapse (speed > 1)
        // that would start a fresh animation every second — headache. Tick at 4 Hz with no
        // transitions instead, so hands and colours flow like a time-lapse video.
        const clock = hooks.getClock();
        const realTransition = clock.options.transitionDuration;
        let timer = null;
        clock.stop();
        clock.start = function () {                 // YAClock calls start() when the tab becomes visible again
            if (timer) clearInterval(timer);
            const lapse = sim.enabled && sim.speed > 1;
            clock.options.transitionDuration = lapse ? 0 : realTransition;
            clock.setTime(getNow().simTime);
            timer = setInterval(() => clock.setTime(getNow().simTime), lapse ? 250 : 1000);
        };
        clock.stop = function () { if (timer) { clearInterval(timer); timer = null; } };
        restartTicker = clock.start;

        pushToProd();
        if (sim.enabled) buildSimOverlay();

        document.addEventListener('keydown', (e) => {
            const tag = e.target && e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (e.shiftKey && (e.key === 'S' || e.key === 's')) {
                e.preventDefault();
                if (simOverlay && simOverlay.style.display !== 'none') {
                    hideSimOverlay();
                    sim.enabled = false;
                } else {
                    if (!sim.enabled) {
                        sim.enabled = true;
                        sim.anchorReal = Date.now();
                        sim.anchorSim = Date.now();
                    }
                    buildSimOverlay();
                }
                writeHashFromSim();
                pushToProd();
            } else if (e.shiftKey && (e.key === 'G' || e.key === 'g')) {
                e.preventDefault();
                if (galleryOverlay) hideGalleryOverlay();
                else buildGalleryOverlay();
            } else if (e.key === 'Escape' && galleryOverlay) {
                hideGalleryOverlay();
            }
        });
    }

    window.AdaptiveClockDev = { attach, sim, getNow, setSim };
})();
