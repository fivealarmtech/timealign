'use strict';
const TA = require('../src/dsp.js'); const S = require('./sim.js'); const { FS } = TA;
let ok1 = 0, ok3 = 0, amb1 = 0, amb3 = 0, n = 0;
const cases = [['LR4 90', 90, 18.25, 22.4, false], ['LR4 80 inv', 80, 21.0, 23.3, true], ['sub early 100', 100, 15.0, 9.5, false], ['LR4 110', 110, 12.0, 13.5, false]];
for (const [name, fc, tM, tS, inv] of cases) {
  for (let rep = 0; rep < 2; rep++) {
    const As = [], Bs = [];
    for (let pos = 0; pos < 3; pos++) {
      const T = Float64Array.from({ length: FS }, () => S.gauss());
      const refl = [[2 + 3 * S.gauss() ** 2, 0.5], [6 + 4 * Math.abs(S.gauss()), 0.35], [12 + 5 * Math.abs(S.gauss()), 0.25]];
      const dPos = pos * 1.7; // mic moves: both arrivals shift together
      const zones = [{ id: 1, ir: S.roomIR(tM + dPos, { hp: fc, refl, sharedTail: T, rt60: 1.0, reverb: 0.03 }) },
                     { id: 3, ir: S.roomIR(tS + dPos, { lp: fc, gain: 1.6, invert: inv, refl, sharedTail: T, rt60: 1.0, reverb: 0.03 }) }];
      const { sol } = S.runAuto(zones, { eps: 30e-6 });
      if (sol.zones.get(1) && sol.zones.get(3)) { As.push(sol.zones.get(1)); Bs.push(sol.zones.get(3)); }
    }
    const truth = tM - tS, pol = inv ? -1 : 1;
    const good = (al) => Math.abs(al.tauMs - truth) < 1.0 && al.polarity === pol;
    const single = TA.alignPair(As[0], Bs[0], fc), multi = TA.alignPair(As, Bs, fc);
    n++; ok1 += good(single); ok3 += good(multi); amb1 += !single.confident; amb3 += !multi.confident;
    console.log(`${name} rep${rep}: truth ${truth.toFixed(2)}/${pol} | 1 pos ${single.tauMs.toFixed(2)}/${single.polarity}${single.confident ? '' : '?'} | ${As.length} pos ${multi.tauMs.toFixed(2)}/${multi.polarity}${multi.confident ? '' : '?'}  alt ${multi.alt ? multi.alt.tau.toFixed(2) + '/' + multi.alt.pol : '-'}`);
  }
}
console.log(`single-position correct ${ok1}/${n} (flagged ambiguous ${amb1}); 3-position correct ${ok3}/${n} (ambiguous ${amb3})`);
