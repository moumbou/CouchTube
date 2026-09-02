// Renders brand assets (icons, lockup, promo tiles) from SVG/HTML with headless Chromium.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BRAND = path.resolve(__dirname, '..');
const EXT_ICONS = path.resolve(__dirname, '..', '..', '..', 'apps', 'extension', 'icons');
const WEBSITE_ASSETS = path.resolve(__dirname, '..', '..', '..', 'apps', 'website', 'assets');
const mark = fs.readFileSync(path.join(BRAND, 'logo-mark.svg'), 'utf8');

const page = (body, w, h, extraCss = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent}
  body{font-family:Poppins,system-ui,sans-serif}
  ${extraCss}
</style></head><body>${body}</body></html>`;

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const shot = async (html, w, h, file, transparent = true) => {
    const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await p.setContent(html);
    await p.waitForTimeout(150);
    await p.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
    await p.close();
    console.log('wrote', path.relative(process.cwd(), file));
  };

  // 1. extension icons + store icon (128) from the mark
  for (const s of [16, 32, 48, 128, 256, 512]) {
    const svg = mark.replace('width="128" height="128"', `width="${s}" height="${s}"`);
    const dest = s <= 128 && [16, 48, 128].includes(s) ? path.join(EXT_ICONS, `icon${s}.png`) : path.join(BRAND, `mark-${s}.png`);
    await shot(page(svg, s, s), s, s, dest);
    if (s === 128) await shot(page(svg, s, s), s, s, path.join(BRAND, 'mark-128.png'));
  }

  // 2. lockup (mark + wordmark), dark and light
  const lockup = (dark) => page(`
    <div style="display:flex;align-items:center;gap:22px;height:120px;padding:0 10px">
      ${mark.replace('width="128" height="128"', 'width="96" height="96"')}
      <div style="font-weight:700;font-size:62px;letter-spacing:-1.5px;color:${dark ? '#fff' : '#111'};line-height:1">Couch<span style="color:#ff5a45">Tube</span></div>
    </div>`, 520, 120);
  await shot(lockup(true), 520, 120, path.join(BRAND, 'lockup-dark.png'));
  await shot(lockup(false), 520, 120, path.join(BRAND, 'lockup-light.png'));

  // 3. Chrome Web Store promo tiles: small 440x280, marquee 1400x560
  const tile = (w, h, big) => page(`
    <div style="width:${w}px;height:${h}px;background:radial-gradient(120% 120% at 0% 0%, #2a1a1a 0%, #0f0f0f 60%);display:flex;align-items:center;justify-content:center;gap:${big ? 56 : 28}px;color:#fff">
      ${mark.replace('width="128" height="128"', `width="${big ? 200 : 110}" height="${big ? 200 : 110}"`)}
      <div>
        <div style="font-weight:700;font-size:${big ? 72 : 40}px;letter-spacing:-1.5px;line-height:1">Couch<span style="color:#ff5a45">Tube</span></div>
        <div style="font-size:${big ? 30 : 17}px;color:#bdbdbd;margin-top:${big ? 18 : 8}px;font-weight:500">Your phone, the remote for YouTube<br>on your computer. Scan a QR. Done.</div>
      </div>
    </div>`, w, h);
  await shot(tile(440, 280, false), 440, 280, path.join(BRAND, 'store-tile-440x280.png'), false);
  await shot(tile(1400, 560, true), 1400, 560, path.join(BRAND, 'store-marquee-1400x560.png'), false);

  // website assets: favicon + OG image source
  fs.copyFileSync(path.join(BRAND, 'logo-mark.svg'), path.join(WEBSITE_ASSETS, 'logo.svg'));
  fs.copyFileSync(path.join(BRAND, 'mark-512.png'), path.join(WEBSITE_ASSETS, 'og-mark.png'));
  console.log('copied logo.svg + og-mark.png to apps/website/assets');
  await browser.close();
})();
