// dev/smoke.mjs — headless check that PROD cannot be steered and DEV can.
// Usage (from repo root):  npx -y -p playwright@1.58.1 -c "node dev/smoke.mjs"
// First time on a machine:  npx -y playwright@1.58.1 install chromium
// Serves the repo on a free port (override with PORT=). Screenshots land in dev/.smoke/ (git-ignored).
// Exit code 1 on any FAIL.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Resolve `playwright` from the cwd, or from whatever `npx -p playwright -c ...` put on PATH
// (its node_modules/.bin dirs). No install step in the repo, matching the no-build-step style.
const require = createRequire(import.meta.url);
const pathDirs = (process.env.PATH || '').split(path.delimiter)
  .filter(d => d.endsWith(path.join('node_modules', '.bin'))).map(d => path.dirname(d));
let playwright;
try { playwright = require(require.resolve('playwright', { paths: [process.cwd(), ...pathDirs] })); }
catch { console.error('playwright not found. Run:  npx -y -p playwright@1.58.1 -c "node dev/smoke.mjs"'); process.exit(2); }
const { chromium } = playwright;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OUT || path.join(ROOT, 'dev', '.smoke');
fs.mkdirSync(OUT, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0].split('#')[0]));
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(Number(process.env.PORT || 0), '127.0.0.1', r));
const PORT = server.address().port;   // ephemeral by default, so a dev server on 8765 never collides

const browser = await chromium.launch();
const results = [];
const check = (name, ok, info = '') => { results.push([ok ? 'PASS' : 'FAIL', name, info]); };

async function openPage(url) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);
  return { page, errors };
}

// ---------- PROD ----------
{
  const { page, errors } = await openPage(`http://localhost:${PORT}/clock.html#sim=2026-08-12T17:46&speed=3600`);
  const st = await page.evaluate(() => ({
    devUndefined: typeof AdaptiveClockDev === 'undefined',
    hooks: typeof AdaptiveClock._dev === 'object',
    clockNow: AdaptiveClock._dev.getClock().now.getTime(),
    isSim: AdaptiveClock._dev.getNow().isSim,
    bg: getComputedStyle(document.body).backgroundColor,
    moon: document.querySelectorAll('g.moon-tip').length
  }));
  check('prod: no AdaptiveClockDev global', st.devUndefined);
  check('prod: hooks object present', st.hooks);
  check('prod: hash #sim ignored, hands on wall time', Math.abs(st.clockNow - Date.now()) < 3000 && !st.isSim, new Date(st.clockNow).toISOString());
  check('prod: moon group drawn once', st.moon === 1, String(st.moon));
  await page.keyboard.press('Shift+S'); await page.keyboard.press('Shift+G'); await page.waitForTimeout(300);
  const overlays = await page.evaluate(() => ({ sim: !!document.querySelector('#sim-dt'), gal: !!document.querySelector('#yaclock-gallery') }));
  check('prod: Shift+S / Shift+G do nothing', !overlays.sim && !overlays.gal, JSON.stringify(overlays));
  const realErrors = errors.filter(e => !/favicon|ipapi|ipwho|open-meteo|net::ERR|Failed to load resource/.test(e));
  check('prod: no JS errors', realErrors.length === 0, realErrors.join(' | '));
  await page.screenshot({ path: `${OUT}/prod.png` });
  await page.close();
}

