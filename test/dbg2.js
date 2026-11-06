'use strict';
const TA = require('../src/dsp.js'); const S = require('./sim.js'); const { FS, P } = TA;
for (let trialN = 0; trialN < 3; trialN++) {
  const T = Float64Array.from({ length: FS }, () => S.gauss()), refl = [[3.4, 0.55], [8.1, 0.35], [14.6, 0.25]];
  const zones = [{ id: 1, ir: S.roomIR(18.25, { hp: 90, refl, sharedTail: T, rt60: 1.4, reverb: 0.04 }) },
                 { id: 3, ir: S.roomIR(22.4, { lp: 90, gain: 1.6, refl, sharedTail: T, rt60: 1.4, reverb: 0.04 }) }];
  // capture ALL blocks incl. rejected
  const lead = Math.round(FS * 0.5), K = 4, order = [1, 3, 1], total = lead + order.length * K * P + FS;
  const mic = new Float64Array(total + FS);
  for (const z of zones) {
    const sig = new Float64Array(total), seq = TA.getSequence(z.id).x;
    order.forEach((id, i) => { if (id !== z.id) return; for (let n = lead + i * K * P; n < lead + (i + 1) * K * P; n++) sig[n] = seq[n % P]; });
    const y = S.conv(sig, z.ir); for (let i = 0; i < mic.length; i++) mic[i] += y[i] || 0;
  }
  for (let i = 0; i < mic.length; i++) mic[i] += 0.002 * S.gauss();
  const an = new TA.Analyzer({ candidates: [1, 3] });
  const out = [];
  for (let i = 0; i + 2048 <= mic.length; i += 2048) for (const b of an.push(Float32Array.from(mic.subarray(i, i + 2048)), null, i)) out.push(b);
  console.log('trial', trialN, out.map(b => `${b.id}:${b.conc.toFixed(1)}/${b.margin.toFixed(1)}${b.ok ? '' : 'x'}`).join(' '));
}
