'use strict';
const TA = require('../src/dsp.js'); const S = require('./sim.js'); const { FS } = TA;
const T = Float64Array.from({ length: FS }, () => S.gauss()), refl = [[3.4, 0.55], [8.1, 0.35], [14.6, 0.25]];
// wet club 90 detection
const zones = [{ id: 1, ir: S.roomIR(18.25, { hp: 90, refl, sharedTail: T, rt60: 1.4, reverb: 0.04 }) },
               { id: 3, ir: S.roomIR(22.4, { lp: 90, gain: 1.6, refl, sharedTail: T, rt60: 1.4, reverb: 0.04 }) }];
const r = S.runAuto(zones, { eps: 21e-6 });
const an = r.blocks;
console.log('accepted blocks', an.map(b => `${b.id}:${b.conc.toFixed(1)}/${b.margin.toFixed(1)}`).join(' '));
// raw (incl. rejected): rerun analyze capturing all
const { Analyzer } = TA;
// band arrival debug on sub-early case
const z2 = [{ id: 1, ir: S.roomIR(15.0, { hp: 100, refl, sharedTail: T, rt60: 0.9, reverb: 0.03 }) },
            { id: 3, ir: S.roomIR(9.5, { lp: 100, gain: 1.6, refl, sharedTail: T, rt60: 0.9, reverb: 0.03 }) }];
const r2 = S.runAuto(z2, { eps: 0 });
for (const [id, z] of r2.sol.zones) {
  const ba = TA.bandArrival(z, 100);
  console.log('zone', id, 'T', (z.T / FS * 1000).toFixed(2), 'band', (ba / FS * 1000).toFixed(2), 'diff', ((ba - z.T) / FS * 1000).toFixed(2));
}
