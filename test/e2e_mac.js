'use strict';
// Mac mode: the app plays its own sequence; a simulated room (DelayNode + gain per speaker)
// feeds the app's capture node instead of the microphone.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const dist = path.join(__dirname, '..', 'dist');
const srv = http.createServer((q, r) => { fs.readFile(path.join(dist, q.url.split('?')[0]), (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': 'text/html' }); r.end(d); } }); });
const ROOM = { 1: [12.0, 1.0], 2: [13.5, 0.8], 3: [16.25, 0.9], 4: [3.1, 0.6], 5: [5.4, 0.4] };   // ms, gain
(async () => {
  await new Promise((r) => srv.listen(8766, r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto('http://localhost:8766/TimeAlign.html');
  await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.click('#presetBtn');
  await page.selectOption('#speed', '4');
  await page.click('#startBtn');
  await page.waitForFunction(() => !document.querySelector('#audioCfg').hidden, null, { timeout: 60000 });
  console.log('ctx:', await page.evaluate(() => document.querySelector('#ctxInfo').innerText), '|', await page.evaluate(() => document.querySelector('#outInfo').innerText));
  // all zones onto channels 1/2 (headless output has 2 ch); sub on 1 is fine, routing is tapped per speaker
  await page.evaluate(() => { const A = window.__TA_APP; A.S.zones.forEach((z, i) => { z.ch = String(1 + (i % 2)); }); });
  const wire = async (manualPaths) => page.evaluate(([ROOM, manualPaths]) => {
    const A = window.__TA_APP, E = A.E, ctx = E.ctx;
    try { E.micSrc.disconnect(); } catch (e) {}
    const mix = ctx.createGain(); mix.channelCount = 2; mix.channelCountMode = 'explicit'; mix.channelInterpretation = 'discrete';
    window.__paths = {};
    for (const [id, [ms, g]] of Object.entries(ROOM)) {
      const d = ctx.createDelay(1); d.delayTime.value = ms / 1000;
      const gn = ctx.createGain(); gn.gain.value = manualPaths ? 0 : g;
      (manualPaths ? E.srcs.get(0) : E.srcs.get(+id)).g.connect(d); d.connect(gn); gn.connect(mix);
      window.__paths[id] = [gn, g];
    }
    // a little room noise
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const ch = nb.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.002;
    const ns = ctx.createBufferSource(); ns.buffer = nb; ns.loop = true; ns.connect(mix); ns.start();
    mix.connect(E.cap);
  }, [ROOM, manualPaths]);
  await wire(false);
  await page.click('#measureBtn');
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(2500);
    const st = await page.evaluate(() => { const A = window.__TA_APP; return `t=${A.E.ctx.currentTime.toFixed(2)} status="${document.querySelector('#progTxt').innerText}" live="${document.querySelector('#liveInfo').innerText}" blocks=${A.sess.blocks ? A.sess.blocks.length : '-'} kind=${A.sess.kind} snaps=${A.snaps.length}`; });
    console.log(st);
    if (st.includes('snaps=1')) break;
  }
  const dump = () => page.evaluate(() => { const p = window.__TA_APP.computePlan(); return p ? p.rows.map((r) => `${r.cfg.name}: rel ${r.rel.toFixed(3)} set ${r.setTo == null ? '-' : r.setTo.toFixed(2)} n${r.z.n}`).join(' | ') + ` | ppm ${window.__TA_APP.snaps.at(-1).sol.ppm.toFixed(2)}` : document.querySelector('#progTxt').innerText; });
  console.log('AUTO  truth rel: L 0, R 1.5, Sub 4.25, D1 -8.9, D2 -6.6');
  console.log('AUTO  result   :', await dump());
  await page.screenshot({ path: path.join(__dirname, 'shot_mac.png'), fullPage: true });
  // ---------- manual mode: one noise feed, "console" un-mutes one path at a time
  await page.click('#clearRes');
  await page.click('#modeSeg button[data-mode=manual]');
  await page.click('#startBtn');   // restart engine (fresh graph)
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const A = window.__TA_APP; A.S.manCh = '1'; });
  await wire(true);
  await page.click('#manNoise');
  for (const id of [1, 4, 2]) {
    await page.evaluate((id) => { for (const [k, [gn, g]] of Object.entries(window.__paths)) gn.gain.value = (+k === id) ? g : 0; }, id);
    await page.click(`#manZones button[data-id="${id}"]`);
    await page.click('#captureBtn');
    await page.waitForFunction(() => !document.querySelector('#captureBtn').disabled, null, { timeout: 30000 });
  }
  console.log('MANUAL truth rel: L 0, R 1.5, D1 -8.9');
  console.log('MANUAL result   :', await dump());
  console.log('live readout    :', await page.evaluate(() => document.querySelector('#liveDelay').innerText + ' / ' + document.querySelector('#liveInfo').innerText));
  await page.click('#stopBtn');
  console.log('errors:', errs);
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
