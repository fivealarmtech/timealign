'use strict';
// Drives the app's NATIVE code path with a JS mock of the Swift Core Audio bridge.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const MOCK = () => {
  const FS = 48000, P = 32768, CH = 2048;
  const ROOM = { 1: [12.0, 1.0], 2: [13.5, 0.8], 3: [16.25, 0.9], 4: [3.1, 0.6], 5: [5.4, 0.4] };   // out ch -> [ms, gain]
  const st = { seq: {}, routes: {}, events: {}, gain: {}, ramp: {}, frame: 0, open: false, hist: {}, log: [] };
  const HL = 1 << 16;
  for (const c of Object.keys(ROOM)) st.hist[c] = new Float32Array(HL);
  const b64 = (f) => { const u8 = new Uint8Array(f.buffer); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Float32Array(u.buffer); };
  function render() {
    const mic = new Float32Array(CH);
    const out = {}; for (const c of Object.keys(ROOM)) out[c] = new Float32Array(CH);
    for (const id of Object.keys(st.seq)) {
      const s = st.seq[id], ev = st.events[id] || (st.events[id] = []);
      let g = st.gain[id] || 0, r = st.ramp[id];
      for (let k = 0; k < CH; k++) {
        const f = st.frame + k;
        while (ev.length && ev[0].frame <= f) { const e = ev.shift(); if (e.ramp > 0) r = { from: g, to: e.target, pos: 0, len: e.ramp }; else { g = e.target; r = null; } }
        if (r) { r.pos++; if (r.pos >= r.len) { g = r.to; r = null; } else g = r.from + (r.to - r.from) * r.pos / r.len; }
        if (g) { const v = s[f % P] * g; for (const c of (st.routes[id] || [])) if (out[c]) out[c][k] += v; }
      }
      st.gain[id] = g; st.ramp[id] = r;
    }
    for (const [c, [ms, a]] of Object.entries(ROOM)) {
      const h = st.hist[c], d = Math.round(ms * 48);
      for (let k = 0; k < CH; k++) { const f = st.frame + k; h[f % HL] = out[c][k]; mic[k] += a * h[(f - d + HL * 4) % HL]; }
    }
    for (let k = 0; k < CH; k++) mic[k] += (Math.random() * 2 - 1) * 0.002;
    const f0 = st.frame; st.frame += CH;
    window.__native.onChunk(f0 + 777, b64(mic), b64(mic), st.frame);
  }
  window.webkit = { messageHandlers: { ta: { postMessage(o) {
    st.log.push(o.cmd);
    if (o.cmd === 'devices') setTimeout(() => window.__native.onDevices([
      { uid: 'mbp-spk', name: 'MacBook Pro Speakers', inCh: 0, outCh: 2, rate: 48000 },
      { uid: 'mbp-mic', name: 'MacBook Pro Microphone', inCh: 1, outCh: 0, rate: 48000 },
      { uid: 'dvs', name: 'Dante Virtual Soundcard', inCh: 64, outCh: 64, rate: 48000 }], ['mbp-spk', 'mbp-mic']), 10);
    if (o.cmd === 'open') { st.open = true; st.openMsg = o; if (!st.timer) st.timer = setInterval(render, 1000 * CH / FS); setTimeout(() => window.__native.onOpen({ ok: true, outCh: o.out ? 64 : 0, inCh: 64, outName: 'Dante Virtual Soundcard', inName: 'Dante Virtual Soundcard', micCh: o.micCh }), 10); }
    if (o.cmd === 'seq') st.seq[o.id] = unb64(o.data);
    if (o.cmd === 'route') st.routes[o.id] = o.chans;
    if (o.cmd === 'gate') { (st.events[o.id] = st.events[o.id] || []).push({ frame: o.frame < 0 ? 0 : o.frame, target: o.target, ramp: o.ramp }); st.events[o.id].sort((a, b) => a.frame - b.frame); }
    if (o.cmd === 'stopAll') { for (const id of Object.keys(st.seq)) { st.events[id] = []; st.events[id].push({ frame: 0, target: 0, ramp: 1440 }); } }
    if (o.cmd === 'copy') st.copied = o.text;
  } } } };
  window.__mock = st;
};
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.addInitScript(MOCK);
  await page.goto('file://' + path.resolve(__dirname, '../dist/TimeAlign.html'));
  await page.evaluate(() => localStorage.clear()); await page.reload();
  console.log('NATIVE detected:', await page.evaluate(() => window.__TA_APP.NATIVE));
  await page.click('#presetBtn');
  await page.selectOption('#speed', '4');
  await page.click('#startBtn');
  await page.waitForFunction(() => !document.querySelector('#audioCfg').hidden, null, { timeout: 30000 });
  console.log('outputs offered:', await page.evaluate(() => [...document.querySelectorAll('#outSel option')].map((o) => o.textContent + (o.selected ? ' [selected]' : '')).join(' | ')));
  console.log('inputs offered :', await page.evaluate(() => [...document.querySelectorAll('#inSel option')].map((o) => o.textContent + (o.selected ? ' [selected]' : '')).join(' | ')));
  await page.selectOption('#inSel', 'dvs');
  await page.waitForTimeout(800);
  console.log('mic channel choices:', await page.evaluate(() => document.querySelectorAll('#micCh option').length), '| info:', await page.evaluate(() => document.querySelector('#ctxInfo').innerText), '| devMsg hidden:', await page.evaluate(() => document.querySelector('#devMsg').hidden));
  await page.click('#measureBtn');
  await page.waitForFunction(() => window.__TA_APP.snaps.length > 0, null, { timeout: 120000 });
  const dump = () => page.evaluate(() => { const p = window.__TA_APP.computePlan(); return p.rows.map((r) => `${r.cfg.name}: rel ${r.rel.toFixed(3)} set ${r.setTo == null ? '-' : r.setTo.toFixed(2)}`).join(' | '); });
  console.log('AUTO  truth rel: L 0, R 1.5, Sub 4.25, D1 -8.9, D2 -6.6');
  console.log('AUTO  result   :', await dump());
  await page.click('#copyRes');
  console.log('copy via native:', await page.evaluate(() => (window.__mock.copied || '').split('\n')[0]));
  // manual mode through the native path
  await page.click('#clearRes');
  await page.click('#modeSeg button[data-mode=manual]');
  await page.fill('#manCh', '1'); await page.dispatchEvent('#manCh', 'input');
  await page.click('#manNoise');
  // simulate console mutes by re-routing the manual noise to one speaker channel at a time
  for (const [id, ch] of [[1, 1], [4, 4]]) {
    await page.evaluate((ch) => { window.__mock.routes[0] = [ch]; }, ch);
    await page.waitForTimeout(800);
    await page.click(`#manZones button[data-id="${id}"]`);
    await page.click('#captureBtn');
    await page.waitForFunction(() => !document.querySelector('#captureBtn').disabled, null, { timeout: 30000 });
  }
  console.log('MANUAL truth: D1 vs L -8.9 → set 13.90');
  console.log('MANUAL result:', await dump());
  await page.click('#stopBtn');
  console.log('messages:', [...new Set(await page.evaluate(() => window.__mock.log))].join(','), '| errors:', errs);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