// ---------- DEV ----------
{
  const { page, errors } = await openPage(`http://localhost:${PORT}/dev/clock.html#sim=2026-08-12T17:46&speed=1&lat=64&lon=-22&weather=code:0,cloudCover:0.2`);
  const st = await page.evaluate(() => ({
    devDefined: typeof AdaptiveClockDev === 'object',
    simEnabled: AdaptiveClockDev.sim.enabled,
    clockNow: AdaptiveClock._dev.getClock().now.getTime(),
    prodNow: AdaptiveClock._dev.getNow().simTime.getTime(),
    isSim: AdaptiveClock._dev.getNow().isSim,
    overlay: !!document.querySelector('#sim-dt'),
    loc: AdaptiveClock._dev.internals.currentLocation(),
    hash: location.hash
  }));
  const target = new Date('2026-08-12T17:46').getTime();
  check('dev: harness attached, sim enabled from hash', st.devDefined && st.simEnabled && st.isSim);
  check('dev: hands follow sim time', Math.abs(st.clockNow - target) < 10000, new Date(st.clockNow).toISOString());
  check('dev: prod getNow sees sim time', Math.abs(st.prodNow - target) < 10000);
  check('dev: location override applied', st.loc.lat === 64 && st.loc.lon === -22, JSON.stringify(st.loc));
  check('dev: SIM overlay auto-opened', st.overlay);
  // jump to next full moon changes the datetime input
  const before = await page.inputValue('#sim-dt');
  await page.click('button[data-jump="full"]'); await page.waitForTimeout(300);
  const after = await page.inputValue('#sim-dt');
  check('dev: jump ●moon moves sim time', before !== after, `${before} -> ${after}`);
  // weather override in snap mode changes the inner fill immediately
  const fillBefore = await page.evaluate(() => AdaptiveClock._dev.getClock().handles.curveBasisClosed.attr('fill'));
  await page.selectOption('#sim-code', '63');
  await page.waitForTimeout(300);
  const fillAfter = await page.evaluate(() => AdaptiveClock._dev.getClock().handles.curveBasisClosed.attr('fill'));
  check('dev: weather code change snaps inner colour', fillBefore !== fillAfter, `${fillBefore} -> ${fillAfter}`);
  const glyph = async (k) => page.evaluate((k) => Number(document.getElementById('yaclock-wx-layer-' + k).getAttribute('opacity')), k);
  check('dev: rain glyphs appear for code 63', (await glyph('rain')) > 0.3 && (await glyph('snow')) === 0, `rain ${await glyph('rain')}`);
  await page.selectOption('#sim-code', '73'); await page.waitForTimeout(300);
  check('dev: snow glyphs replace rain for code 73', (await glyph('snow')) > 0.4 && (await glyph('rain')) === 0, `snow ${await glyph('snow')}`);
  await page.selectOption('#sim-code', '95'); await page.waitForTimeout(1300);
  await page.screenshot({ path: `${OUT}/dev-storm.png` });
  check('dev: thunderstorm shows rain + bolt', (await glyph('rain')) > 0.3 && (await glyph('bolt')) > 0.3, `bolt ${await glyph('bolt')}`);
  await page.selectOption('#sim-code', '63'); await page.waitForTimeout(300);
  // picking a code loads its typical cloud cover and precipitation into the sliders
  const sl = await page.evaluate(() => ({ cloud: Number(document.querySelector('#sim-cloud').value), precip: Number(document.querySelector('#sim-precip').value) }));
  check('dev: code 63 loads typical cloud 90 % / precip 2.5', sl.cloud === 90 && sl.precip === 2.5, JSON.stringify(sl));
  // light weather has fewer repetitions than heavy weather
  const tile = async () => page.evaluate(() => Number(document.getElementById('yaclock-wx-rain').getAttribute('width')));
  await page.selectOption('#sim-code', '61'); await page.waitForTimeout(300); const lightTile = await tile();
  await page.selectOption('#sim-code', '65'); await page.waitForTimeout(300); const heavyTile = await tile();
  check('dev: slight rain is much sparser than heavy rain', lightTile > heavyTile * 2, `tile ${lightTile.toFixed(1)} vs ${heavyTile.toFixed(1)} px`);
  const snowTile = async () => page.evaluate(() => Number(document.getElementById('yaclock-wx-snow').getAttribute('width')));
  await page.selectOption('#sim-code', '71'); await page.waitForTimeout(300); const lightSnow = await snowTile();
  await page.selectOption('#sim-code', '75'); await page.waitForTimeout(300); const heavySnow = await snowTile();
  check('dev: slight snow is sparser than heavy snow', lightSnow > heavySnow * 1.8, `tile ${lightSnow.toFixed(1)} vs ${heavySnow.toFixed(1)} px`);
  // hail appears only for hail codes
  await page.selectOption('#sim-code', '99'); await page.waitForTimeout(300);
  check('dev: code 99 shows hail', (await glyph('hail')) > 0.3, `hail ${await glyph('hail')}`);
  // cloud bank grows with cover
  const puffs = async () => page.evaluate(() => [...document.querySelectorAll('#yaclock-wx-layer-cloud > g')].filter(g => Number(g.getAttribute('opacity')) > 0.02).length);
  await page.selectOption('#sim-code', '1'); await page.waitForTimeout(300);
  await page.evaluate(() => { const e = document.querySelector('#sim-cloud'); e.value = 20; e.dispatchEvent(new Event('input')); }); await page.waitForTimeout(300);
  const few = await puffs();
  await page.evaluate(() => { const e = document.querySelector('#sim-cloud'); e.value = 100; e.dispatchEvent(new Event('input')); }); await page.waitForTimeout(300);
  const many = await puffs();
  check('dev: cloud bank grows with cloud cover', few >= 1 && many > few, `${few} -> ${many} clouds`);
  await page.selectOption('#sim-code', '63'); await page.waitForTimeout(300);
  const wxSeen = await page.evaluate(() => AdaptiveClock._dev.internals.currentWeather().code);
  check('dev: prod sees weather override', wxSeen === 63, String(wxSeen));
  // the time field follows the clock
  await page.selectOption('#sim-speed', '3600');
  const dt1 = await page.inputValue('#sim-dt'); await page.waitForTimeout(1600);
  const dt2 = await page.inputValue('#sim-dt');
  check('dev: time field follows the clock at 1 h/s', dt1 !== dt2, `${dt1} -> ${dt2}`);
  const lapse = await page.evaluate(() => AdaptiveClock._dev.getClock().options.transitionDuration);
  check('dev: time-lapse drives hands without transitions', lapse === 0, String(lapse));
  await page.selectOption('#sim-speed', '1');
  const real = await page.evaluate(() => AdaptiveClock._dev.getClock().options.transitionDuration);
  check('dev: real time restores hand transitions', real === 1000, String(real));
  // step button nudges sim time by exactly one day
  const t0 = await page.evaluate(() => AdaptiveClock._dev.getNow().simTime.getTime());
  await page.click('button[data-step="86400"]'); await page.waitForTimeout(200);
  const t1 = await page.evaluate(() => AdaptiveClock._dev.getNow().simTime.getTime());
  check('dev: +1 d step', Math.abs((t1 - t0) - 86400000) < 2000, String(t1 - t0));
  // "real weather" drops the override and the controls follow the live weather again
  await page.click('#sim-wx-clear'); await page.waitForTimeout(700);
  const wxSync = await page.evaluate(() => ({
    override: !!AdaptiveClockDev.sim.weatherOverride,
    live: AdaptiveClock._dev.internals.currentWeather().code,
    ui: Number(document.querySelector('#sim-code').value)
  }));
  check('dev: real weather resets controls to live values', !wxSync.override && wxSync.ui === wxSync.live, JSON.stringify(wxSync));
  // "prod location" drops the override; status says so
  await page.click('#sim-loc-clear'); await page.waitForTimeout(700);
  const locSt = await page.evaluate(() => ({ ov: !!AdaptiveClockDev.sim.locationOverride, txt: document.querySelector('#sim-loc-status').textContent }));
  check('dev: prod location drops the override', !locSt.ov && /^prod location:/.test(locSt.txt), locSt.txt);
  // smart place input (DMS with hemispheres)
  await page.fill('#sim-place', "64°09'N 21°56'W"); await page.press('#sim-place', 'Enter'); await page.waitForTimeout(300);
  const locDms = await page.evaluate(() => AdaptiveClock._dev.internals.currentLocation());
  check('dev: DMS place parsed', Math.abs(locDms.lat - 64.15) < 0.01 && Math.abs(locDms.lon + 21.933) < 0.01, JSON.stringify(locDms));
  // "now" returns to wall time while keeping sim on
  await page.click('#sim-now'); await page.waitForTimeout(300);
  const nowSt = await page.evaluate(() => ({ t: AdaptiveClock._dev.getClock().now.getTime(), sim: AdaptiveClockDev.sim.enabled }));
  check('dev: now button returns to wall time, sim stays on', Math.abs(nowSt.t - Date.now()) < 3000 && nowSt.sim, JSON.stringify(nowSt));
  // strokes flip to light ink on a dark page (midwinter night; place is Reykjavík here, where a June night stays golden) and back by day
  const inkL = async () => page.evaluate(() => {
    const m = /hsl\([\d.]+,[\d.]+%,([\d.]+)%\)/.exec(AdaptiveClock._dev.getClock().handles.curveNatural.attr('stroke'));
    return m ? Number(m[1]) : null;
  });
  await page.evaluate(() => AdaptiveClockDev.setSim({ enabled: true, simTime: new Date('2026-12-21T01:00') }));
  await page.waitForTimeout(300);
  const nightInk = await inkL();
  await page.screenshot({ path: `${OUT}/dev-night.png` });
  const nightPage = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.evaluate(() => AdaptiveClockDev.setSim({ enabled: true, simTime: new Date('2026-06-21T13:00') }));
  await page.waitForTimeout(300);
  const dayInk = await inkL();
  check('dev: light ink on the night page, dark ink by day', nightInk > 70 && dayInk < 20, `night ${nightInk}% on ${nightPage}, day ${dayInk}%`);
  const stateTxt = await page.textContent('#sim-state');
  check('dev: state readout rendered', /sun .*° .*moon \d+%/.test(stateTxt), stateTxt.replace(/\n/g, ' | '));
  await page.screenshot({ path: `${OUT}/dev-sim.png` });
  await page.keyboard.press('Shift+G'); await page.waitForTimeout(800);
  const gal = await page.evaluate(() => {
    const g = document.querySelector('#yaclock-gallery');
    return { present: !!g, cells: g ? g.querySelectorAll('svg').length : 0, expected: AdaptiveClockDev.scenarios.length };
  });
  check('dev: gallery shows one cell per scenario', gal.present && gal.cells === gal.expected && gal.expected >= 20, JSON.stringify(gal));
  await page.screenshot({ path: `${OUT}/dev-gallery.png` });
  await page.evaluate(() => { const g = document.querySelector('#yaclock-gallery'); g.scrollTop = g.scrollHeight; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/dev-gallery-bottom.png` });
  await page.keyboard.press('Escape'); await page.keyboard.press('Shift+S'); await page.waitForTimeout(500);
  const off = await page.evaluate(() => ({
    simEnabled: AdaptiveClockDev.sim.enabled, isSim: AdaptiveClock._dev.getNow().isSim,
    clockNow: AdaptiveClock._dev.getClock().now.getTime(), hash: location.hash
  }));
  check('dev: Shift+S off returns to wall time and clears hash', !off.simEnabled && !off.isSim && Math.abs(off.clockNow - Date.now()) < 3000 && off.hash === '', JSON.stringify(off));
  const realErrors = errors.filter(e => !/favicon|ipapi|ipwho|open-meteo|net::ERR|Failed to load resource/.test(e));
  check('dev: no JS errors', realErrors.length === 0, realErrors.join(' | '));
  await page.close();
}

await browser.close(); server.close();
for (const r of results) console.log(r.join('  '));
console.log(`screenshots: ${OUT}`);
process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
