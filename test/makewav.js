// Build a simulated "phone recording" of the Mac's auto sequence: 4 speakers, room, drift, noise.
'use strict';
const fs = require('fs');
const TA = require('../src/dsp.js'); const S = require('./sim.js'); const { FS, P } = TA;
const truth = { 1: 21.300, 2: 22.950, 3: 25.100, 4: 7.420 };   // ms: Main L, Main R, Subs, Delay 1
const T = Float64Array.from({ length: FS }, () => S.gauss());
const refl = [[3.4, 0.5], [8.1, 0.3], [14.6, 0.2]];
const zones = [
  { id: 1, ir: S.roomIR(truth[1], { hp: 95, refl, sharedTail: T }) },
  { id: 2, ir: S.roomIR(truth[2], { hp: 95, gain: 0.85, refl }) },
  { id: 3, ir: S.roomIR(truth[3], { lp: 95, gain: 1.6, refl, sharedTail: T }) },
  { id: 4, ir: S.roomIR(truth[4], { hp: 110, gain: 0.7, refl: [[2.5, 0.4]] }) },
];
const K = +(process.argv[2] || 6), lead = FS * 7, tailS = FS * 8;
const order = [1, 2, 3, 4, 1];
const total = lead + order.length * K * P + tailS;
const mic = new Float64Array(total);
for (const z of zones) {
  const sig = new Float64Array(total), seq = TA.getSequence(z.id).x;
  order.forEach((id, i) => { if (id !== z.id) return; for (let n = lead + i * K * P; n < lead + (i + 1) * K * P; n++) sig[n] = seq[(n - lead) % P]; });
  const y = S.conv(sig, z.ir); for (let i = 0; i < total; i++) mic[i] += (y[i] || 0) * 0.5;
}
for (let i = 0; i < total; i++) mic[i] += 0.003 * S.gauss();
const out = S.drift(mic, 41e-6);   // phone clock 41 ppm off
let pk = 0; for (const v of out) pk = Math.max(pk, Math.abs(v));
const g = 0.7 / pk;
const buf = Buffer.alloc(44 + out.length * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + out.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(FS, 24);
buf.writeUInt32LE(FS * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(out.length * 2, 40);
for (let i = 0; i < out.length; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
fs.writeFileSync(__dirname + '/sim_recording.wav', buf);
console.log('wrote', (out.length / FS).toFixed(1), 's; truth rel to Main L:', Object.fromEntries(Object.entries(truth).map(([k, v]) => [k, (v - truth[1]).toFixed(3)])));
