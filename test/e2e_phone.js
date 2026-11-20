'use strict';
// Phone page (native/mic.html) against a mock of the Mac's HTTPS server.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const https = require('https'), fs = require('fs'), path = require('path');
const TA = require('../src/dsp.js');
const page = fs.readFileSync('/home/claude/timealign/native/mic.html');
const got = []; let posts = 0, badKey = 0;
const srv = https.createServer({ key: fs.readFileSync('/tmp/certtest/leaf.key'), cert: fs.readFileSync('/tmp/certtest/leaf.crt') }, (q, r) => {
  const u = new URL(q.url, 'https://x');
  if (q.method === 'GET' && u.pathname === '/') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end(page); }
  if (q.method === 'POST' && u.pathname === '/audio') {
    if (u.searchParams.get('k') !== 'TOKEN123') { badKey++; r.writeHead(403); return r.end(); }
    const parts = []; q.on('data', (d) => parts.push(d)); q.on('end', () => {
      const b = Buffer.concat(parts); posts++;
      got.push({ f: +u.searchParams.get('f'), pcm: new Int16Array(b.buffer, b.byteOffset, b.length / 2).slice() });
      r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ ok: true, status: 'Playing 2/5: Main R · live −1.23 ms' }));
    }); return;
  }
  r.writeHead(404); r.end();
});
(async () => {
  await new Promise((res) => srv.listen(8443, res));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: [
    '--ignore-certificate-errors', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(__dirname, 'sim_recording.wav')}`] });
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('https://localhost:8443/?k=TOKEN123');
  await p.click('#go');
  await p.waitForTimeout(40000);
  const ui = await p.evaluate(() => ({ mac: document.getElementById('mac').textContent, net: document.getElementById('net').textContent, lvl: document.getElementById('lvl').textContent, err: document.getElementById('err').textContent }));
  await p.screenshot({ path: path.join(__dirname, 'shot_phone.png') });
  await browser.close(); srv.close();
  // contiguity + analysis of what the "Mac" received
  got.sort((a, b) => a.f - b.f);
  let gaps = 0; for (let i = 1; i < got.length; i++) if (got[i].f !== got[i - 1].f + got[i - 1].pcm.length) gaps++;
  const total = got.reduce((s, g) => s + g.pcm.length, 0);
  console.log(`posts ${posts}, frames ${total} (${(total / 48000).toFixed(1)} s), gaps ${gaps}, bad key ${badKey}`);
  console.log('phone UI:', JSON.stringify(ui), 'errors:', errs);
  const an = new TA.Analyzer({ candidates: Array.from({ length: 17 }, (_, i) => i) });
  const blocks = []; let lastId = null, lastS = -1e15;
  for (const g of got) {
    const f32 = Float32Array.from(g.pcm, (v) => v / 32767);
    for (const b of an.push(f32, null, g.f)) {
      const runStart = b.id !== lastId || b.s - lastS > TA.HOP * 1.5; lastId = b.ok ? b.id : null; lastS = b.s;
      if (b.ok && b.id && !runStart) { b.label = b.id; blocks.push(b); }
    }
  }
  const sol = TA.solve(blocks);
  if (!sol) { console.log('no solution'); return; }
  const R = sol.zones.get(1);
  console.log('Mac-side analysis of the streamed audio (truth: Main R +1.650, Subs ≈+3.8, Delay 1 −13.880):');
  for (const [id, z] of sol.zones) console.log(`  zone ${id}: ${((z.T - R.T) / 48).toFixed(3)} ms, blocks ${z.n}`);
  console.log('  clock drift', sol.ppm.toFixed(1), 'ppm');
})().catch((e) => { console.error(e); process.exit(1); });
