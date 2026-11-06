'use strict';
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const dist = path.join(__dirname, '..', 'dist');
const srv = http.createServer((q, r) => { const f = path.join(dist, decodeURIComponent(q.url.split('?')[0])); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': 'text/html' }); r.end(d); } }); });
(async () => {
  await new Promise((r) => srv.listen(8765, r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(__dirname, 'sim_recording.wav')}`, '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('http://localhost:8765/TimeAlign.html');
  console.log('secure context:', await page.evaluate(() => isSecureContext));
  // ---------- Test A: import the recording (file path)
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.click('#presetBtn');
  // only 4 zones in the sim: remove "Delay 2"
  await page.evaluate(() => { const A = window.__TA_APP; A.S.zones.splice(4, 1); });
  await page.click('#presetBtn'); // re-render with preset (5 zones) - fine, zone 5 just won't be detected
  await page.setInputFiles('#fileIn', path.join(__dirname, 'sim_recording.wav'));
  await page.waitForFunction(() => window.__TA_APP.snaps.length > 0, null, { timeout: 120000 });
  const res = await page.evaluate(() => {
    const p = window.__TA_APP.computePlan();
    return { ref: p.refId, mainAdd: p.mainAdd, rows: p.rows.map((r) => ({ id: r.id, name: r.cfg.name, rel: +r.rel.toFixed(3), add: r.add == null ? null : +r.add.toFixed(2), setTo: r.setTo == null ? null : +r.setTo.toFixed(2), pol: r.pol, n: r.z.n, snr: +r.z.snrDb.toFixed(1) })),
      ppm: window.__TA_APP.snaps[0].sol.ppm, todo: document.querySelector('#todo').innerText, notes: document.querySelector('#notes').innerText, status: document.querySelector('#progTxt').innerText };
  });
  console.log('A) file import:', JSON.stringify(res, null, 1));
  await page.screenshot({ path: path.join(__dirname, 'shot_file.png'), fullPage: true });
  // ---------- Test B: live listen-only (phone role) with the fake mic playing the recording
  await page.click('#roleSeg button[data-role=listen]');
  await page.click('#clearRes');
  await page.click('#startBtn');
  await page.waitForFunction(() => !document.querySelector('#audioCfg').hidden, null, { timeout: 60000 });
  console.log('B) ctx info:', await page.evaluate(() => document.querySelector('#ctxInfo').innerText));
  await page.click('#listenBtn');
  const t0 = Date.now();
  await page.waitForFunction(() => window.__TA_APP.snaps.length > 0, null, { timeout: 90000 }).catch(() => {});
  const res2 = await page.evaluate(() => {
    const p = window.__TA_APP.computePlan();
    if (!p) return { status: document.querySelector('#progTxt').innerText };
    return { rows: p.rows.map((r) => ({ name: r.cfg.name, rel: +r.rel.toFixed(3), setTo: r.setTo == null ? null : +r.setTo.toFixed(2), pol: r.pol, n: r.z.n })), mainAdd: p.mainAdd, ppm: window.__TA_APP.snaps[0].sol.ppm, status: document.querySelector('#progTxt').innerText };
  });
  console.log('B) live listen (', ((Date.now() - t0) / 1000).toFixed(1), 's):', JSON.stringify(res2, null, 1));
  await page.screenshot({ path: path.join(__dirname, 'shot_listen.png'), fullPage: true });
  console.log('errors:', errs);
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
