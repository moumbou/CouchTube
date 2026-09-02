// Packs the extension into dist/couchtube-extension-<version>.zip for the Chrome Web Store / Edge Add-ons.
// Only ships what the browser needs: manifest, scripts, popup, icons, vendor.
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const OUT_DIR = path.resolve(ROOT, '..', '..', 'dist');
const OUT = path.join(OUT_DIR, `couchtube-extension-${manifest.version}.zip`);

const INCLUDE = ['manifest.json', 'background.js', 'content.js', 'bridge.js', 'popup.html', 'popup.js', 'icons', 'vendor'];

fs.mkdirSync(OUT_DIR, { recursive: true });
const zip = new AdmZip();
for (const entry of INCLUDE) {
  const full = path.join(ROOT, entry);
  if (fs.statSync(full).isDirectory()) zip.addLocalFolder(full, entry);
  else zip.addLocalFile(full);
}
zip.writeZip(OUT);
console.log(`Extension v${manifest.version} packed -> ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
