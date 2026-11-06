const { chromium } = require('/opt/node22/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('file://' + require('path').resolve(__dirname, '../dist/TimeAlign.html'));
  console.log('file:// isSecureContext', await page.evaluate(() => isSecureContext), 'mediaDevices', await page.evaluate(() => !!navigator.mediaDevices));
  await page.click('#startBtn');
  await page.waitForFunction(() => !document.querySelector('#audioCfg').hidden || /bad/.test(document.querySelector('#progTxt').className), null, { timeout: 60000 });
  console.log('engine:', await page.evaluate(() => document.querySelector('#ctxInfo').innerText), '| status:', await page.evaluate(() => document.querySelector('#progTxt').innerText));
  console.log('errors', errs); await browser.close();
})();
