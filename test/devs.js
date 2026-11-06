const { chromium } = require('/opt/node22/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage();
  await page.goto('file://' + require('path').resolve(__dirname, '../dist/TimeAlign.html'));
  await page.click('#startBtn');
  await page.waitForFunction(() => !document.querySelector('#audioCfg').hidden, null, { timeout: 60000 });
  console.log(await page.evaluate(async () => ({
    outOptions: [...document.querySelectorAll('#outSel option')].map((o) => o.textContent),
    inOptions: [...document.querySelectorAll('#inSel option')].map((o) => o.textContent),
    raw: (await navigator.mediaDevices.enumerateDevices()).map((d) => d.kind + ':' + (d.label || '(no label)')),
  })));
  await browser.close();
})();
