'use strict';
const TA = require('../src/dsp.js'); const S = require('./sim.js'); const { FS } = TA;
const an = new TA.Analyzer({ candidates: [0], minSnr: -99 });
const N = FS * 120, x = new Float32Array(N); let lp = 0;
for (let i = 0; i < N; i++) { const w = S.gauss(); lp = 0.995 * lp + 0.1 * w; x[i] = i % (FS * 20) < FS * 10 ? 0.01 * w : 0.05 * lp; }
const sc = [];
for (let i = 0; i + 4096 <= N; i += 4096) for (const b of an.push(x.subarray(i, i + 4096), null, i)) sc.push(b.conc);
sc.sort((a, b) => a - b);
console.log('single-candidate noise score: p50', sc[Math.floor(sc.length / 2)].toFixed(2), 'p99', sc[Math.floor(sc.length * .99)].toFixed(2), 'max', sc[sc.length - 1].toFixed(2), 'n', sc.length);
