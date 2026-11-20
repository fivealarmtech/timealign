'use strict';
// Drives the app's NATIVE code path with a JS mock of the Swift Core Audio bridge.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const MOCK = () => {
  const FS = 48000, P = 32768, CH = 2048;
  const ROOM = { 1: [12.0, 1.0], 2: [13.5, 0.8], 3: [16.25, 0.9], 4: [3.1, 0.6], 5: [5.4, 0.4] };   // out ch -> [ms, gain]
  const st = { seq: {}, routes: {}, events: {}, gain: {}, ramp: {}, frame: 0, open: false, hist: {}, log: [], pending: [], phone: [] };
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
    if (st.remote) {
      const pcm = new Int16Array(CH); for (let k = 0; k < CH; k++) pcm[k] = Math.max(-32767, Math.min(32767, Math.round(mic[k] * 32767)));
      const u8 = new Uint8Array(pcm.buffer); let s2 = ''; for (let i = 0; i < u8.length; i += 0x8000) s2 += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      st.pending.push([f0 + 5000000, btoa(s2)]);
      if (st.pending.length >= 4) { const batch = st.pending.splice(0); setTimeout(() => batch.forEach(([f, d]) => window.__native.onRemote(f, d, '192.168.1.42')), 300); }
      return;
    }
    window.__native.onChunk(f0 + 777, b64(mic), b64(mic), st.frame);
  }
  window.webkit = { messageHandlers: { ta: { postMessage(o) {
    st.log.push(o.cmd);
    if (o.cmd === 'devices') setTimeout(() => window.__native.onDevices([
      { uid: 'mbp-spk', name: 'MacBook Pro Speakers', inCh: 0, outCh: 2, rate: 48000 },
      { uid: 'mbp-mic', name: 'MacBook Pro Microphone', inCh: 1, outCh: 0, rate: 48000 },
      { uid: 'dvs', name: 'Dante Virtual Soundcard', inCh: 64, outCh: 64, rate: 48000 }], ['mbp-spk', 'mbp-mic']), 10);
    if (o.cmd === 'open') { st.open = true; st.openMsg = o; st.remote = o.in === 'remote'; if (!st.timer) st.timer = setInterval(render, 1000 * CH / FS);
      const qr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      if (window.__failOutput) { setTimeout(() => window.__native.onOpen({ ok: false, error: 'The output device is no longer available. Press Refresh.' }), 10); return; }
      setTimeout(() => window.__native.onOpen(st.remote
        ? { ok: true, outCh: 64, inCh: 1, outName: 'Dante Virtual Soundcard', inName: 'iPhone (live over Wi-Fi)', micCh: 1, remote: true, url: 'https://192.168.1.20:8443/?k=abc', setupUrl: 'http://192.168.1.20:8080/', qr, qrSetup: qr }
        : { ok: true, outCh: o.out ? 64 : 0, inCh: 64, outName: 'Dante Virtual Soundcard', inName: 'Dante Virtual Soundcard', micCh: o.micCh }), 10); }
    if (o.cmd === 'phoneStatus') st.phone.push(o.text);
    if (o.cmd === 'remoteInfo') setTimeout(() => window.__native.onRemoteInfo({ ok: true, url: 'https://192.168.1.20:8443/?k=abc', setupUrl: 'http://192.168.1.20:8080/', qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', qrSetup: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' }), 50);
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
  for (const fail of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(MOCK);
    if (fail) await page.addInitScript(() => { window.__failOutput = true; });
    await page.addInitScript(() => { window.__TA_VERSION = '2.0.7'; });
    await page.goto('file://' + path.resolve(__dirname, '../dist/TimeAlign.html'));
    await page.evaluate(() => localStorage.clear()); await page.reload();
    console.log(`--- ${fail ? 'Dante output missing' : 'normal'} ---`);
    console.log('iPhone button visible:', await page.isVisible('#phoneBtn'), '| header:', await page.evaluate(() => document.querySelector('.brand small').textContent));
    await page.click('#phoneBtn');
    await page.waitForTimeout(2500);
    console.log('QR panel visible:', await page.isVisible('#remotePanel'), '| QR img visible:', await page.isVisible('#qrLive'), '| url:', await page.evaluate(() => document.querySelector('#urlLive').textContent));
    console.log('input selected:', await page.evaluate(() => document.querySelector('#inSel').value), '| inline error:', JSON.stringify(await page.evaluate(() => document.querySelector('#audioErr').hidden ? '' : document.querySelector('#audioErr').textContent)));
    console.log('remote state:', await page.evaluate(() => document.querySelector('#remoteState').innerText), '| errors:', errs);
    if (!fail) await page.screenshot({ path: path.join(__dirname, 'shot_button.png'), clip: { x: 0, y: 0, width: 640, height: 820 } });
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
