// Simulation harness for the TimeAlign DSP core.
// Builds synthetic loudspeaker/room impulse responses, plays the stimulus
// schedule through them, adds noise and clock drift, and checks the solver.
'use strict';
const TA = require('../src/dsp.js');
const { FS, P } = TA;

// ---------------------------------------------------------------- utilities
function biquad(type, f0, Q) {
  const w = 2 * Math.PI * f0 / FS, c = Math.cos(w), s = Math.sin(w), a = s / (2 * Q);
  let b0, b1, b2, a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
function filt(x, q) {
  const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < x.length; n++) {
    const v = q.b0 * x[n] + q.b1 * x1 + q.b2 * x2 - q.a1 * y1 - q.a2 * y2;
    x2 = x1; x1 = x[n]; y2 = y1; y1 = v; y[n] = v;
  }
  return y;
}
function lr4(x, type, fc) { const q = biquad(type, fc, Math.SQRT1_2); return filt(filt(x, q), q); }
let seed = 12345; const rnd = TA.mulberry32(777);
function gauss() { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function fracImpulse(len, d, amp) {
  const h = new Float64Array(len); const taps = 32;
  for (let j = Math.floor(d) - taps; j <= Math.floor(d) + taps; j++) {
    if (j < 0 || j >= len) continue; const t = j - d;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    h[j] += amp * sinc * (0.5 + 0.5 * Math.cos(Math.PI * t / (taps + 1)));
  }
  return h;
}
// Room IR: direct (delay dMs) + reflections + reverb tail, band-limited by speaker type
function roomIR(dMs, opts) {
  const len = Math.round(FS * 0.9);
  const d = dMs / 1000 * FS;
  let h = fracImpulse(len, d, opts.gain || 1);
  for (const [dt, a] of (opts.refl || [[3.1, 0.5], [7.7, 0.35], [13.2, 0.25]])) {
    const r = fracImpulse(len, d + dt / 1000 * FS, (opts.gain || 1) * a);
    for (let i = 0; i < len; i++) h[i] += r[i];
  }
  const rt = opts.rt60 || 0.8, lvl = opts.reverb == null ? 0.02 : opts.reverb;
  const start = Math.floor(d + 0.004 * FS);
  const shared = opts.sharedTail, mixS = opts.shareAmt == null ? 0.85 : opts.shareAmt;
  for (let i = start; i < len; i++) {
    const t = (i - start) / FS;
    const nz = shared ? (Math.sqrt(mixS) * shared[i - start] + Math.sqrt(1 - mixS) * gauss()) : gauss();
    h[i] += (opts.gain || 1) * lvl * nz * Math.pow(10, -3 * t / rt);
  }
  if (opts.hp) h = lr4(h, 'hp', opts.hp);
  if (opts.lp) h = lr4(h, 'lp', opts.lp);
  if (opts.invert) for (let i = 0; i < len; i++) h[i] = -h[i];
  return h;
}
// FFT convolution (overlap-add)
function conv(x, h) {
  const N = 1 << 18, L = N - h.length; const fft = TA.getFFT(N);
  const hr = new Float64Array(N), hi = new Float64Array(N); hr.set(h); fft.transform(hr, hi, false);
  const y = new Float64Array(x.length + h.length);
  const br = new Float64Array(N), bi = new Float64Array(N);
  for (let o = 0; o < x.length; o += L) {
    br.fill(0); bi.fill(0);
    for (let i = 0; i < L && o + i < x.length; i++) br[i] = x[o + i];
    fft.transform(br, bi, false);
    for (let k = 0; k < N; k++) { const r = br[k] * hr[k] - bi[k] * hi[k], im = br[k] * hi[k] + bi[k] * hr[k]; br[k] = r; bi[k] = im; }
    fft.transform(br, bi, true);
    for (let i = 0; i < N && o + i < y.length; i++) y[o + i] += br[i] / N;
  }
  return y;
}
// Clock drift: listening device runs at FS*(1+eps) relative to the player
function drift(x, eps) {
  if (!eps) return Float32Array.from(x);
  return TA.resample(Float32Array.from(x), FS * (1 + eps), FS); // read faster/slower
}

// ---------------------------------------------------------------- scenario runner
// zones: [{id, ir}], schedule: list of ids in order (auto mode), K periods each.
function runAuto(zones, opts) {
  const K = opts.K || 4, order = opts.order || zones.map(z => z.id).concat([zones[0].id]);
  const lead = Math.round(FS * 0.5);
  const total = lead + order.length * K * P + FS;
  const mic = new Float64Array(total + FS);
  const t0 = lead; // generator period phase origin (all sources started at t0... we model as global origin 0)
  for (const z of zones) {
    const sig = new Float64Array(total);
    const seq = TA.getSequence(z.id).x;
    order.forEach((id, i) => {
      if (id !== z.id) return;
      const a = lead + i * K * P, b = a + K * P;
      for (let n = a; n < b; n++) sig[n] = seq[n % P];   // sources phase-locked to frame 0
    });
    const y = conv(sig, z.ir);
    for (let i = 0; i < mic.length && i < y.length; i++) mic[i] += y[i];
  }
  const nl = opts.noise || 0.002;
  for (let i = 0; i < mic.length; i++) mic[i] += nl * gauss();
  void t0;
  return analyze(drift(mic, opts.eps || 0), zones.map(z => z.id), opts);
}
function analyze(mic, ids, opts) {
  const an = new TA.Analyzer({ candidates: ids });
  const blocks = [];
  const off = opts.frameOffset || 987654;  // arbitrary listener frame origin
  for (let i = 0; i + 2048 <= mic.length; i += 2048) {
    for (const b of an.push(mic.subarray(i, i + 2048), null, off + i)) {
      if (opts.all) process.stdout.write(`${b.id}:${b.conc.toFixed(1)}/${b.margin.toFixed(1)}${b.ok ? '' : 'x'} `);
      if (b.ok) { b.label = b.id; blocks.push(b); }
    }
  }
  // listener frame origin is arbitrary: shift s back so phases compare with truth only relatively
  return { sol: TA.solve(blocks), blocks };
}

function report(name, sol, truthMs, refId) {
  const ref = sol.zones.get(refId);
  let worst = 0; const rows = [];
  for (const [id, z] of sol.zones) {
    const rel = (z.T - ref.T) / FS * 1000, tru = truthMs[id] - truthMs[refId];
    const err = rel - tru; if (Math.abs(err) > Math.abs(worst)) worst = err;
    rows.push(`  zone ${id}: measured ${rel.toFixed(3)} ms  truth ${tru.toFixed(3)} ms  err ${(err * 1000).toFixed(1)} us  blocks ${z.n}/${z.nTotal}  snr ${z.snrDb.toFixed(1)} dB  coh ${TA.meanCoh(z, 500, 8000).toFixed(2)}`);
  }
  console.log(`${name}: drift ${sol.ppm.toFixed(2)} ppm, worst err ${(worst * 1000).toFixed(1)} us`);
  rows.forEach(r => console.log(r));
  return worst;
}

module.exports = { roomIR, runAuto, analyze, report, conv, drift, gauss, lr4, fracImpulse };

if (require.main === module) {
  const t = Date.now();
  // Club: Main L, Main R, Sub, Delay 1 (closer), Front fill
  const truth = { 1: 18.250, 2: 19.731, 3: 22.400, 4: 6.118, 5: 9.875 };
  const zones = [
    { id: 1, ir: roomIR(truth[1], { hp: 90 }) },
    { id: 2, ir: roomIR(truth[2], { hp: 90, gain: 0.8 }) },
    { id: 3, ir: roomIR(truth[3], { lp: 90, gain: 1.5, refl: [[5, 0.4]] }) },
    { id: 4, ir: roomIR(truth[4], { hp: 120, gain: 0.6 }) },
    { id: 5, ir: roomIR(truth[5], { hp: 150, gain: 0.3 }) },
  ];
  console.log('crest factor of sequence 1:', TA.getSequence(1).crestDb.toFixed(1), 'dB');
  let w1 = report('Same clock (Mac only)', runAuto(zones, { eps: 0 }).sol, truth, 1);
  let w2 = report('iPhone, +38 ppm drift', runAuto(zones, { eps: 38e-6 }).sol, truth, 1);
  let w3 = report('iPhone, -95 ppm drift, noisy', runAuto(zones, { eps: -95e-6, noise: 0.02 }).sol, truth, 1);
  console.log('elapsed', (Date.now() - t) / 1000, 's');
}

if (require.main === module) {
  // per-block diagnostics + sub alignment check
  const truth = { 1: 18.250, 3: 22.400 };
  const zones = [
    { id: 1, ir: roomIR(truth[1], { hp: 90 }) },
    { id: 3, ir: roomIR(truth[3], { lp: 90, gain: 1.5, refl: [[5, 0.4]] }) },
  ];
  const { sol, blocks } = runAuto(zones, { eps: 21e-6 });
  console.log('blocks:', blocks.map(b => `${b.id}:${b.conc.toFixed(1)}/${b.margin.toFixed(1)}`).join(' '));
  report('Main + Sub', sol, truth, 1);
  const A = sol.zones.get(1), B = sol.zones.get(3);
  const al = TA.alignPair(A, B, 90);
  console.log('alignPair: tau', al.tauMs.toFixed(2), 'ms pol', al.polarity, 'eff', al.eff.toFixed(3), 'now', al.effNow.toFixed(3), 'gain', al.gainDb.toFixed(2), 'dB expected', al.expectedMs.toFixed(2));
  console.log('cands', al.candidates.map(c => `${c.tau.toFixed(2)}/${c.pol}/${c.eff.toFixed(3)}`).join('  '));
}
