// dev/icons.mjs — renders every app icon (PWA, Android launcher, store listing) and the store screenshots
// from fav.html itself.
// Usage (from repo root):  npx -y -p playwright@1.58.1 -c "node dev/icons.mjs"
// The clock is frozen at 10:10:30 so each run produces identical icons. Commit the results.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const pathDirs = (process.env.PATH || '').split(path.delimiter)
  .filter(d => d.endsWith(path.join('node_modules', '.bin'))).map(d => path.dirname(d));
let playwright;
try { playwright = require(require.resolve('playwright', { paths: [process.cwd(), ...pathDirs] })); }
catch { console.error('playwright not found. Run:  npx -y -p playwright@1.58.1 -c "node dev/icons.mjs"'); process.exit(2); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = 'android/app/src/main/res';
// scale: share of the icon edge the clock square fills. The dial's outer ring sits at 155/400 of that square,
// so 1.0 already fits a maskable icon's 40% safe circle; Android adaptive foregrounds need about 0.78 (33/108 radius).
const ICONS = [
  { file: 'icons/icon-512.png', size: 512, scale: 1 },
  { file: 'icons/icon-192.png', size: 192, scale: 1 },
  { file: 'icons/apple-touch-icon.png', size: 180, scale: 0.92 },
  { file: 'icons/icon-maskable-512.png', size: 512, scale: 0.9 },
  { file: 'fastlane/metadata/android/en-US/images/icon.png', size: 512, scale: 1 },
  ...[['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]
    .map(([d, size]) => ({ file: `${RES}/mipmap-${d}/ic_launcher.png`, size, scale: 1 })),
  { file: `${RES}/drawable-nodpi/ic_launcher_foreground.png`, size: 432, scale: 0.75, transparent: true },
];
// Store screenshots keep the page untouched: phone portrait and tablet landscape, at device pixel ratio.
const SHOTS = [
  { file: 'fastlane/metadata/android/en-US/images/phoneScreenshots/1.png', width: 360, height: 780, dpr: 3 },
  { file: 'fastlane/metadata/android/en-US/images/tenInchScreenshots/1.png', width: 1280, height: 800, dpr: 2 },
];

const browser = await playwright.chromium.launch();
async function open(width, height, dpr = 1) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  await page.clock.setFixedTime(new Date(2026, 0, 1, 10, 10, 30));
  await page.goto(pathToFileURL(path.join(ROOT, 'fav.html')).href);
  return page;
}
async function shoot(page, file, transparent) {
  await page.waitForTimeout(1500); // let the 1 s d3 transitions settle
  const out = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, omitBackground: !!transparent });
  await page.close();
  console.log('wrote', file);
}
for (const icon of ICONS) {
  const page = await open(icon.size, icon.size);
  const edge = `${icon.scale * 100}vmin`;
  // Strokes are 1 unit of a 400-unit viewBox, which vanishes at launcher sizes: aim for ~size/170 px, min 1.5 px.
  const stroke = Math.max(1.5, icon.size / 170) * 400 / (icon.size * icon.scale);
  await page.addStyleTag({ content: `.square { width: ${edge} !important; height: ${edge} !important; }`
    + ` svg path, svg circle { stroke-width: ${stroke.toFixed(2)}px; }`
    + (icon.transparent ? ' body { background: transparent !important; }' : '') });
  await shoot(page, icon.file, icon.transparent);
}
for (const shot of SHOTS) await shoot(await open(shot.width, shot.height, shot.dpr), shot.file);
await browser.close();
