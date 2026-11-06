'use strict';
const TA = require('../src/dsp.js');
const S = require('./sim.js');
const { FS } = TA;
function trial(name, mainOpts, subOpts, tM, tS, fc) {
  const zones = [{ id: 1, ir: S.roomIR(tM, mainOpts) }, { id: 3, ir: S.roomIR(tS, subOpts) }];
  const { sol } = S.runAuto(zones, { eps: 21e-6 });
  const A = sol.zones.get(1), B = sol.zones.get(3);
  if (!A || !B) { const r2 = S.runAuto(zones, { eps: 21e-6, all: true }); console.log(name, 'MISSING ZONE', [...sol.zones.keys()]); return; }
  const al = TA.alignPair(A, B, fc);
  console.log(`${name}: truth tau ${(tM - tS).toFixed(2)} (delay mains ${(tS - tM).toFixed(2)}) | found tau ${al.tauMs.toFixed(2)} pol ${al.polarity} eff ${al.eff.toFixed(3)} (now ${al.effNow.toFixed(3)}, +${al.gainDb.toFixed(1)} dB) expected ${al.expectedMs.toFixed(2)} ${al.confident ? '' : '  [AMBIGUOUS]'}`);
  console.log('   cands', al.candidates.map(c => `${c.tau.toFixed(2)}/${c.pol}/n${c.eff.toFixed(3)}/w${c.wide.toFixed(3)}`).join('  '));
  return al;
}
const dry = { reverb: 0, refl: [] };
trial('dry LR4 90', { hp: 90, ...dry }, { lp: 90, gain: 1.5, ...dry }, 18.25, 22.4, 90);
trial('dry LR4 90, sub inverted', { hp: 90, ...dry }, { lp: 90, gain: 1.5, invert: true, ...dry }, 18.25, 22.4, 90);
trial('dry, sub early', { hp: 100, ...dry }, { lp: 100, ...dry }, 15.0, 9.5, 100);
trial('reflections only', { hp: 90, reverb: 0 }, { lp: 90, gain: 1.5, reverb: 0, refl: [[5, 0.4]] }, 18.25, 22.4, 90);
trial('full room', { hp: 90 }, { lp: 90, gain: 1.5, refl: [[5, 0.4]] }, 18.25, 22.4, 90);
trial('full room, sub early', { hp: 100 }, { lp: 100, refl: [[2, 0.5]] }, 15.0, 9.5, 100);
trial('full room LR4 80, sub inverted', { hp: 80 }, { lp: 80, gain: 2, invert: true, refl: [[6, 0.5]] }, 21.0, 23.3, 80);
trial('very wet room', { hp: 90, reverb: 0.04, rt60: 1.4 }, { lp: 90, gain: 1.5, reverb: 0.04, rt60: 1.4 }, 18.25, 22.4, 90);
console.log('--- co-located sub + tops (shared reflections, 85% shared reverb) ---');
const tail = () => Float64Array.from({ length: FS }, () => S.gauss());
for (const [name, fc, tM, tS, inv, rt, rv] of [
  ['club LR4 90', 90, 18.25, 22.4, false, 0.8, 0.02],
  ['club LR4 80 inv', 80, 21.0, 23.3, true, 0.8, 0.02],
  ['club sub early 100', 100, 15.0, 9.5, false, 0.9, 0.03],
  ['wet club 90', 90, 18.25, 22.4, false, 1.4, 0.04],
  ['wet club 120 inv', 120, 12.0, 13.1, true, 1.3, 0.035],
]) {
  const T = tail(), refl = [[3.4, 0.55], [8.1, 0.35], [14.6, 0.25]];
  trial(name, { hp: fc, refl, sharedTail: T, rt60: rt, reverb: rv }, { lp: fc, gain: 1.6, invert: inv, refl, sharedTail: T, rt60: rt, reverb: rv }, tM, tS, fc);
}
