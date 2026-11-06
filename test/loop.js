'use strict';
// Loop-back reference mode: ref channel = generator output looped into input 2 (same input clock as the mic).
const TA = require('../src/dsp.js'); const S = require('./sim.js'); const { FS, P } = TA;
const truth = { 1: 15.0, 2: 16.7, 4: 4.2 };
const zones = [{ id: 1, ir: S.roomIR(15.0, { hp: 90 }) }, { id: 2, ir: S.roomIR(16.7, { hp: 90, gain: 0.8 }) }, { id: 4, ir: S.roomIR(4.2, { hp: 120, gain: 0.5 }) }];
const K = 4, lead = FS, order = [1, 2, 4, 1], total = lead + order.length * K * P + FS;
const mic = new Float64Array(total), ref = new Float64Array(total);
const outLat = 377;  // output device latency (samples) seen by both paths
for (const z of zones) {
  const sig = new Float64Array(total), seq = TA.getSequence(z.id).x;
  order.forEach((id, i) => { if (id !== z.id) return; for (let n = lead + i * K * P; n < lead + (i + 1) * K * P; n++) sig[n] = seq[n % P]; });
  const y = S.conv(sig, z.ir);
  for (let i = outLat; i < total; i++) { mic[i] += y[i - outLat] || 0; ref[i] += sig[i - outLat] * 0.5; }
}
for (let i = 0; i < total; i++) mic[i] += 0.002 * S.gauss();
const eps = 55e-6, m = S.drift(mic, eps), r = S.drift(ref, eps);  // output device clock != input clock
const an = new TA.Analyzer({ candidates: [0, 1, 2, 3, 4], useRef: true });
const blocks = []; let lastId = null;
for (let i = 0; i + 2048 <= m.length; i += 2048) for (const b of an.push(m.subarray(i, i + 2048), r.subarray(i, i + 2048), 5000 + i)) {
  const runStart = b.id !== lastId; lastId = b.ok ? b.id : null;
  if (b.ok && !runStart) { b.label = b.id; blocks.push(b); }
}
const sol = TA.solve(blocks);
const R = sol.zones.get(1);
for (const [id, z] of sol.zones) console.log(`zone ${id}: absolute ${(z.T / FS * 1000).toFixed(3)} ms (truth ${truth[id].toFixed(3)} — loop-back gives true acoustic delay)  rel ${((z.T - R.T) / FS * 1000).toFixed(3)} (truth ${(truth[id] - truth[1]).toFixed(3)})`);
console.log('drift seen by solver (should be ~0 with loop-back):', sol.ppm.toFixed(2), 'ppm');
