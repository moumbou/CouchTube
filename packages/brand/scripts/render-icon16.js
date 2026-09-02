const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const BRAND = path.resolve(__dirname, '..');
// simplified mark for tiny sizes: no legs, no seam, bigger play triangle
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="16" height="16"><defs><linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="128" y2="128"><stop offset="0" stop-color="#ff4d4d"/><stop offset="1" stop-color="#ff7a3d"/></linearGradient></defs><rect width="128" height="128" rx="30" fill="url(#bg)"/><g fill="#fff"><rect x="26" y="26" width="76" height="52" rx="14"/><rect x="8" y="60" width="22" height="42" rx="10"/><rect x="98" y="60" width="22" height="42" rx="10"/><rect x="18" y="74" width="92" height="28" rx="10"/></g><path d="M52 38 L52 66 L80 52 Z" fill="url(#bg)"/></svg>`;
fs.writeFileSync(path.join(BRAND, 'logo-mark-small.svg'), svg.replace('width="16" height="16"', 'width="128" height="128"'));
(async () => {
  const b = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const p = await b.newPage({ viewport: { width: 16, height: 16 } });
  await p.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}</style>${svg}`);
  await p.screenshot({ path: path.resolve(__dirname, '..', '..', '..', 'apps', 'extension', 'icons', 'icon16.png'), omitBackground: true, clip: { x: 0, y: 0, width: 16, height: 16 } });
  await b.close(); console.log('icon16 done');
})();
