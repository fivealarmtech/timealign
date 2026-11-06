'use strict';
const TA = require('../src/dsp.js'); const S = require('./sim.js'); const { FS, P } = TA;
const ids = Array.from({ length: 17 }, (_, i) => i);
const an = new TA.Analyzer({ candidates: ids, minSnr: -99, minMargin: -99 });
// white noise, then pink-ish LF rumble (crowd/HVAC), then music-like bursts
const N = FS * 60, x = new Float32Array(N);
let lp = 0;
for (let i = 0; i < N; i++) {
  const w = S.gauss();
  lp = 0.995 * lp + 0.1 * w;
  x[i] = i < N / 3 ? 0.01 * w : (i < 2 * N / 3 ? 0.05 * lp : 0.05 * lp * (1 + Math.sin(i / 5000)) + 0.003 * w);
}
const sc = [], mg = [];
for (let i = 0; i + 4096 <= N; i += 4096) for (const b of an.push(x.subarray(i, i + 4096), null, i)) { sc.push(b.conc); mg.push(b.margin); }
sc.sort((a, b) => a - b); mg.sort((a, b) => a - b);
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2);
console.log('noise blocks', sc.length, 'best-score p50', q(sc, .5), 'p95', q(sc, .95), 'max', q(sc, 1), '| margin p50', q(mg, .5), 'p95', q(mg, .95), 'max', q(mg, 1));
