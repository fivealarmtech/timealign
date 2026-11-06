const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.resolve(__dirname, '../dist/TimeAlign.html'));
  await page.click('#roleSeg button[data-role=listen]');
  await page.click('#presetBtn');
  await page.setInputFiles('#fileIn', path.join(__dirname, 'sim_recording.wav'));
  await page.waitForFunction(() => window.__TA_APP.snaps.length > 0, null, { timeout: 120000 });
  await page.click('#plotSeg button[data-p=sub]');
  const el = await page.$('#cardResults'); await el.screenshot({ path: path.join(__dirname, 'shot_mobile.png') });
  await browser.close();
})();
