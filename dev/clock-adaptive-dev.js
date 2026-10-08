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

    // PROD internals, assigned in attach() from hooks.internals (pure functions + caches).
    let cache, saveCached, STORAGE_KEYS, fetchWeather, currentLocation, currentWeather, NEUTRAL_WEATHER,
        computeEnvironment, computeTargetSky, computeTargetInner, computeMoonBrightHsl, fmtHsl,
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
        locationOverride: null
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
        const clock = hooks.getClock();
        if (clock) clock.setTime(getNow().simTime);   // re-point hands; fires onSetTime → PROD tick()
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
        if (params.speed) sim.speed = parseFloat(params.speed) || 1;
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

    function buildSimOverlay() {
        if (simOverlay) { simOverlay.style.display = 'block'; return; }
        const root = document.createElement('div');
        root.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;background:rgba(20,22,30,0.86);'
            + 'color:#eee;font:12px/1.4 ui-monospace,Menlo,monospace;padding:10px 12px;border-radius:8px;'
            + 'box-shadow:0 4px 14px rgba(0,0,0,0.4);min-width:230px;backdrop-filter:blur(6px);';
        root.innerHTML =
            '<div style="font-weight:700;margin-bottom:6px;letter-spacing:0.5px">SIM</div>'
          + '<div><input type="datetime-local" id="sim-dt" style="width:100%;background:#2a2d3a;color:#eee;border:1px solid #444;padding:3px;border-radius:3px"></div>'
          + '<div style="margin-top:6px"><label>speed </label>'
          + '<select id="sim-speed" style="background:#2a2d3a;color:#eee;border:1px solid #444">'
          + '<option value="0">pause</option><option value="1">1×</option><option value="60">60×</option>'
          + '<option value="3600">3600×</option><option value="86400">86400×</option></select></div>'
          + '<div style="margin-top:6px"><label>cloud </label><input id="sim-cloud" type="range" min="0" max="100" value="30" style="width:120px"></div>'
          + '<div><label>precip </label><input id="sim-precip" type="range" min="0" max="10" step="0.1" value="0" style="width:120px"></div>'
          + '<div><label>code </label><select id="sim-code" style="background:#2a2d3a;color:#eee;border:1px solid #444">'
          + '<option value="0">0 clear</option><option value="2">2 partly</option><option value="3">3 overcast</option>'
          + '<option value="45">45 fog</option><option value="61">61 rain</option><option value="71">71 snow</option>'
          + '<option value="95">95 thunder</option></select></div>'
          + '<div style="margin-top:6px"><label>lat </label><input id="sim-lat" type="number" step="0.01" style="width:65px;background:#2a2d3a;color:#eee;border:1px solid #444">'
          + ' <label>lon </label><input id="sim-lon" type="number" step="0.01" style="width:65px;background:#2a2d3a;color:#eee;border:1px solid #444"></div>'
          + '<div style="margin-top:6px;display:flex;align-items:center;gap:6px">'
          + '<button id="sim-geo">use my location</button>'
          + '<span id="sim-geo-status" style="font-size:10px;opacity:0.7"></span></div>'
          + '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">'
          + '<button data-jump="sunrise">↑sun</button><button data-jump="sunset">↓sun</button>'
          + '<button data-jump="full">●moon</button><button data-jump="new">○moon</button>'
          + '<button data-jump="solstice">solst</button><button data-jump="equinox">equi</button>'
          + '<button data-jump="solar">☼ecl</button><button data-jump="lunar">☾ecl</button></div>'
          + '<div style="margin-top:6px;font-size:10px;opacity:0.6">Shift+S to toggle</div>';
        document.body.appendChild(root);
        simOverlay = root;

        root.querySelectorAll('button[data-jump]').forEach(b => b.style.cssText =
            'background:#2a2d3a;color:#eee;border:1px solid #444;padding:2px 6px;border-radius:3px;font:11px ui-monospace,Menlo,monospace;cursor:pointer');

        const dt = root.querySelector('#sim-dt');
        const speed = root.querySelector('#sim-speed');
        const cloud = root.querySelector('#sim-cloud');
        const precip = root.querySelector('#sim-precip');
        const code = root.querySelector('#sim-code');
        const lat = root.querySelector('#sim-lat');
        const lon = root.querySelector('#sim-lon');

        function fmtDt(d) {
            const pad = (n) => ('0'+n).slice(-2);
            return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
        }

        function syncFromUI() {
            sim.enabled = true;
            const dv = new Date(dt.value);
            if (!isFinite(dv.getTime())) return;
            const sv = parseFloat(speed.value);
            setSim({
                simTime: dv,
                speed: sv,
                weatherOverride: {
                    cloudCover: +cloud.value / 100,
                    precip: +precip.value,
                    code: +code.value
                },
                locationOverride: (lat.value && lon.value) ? { lat: +lat.value, lon: +lon.value, source: 'override' } : null
            });
        }

        dt.addEventListener('change', syncFromUI);
        speed.addEventListener('change', syncFromUI);
        cloud.addEventListener('input', syncFromUI);
        precip.addEventListener('input', syncFromUI);
        code.addEventListener('change', syncFromUI);
        lat.addEventListener('change', syncFromUI);
        lon.addEventListener('change', syncFromUI);

        root.querySelectorAll('button[data-jump]').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = jumpTo(btn.dataset.jump);
                if (target) {
                    dt.value = fmtDt(target);
                    syncFromUI();
                }
            });
        });

        const geoBtn = root.querySelector('#sim-geo');
        const geoStatus = root.querySelector('#sim-geo-status');
        geoBtn.style.cssText = 'background:#2a2d3a;color:#eee;border:1px solid #444;padding:2px 6px;border-radius:3px;font:11px ui-monospace,Menlo,monospace;cursor:pointer';
        geoBtn.addEventListener('click', () => {
            if (!navigator.geolocation) { geoStatus.textContent = 'unsupported'; return; }
            geoStatus.textContent = 'requesting…';
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const loc = {
                        lat: pos.coords.latitude,
                        lon: pos.coords.longitude,
                        tz: cache.location && cache.location.tz,
                        source: 'browser-geo',
                        fetchedAt: Date.now()
                    };
                    cache.location = loc;
                    saveCached(STORAGE_KEYS.location, loc);
                    cache.weather = null;
                    fetchWeather();
                    geoStatus.textContent = loc.lat.toFixed(3) + ', ' + loc.lon.toFixed(3);
                },
                (err) => { geoStatus.textContent = 'denied/failed (' + err.code + ')'; },
                { timeout: 10000, maximumAge: 60000, enableHighAccuracy: false }
            );
        });

        // Initial sync from sim state
        dt.value = fmtDt(getNow().simTime);
        speed.value = String(sim.speed);
        if (sim.weatherOverride) {
            if (sim.weatherOverride.cloudCover != null) cloud.value = sim.weatherOverride.cloudCover * 100;
            if (sim.weatherOverride.precip != null) precip.value = sim.weatherOverride.precip;
            if (sim.weatherOverride.code != null) code.value = sim.weatherOverride.code;
        }
        if (sim.locationOverride) {
            lat.value = sim.locationOverride.lat;
            lon.value = sim.locationOverride.lon;
        }
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
        closedP.setAttribute('stroke', 'black');
        closedP.setAttribute('stroke-width', '1.5');
        closedP.setAttribute('stroke-linecap', 'round');
        svg.appendChild(closedP);

        // Open curve (the second-hand spline)
        const openP = document.createElementNS(svgNS, 'path');
        openP.setAttribute('d', naturalGen(pts));
        openP.setAttribute('fill', 'none');
        openP.setAttribute('stroke', 'black');
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
            ln.setAttribute('stroke', 'black');
            ln.setAttribute('stroke-width', i % 3 === 0 ? 2 : 1);
            svg.appendChild(ln);
        }

        // Center marker
        const centerC = document.createElementNS(svgNS, 'circle');
        centerC.setAttribute('cx', C); centerC.setAttribute('cy', C);
        centerC.setAttribute('r', E / 80);
        centerC.setAttribute('stroke', 'black');
        centerC.setAttribute('fill', 'none');
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
        ol.setAttribute('stroke', 'rgba(0,0,0,0.35)'); ol.setAttribute('stroke-width', '0.8');
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
        ({ cache, saveCached, STORAGE_KEYS, fetchWeather, currentLocation, currentWeather, NEUTRAL_WEATHER,
           computeEnvironment, computeTargetSky, computeTargetInner, computeMoonBrightHsl, fmtHsl,
           moonPath, moonPhase, sunPosition, solsticeEquinox, findNextEclipse, eclipsePeak } = hooks.internals);

        parseHash();
        window.addEventListener('hashchange', () => { parseHash(); pushToProd(); });

        // Drive the YAClock hands from sim time: swap its tick and restart the interval.
        const clock = hooks.getClock();
        clock.stop();
        clock.tick = function () { this.setTime(getNow().simTime); };
        clock.start();

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
