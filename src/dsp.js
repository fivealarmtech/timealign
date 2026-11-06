/*
 * TimeAlign DSP core
 * -------------------------------------------------------------
 * Smaart-style dual-FFT transfer-function engine for loudspeaker
 * time alignment:
 *   - Stimulus: periodic pseudo-random pink noise (one distinct
 *     sequence per zone / mix send, period P samples).
 *   - Transfer function per block: H = Y * conj(X) / |X|^2   (H1
 *     estimator; X = known stimulus or a loop-back reference).
 *   - Averaged H across blocks (complex averaging) + coherence.
 *   - Impulse response = IFFT(H); delay finder = peak of the
 *     analytic envelope (ETC) with sub-sample interpolation.
 *   - Joint least-squares fit across all blocks removes clock
 *     drift between the playing device and the listening device
 *     (e.g. Mac -> iPhone), so arrival times measured at different
 *     moments are directly comparable.
 *   - Sub <-> main crossover alignment: searches delay and polarity
 *     that maximise the coherent sum in the crossover band.
 * Pure JS, no dependencies. Works in browsers and Node.
 */
(function (root) {
  'use strict';

  const FS = 48000;           // working sample rate (all devices run the context at 48 kHz)
  const P = 32768;            // stimulus period = analysis block length (0.683 s)
  const HALF = P / 2;
  const F_LO = 20, F_HI = 20000;
  const HOP = P / 2;          // analysis hop
  const MANUAL_ID = 0;        // sequence id used in manual mode
  const MAX_ZONES = 16;

  // ------------------------------------------------------------------ FFT
  class FFT {
    constructor(n) {
      let levels = 0;
      while ((1 << levels) < n) levels++;
      if ((1 << levels) !== n) throw new Error('FFT size must be a power of 2');
      this.n = n;
      this.cos = new Float64Array(n / 2);
      this.sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) {
        this.cos[i] = Math.cos(2 * Math.PI * i / n);
        this.sin[i] = Math.sin(2 * Math.PI * i / n);
      }
      this.rev = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        let r = 0, x = i;
        for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>>= 1; }
        this.rev[i] = r;
      }
    }
    // In place. inverse=true gives the unscaled inverse (divide by n yourself).
    transform(re, im, inverse) {
      const n = this.n, rev = this.rev, cosT = this.cos, sinT = this.sin;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      const sgn = inverse ? 1 : -1;
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >>> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const wr = cosT[k], wi = sgn * sinT[k];
            const lr = re[l], li = im[l];
            const tr = lr * wr - li * wi;
            const ti = lr * wi + li * wr;
            re[l] = re[j] - tr; im[l] = im[j] - ti;
            re[j] += tr; im[j] += ti;
          }
        }
      }
    }
  }
  const fftCache = new Map();
  function getFFT(n) {
    let f = fftCache.get(n);
    if (!f) { f = new FFT(n); fftCache.set(n, f); }
    return f;
  }

  // ------------------------------------------------------------------ PRNG
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const K_LO = Math.ceil(F_LO * P / FS);
  const K_HI = Math.floor(F_HI * P / FS);

  // ------------------------------------------------------------------ stimulus
  // Periodic pink noise with an exactly known spectrum (every bin 20 Hz..20 kHz
  // excited), crest factor reduced. Deterministic for a given id on every device.
  const seqCache = new Map();
  function getSequence(id) {
    if (seqCache.has(id)) return seqCache.get(id);
    const fft = getFFT(P);
    const rnd = mulberry32((0x9E3779B1 ^ Math.imul(id + 1, 0x85EBCA6B)) >>> 0);
    const mag = new Float64Array(HALF + 1);
    const re = new Float64Array(P), im = new Float64Array(P);
    for (let k = K_LO; k <= K_HI; k++) {
      const f = k * FS / P;
      mag[k] = 1 / Math.sqrt(f);
      const ph = 2 * Math.PI * rnd();
      re[k] = mag[k] * Math.cos(ph); im[k] = mag[k] * Math.sin(ph);
      re[P - k] = re[k]; im[P - k] = -im[k];
    }
    fft.transform(re, im, true);
    for (let it = 0; it < 8; it++) {
      let ss = 0;
      for (let i = 0; i < P; i++) ss += re[i] * re[i];
      const c = 2.6 * Math.sqrt(ss / P);
      for (let i = 0; i < P; i++) {
        const v = re[i];
        re[i] = v > c ? c : (v < -c ? -c : v);
        im[i] = 0;
      }
      fft.transform(re, im, false);
      for (let k = 0; k <= HALF; k++) {
        if (k >= K_LO && k <= K_HI) {
          const m = Math.hypot(re[k], im[k]) || 1e-30;
          const s = mag[k] / m;
          re[k] *= s; im[k] *= s;
        } else { re[k] = 0; im[k] = 0; }
        if (k > 0 && k < HALF) { re[P - k] = re[k]; im[P - k] = -im[k]; }
      }
      im[0] = 0; im[HALF] = 0;
      fft.transform(re, im, true);
    }
    let ss = 0, pk = 0;
    for (let i = 0; i < P; i++) { ss += re[i] * re[i]; pk = Math.max(pk, Math.abs(re[i])); }
    const rms = Math.sqrt(ss / P);
    const g = 0.25 / rms;                      // RMS = -12 dBFS at unity gain
    const x = new Float32Array(P);
    for (let i = 0; i < P; i++) x[i] = re[i] * g;
    // reference spectrum of exactly what is played (float32 samples)
    const xr = new Float64Array(P), xi = new Float64Array(P);
    for (let i = 0; i < P; i++) xr[i] = x[i];
    fft.transform(xr, xi, false);
    const invRe = new Float64Array(HALF + 1), invIm = new Float64Array(HALF + 1);
    for (let k = K_LO; k <= K_HI; k++) {
      const d = xr[k] * xr[k] + xi[k] * xi[k];
      invRe[k] = xr[k] / d; invIm[k] = -xi[k] / d;
    }
    const seq = { id, x, invRe, invIm, crestDb: 20 * Math.log10(pk / rms) };
    seqCache.set(id, seq);
    return seq;
  }

  // ------------------------------------------------------------------ helpers
  function wrapHalf(d) { // map to (-P/2, P/2]
    d = d % P;
    if (d > HALF) d -= P; else if (d <= -HALF) d += P;
    return d;
  }
  function mod(a, n) { return ((a % n) + n) % n; }

  // Analytic IR (complex) from a one-sided spectrum H[k], k=0..HALF (only K_LO..K_HI used)
  // Returns the envelope |z| (ETC, linear) and real part h.
  const _zr = new Float64Array(P), _zi = new Float64Array(P);
  function analyticIR(Hre, Him, weight) {
    const fft = getFFT(P);
    _zr.fill(0); _zi.fill(0);
    for (let k = K_LO; k <= K_HI; k++) {
      const w = weight ? 2 * weight[k] : 2;
      _zr[k] = Hre[k] * w; _zi[k] = Him[k] * w;
    }
    fft.transform(_zr, _zi, true);
    const env = new Float32Array(P), h = new Float32Array(P);
    for (let n = 0; n < P; n++) {
      const a = _zr[n] / P, b = _zi[n] / P;
      env[n] = Math.sqrt(a * a + b * b); h[n] = a;
    }
    return { env, h };
  }

  // Peak of envelope with Gaussian (log-parabolic) sub-sample interpolation.
  // "First strong arrival": the earliest local maximum within 6 dB of the highest peak,
  // searched up to `lookback` samples before it (default 50 ms). With a clean direct sound this
  // is the highest peak (Smaart's rule); when a reflection or room build-up is louder than the
  // direct sound it still returns the direct arrival.
  function peakOf(env, opts) {
    opts = opts || {};
    let bi = 0, bv = -1, ss = 0;
    for (let n = 0; n < P; n++) { const v = env[n]; ss += v * v; }
    if (opts.center != null) {           // restrict search to [center-before, center+after]
      const c = Math.round(opts.center);
      for (let d = -opts.before; d <= opts.after; d++) {
        const i = mod(c + d, P), v = env[i];
        if (v > bv) { bv = v; bi = i; }
      }
    } else {
      for (let n = 0; n < P; n++) { const v = env[n]; if (v > bv) { bv = v; bi = n; } }
    }
    const lookback = opts.lookback != null ? opts.lookback : Math.round(0.05 * FS);
    const thr = bv * (opts.rel || 0.5);
    for (let d = lookback; d >= 1; d--) {
      const i = (bi - d + P) % P, v = env[i];
      if (v >= thr && v >= env[(i - 1 + P) % P] && v >= env[(i + 1) % P]) { bi = i; break; }
    }
    const a = env[(bi - 1 + P) % P], b = env[bi], c = env[(bi + 1) % P];
    let d = 0;
    if (a > 0 && b > 0 && c > 0) {
      const la = Math.log(a), lb = Math.log(b), lc = Math.log(c);
      const den = la - 2 * lb + lc;
      if (den < 0) d = 0.5 * (la - lc) / den;
    }
    if (!(Math.abs(d) <= 0.5)) d = 0;
    const rms = Math.sqrt(ss / P) || 1e-30;
    return { pos: bi + d, peak: bv, snrDb: 20 * Math.log10(bv / rms) };
  }

  // Zero-phase band window centred on f0, Gaussian in log2(f): ~1 octave wide (-6 dB at +/- 0.5 oct)
  function bandWindow(f0, octaves) {
    const w = new Float64Array(HALF + 1);
    const sig = (octaves || 1) * 0.6;
    for (let k = K_LO; k <= K_HI; k++) {
      const o = Math.log2((k * FS / P) / f0);
      w[k] = Math.exp(-0.5 * (o / sig) * (o / sig));
    }
    return w;
  }

  // Classification metric: "spectral smoothness" of the cross-spectrum G = Y * conj(X).
  //   S1 = |sum_k G_k conj(G_k+1)| / sum_k |G_k|^2
  // equals the first circular Fourier coefficient of the cross-correlation's energy-vs-time
  // profile, i.e. how concentrated in time the response is. A matching sequence gives a
  // response a few hundred ms long -> S1 ~ 0.5..1; a non-matching sequence gives random phase
  // -> S1 ~ 1/sqrt(Neff). Score = 20log10(S1*sqrt(Neff)) is therefore ~0 dB for noise and
  // 15..40 dB for a real arrival, for subs and full-range boxes alike. Pink (|X|^2) weighting
  // keeps high-frequency noise from swamping band-limited sources.
  function classifyScore(yr, yi, seq) {
    let sr = 0, si = 0, e = 0, e2 = 0;
    let pr = 0, pi = 0, first = true;
    for (let k = K_LO; k <= K_HI; k++) {
      // G = Y * conj(X) ;  conj(X) = invX * |X|^2  ->  use invX / |invX|^2
      const ir = seq.invRe[k], ii = seq.invIm[k];
      const d = ir * ir + ii * ii;
      const cr = ir / d, ci = ii / d;            // conj(X)
      const gr = yr[k] * cr - yi[k] * ci, gi = yr[k] * ci + yi[k] * cr;
      const m = gr * gr + gi * gi;
      e += m; e2 += m * m;
      if (!first) { sr += pr * gr + pi * gi; si += pi * gr - pr * gi; }
      pr = gr; pi = gi; first = false;
    }
    const s1 = Math.hypot(sr, si) / (e + 1e-300);
    const neff = e * e / (e2 + 1e-300);
    return 20 * Math.log10(s1 * Math.sqrt(neff) + 1e-12);
  }

  // ------------------------------------------------------------------ Analyzer
  // Feed it microphone samples (and optionally a loop-back reference channel).
  // Each block of P samples is deconvolved against every candidate sequence;
  // the best one identifies which zone is playing.
  class Analyzer {
    constructor(opts) {
      opts = opts || {};
      this.setCandidates(opts.candidates || [MANUAL_ID]);
      this.useRef = !!opts.useRef;
      this.minSnr = opts.minSnr != null ? opts.minSnr : 5;
      this.minMargin = opts.minMargin != null ? opts.minMargin : 6;
      this.minSingle = opts.minSingle != null ? opts.minSingle : 6.5;
      this.mic = new Float32Array(P * 4);
      this.ref = new Float32Array(P * 4);
      this.len = 0;           // samples in buffer
      this.bufStart = null;   // absolute frame index of mic[0]
      this.readPos = 0;
      this.yr = new Float64Array(P); this.yi = new Float64Array(P);
      this.rr = new Float64Array(P); this.ri = new Float64Array(P);
    }
    setCandidates(ids) { this.cands = ids.map(getSequence); }
    reset() { this.len = 0; this.readPos = 0; this.bufStart = null; }

    // frame = absolute frame index of chunk[0] (context frames). Returns new block results.
    push(micChunk, refChunk, frame) {
      const n = micChunk.length;
      if (this.bufStart === null) this.bufStart = frame;
      const expected = this.bufStart + this.len;
      if (frame !== undefined && frame !== expected) {
        // discontinuity (dropped audio): restart buffer at the new position
        if (Math.abs(frame - expected) > 1) { this.len = 0; this.readPos = 0; this.bufStart = frame; }
      }
      if (this.len + n > this.mic.length) {
        // compact
        const keep = this.len - this.readPos;
        this.mic.copyWithin(0, this.readPos, this.len);
        this.ref.copyWithin(0, this.readPos, this.len);
        this.bufStart += this.readPos; this.len = keep; this.readPos = 0;
        if (this.len + n > this.mic.length) {
          const nm = new Float32Array((this.len + n) * 2), nr = new Float32Array((this.len + n) * 2);
          nm.set(this.mic.subarray(0, this.len)); nr.set(this.ref.subarray(0, this.len));
          this.mic = nm; this.ref = nr;
        }
      }
      this.mic.set(micChunk, this.len);
      if (refChunk) this.ref.set(refChunk, this.len);
      this.len += n;
      const out = [];
      while (this.len - this.readPos >= P) {
        out.push(this.analyzeBlock(this.readPos, this.bufStart + this.readPos));
        this.readPos += HOP;
      }
      return out;
    }

    analyzeBlock(off, s) {
      const fft = getFFT(P);
      const yr = this.yr, yi = this.yi;
      let ms = 0, pk = 0;
      for (let i = 0; i < P; i++) { const v = this.mic[off + i]; yr[i] = v; yi[i] = 0; ms += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
      const levelDb = 10 * Math.log10(ms / P + 1e-20), peakDb = 20 * Math.log10(pk + 1e-20);
      fft.transform(yr, yi, false);
      // classify against every candidate sequence
      let best = null, second = -Infinity;
      for (const c of this.cands) {
        const sc = classifyScore(yr, yi, c);
        if (!best || sc > best.snrDb) {
          if (best) second = Math.max(second, best.snrDb);
          best = { id: c.id, seq: c, snrDb: sc };
        } else second = Math.max(second, sc);
      }
      const res = { s, levelDb, peakDb, id: best.id, conc: best.snrDb, snrDb: best.snrDb, margin: best.snrDb - (isFinite(second) ? second : 0), ok: false };
      res.ok = this.cands.length === 1
        ? best.snrDb >= this.minSingle
        : (best.snrDb >= this.minSnr && res.margin >= this.minMargin);
      res.conc = best.snrDb;
      // Transfer function for the winner, rotated into the "generator phase" frame
      const c = best.seq;
      const Hre = new Float32Array(HALF + 1), Him = new Float32Array(HALF + 1);
      if (this.useRef) {
        const rr = this.rr, ri = this.ri;
        let rms = 0;
        for (let i = 0; i < P; i++) { const v = this.ref[off + i]; rr[i] = v; ri[i] = 0; rms += v * v; }
        fft.transform(rr, ri, false);
        let mx = 0;
        for (let k = K_LO; k <= K_HI; k++) mx = Math.max(mx, rr[k] * rr[k] + ri[k] * ri[k]);
        const floor = mx * 1e-7;
        for (let k = K_LO; k <= K_HI; k++) {
          const d = rr[k] * rr[k] + ri[k] * ri[k];
          if (d > floor) {
            Hre[k] = (yr[k] * rr[k] + yi[k] * ri[k]) / d;
            Him[k] = (yi[k] * rr[k] - yr[k] * ri[k]) / d;
          }
        }
        res.refDb = 10 * Math.log10(rms / P + 1e-20);
      } else {
        const sp = mod(s, P);
        for (let k = K_LO; k <= K_HI; k++) {
          const hr = yr[k] * c.invRe[k] - yi[k] * c.invIm[k];
          const hi = yr[k] * c.invIm[k] + yi[k] * c.invRe[k];
          const a = -2 * Math.PI * ((k * sp) % P) / P;   // * e^{-j 2 pi k s / P}
          const ca = Math.cos(a), sa = Math.sin(a);
          Hre[k] = hr * ca - hi * sa; Him[k] = hr * sa + hi * ca;
        }
      }
      const ir = analyticIR(Hre, Him);
      const p = peakOf(ir.env);
      res.phi = p.pos;            // arrival phase in [0,P): constant across blocks except for clock drift
      res.snrDb = p.snrDb;   // peak-to-RMS of the impulse response (quality readout)
      res.Hre = Hre; res.Him = Him;
      res.env = ir.env;
      return res;
    }
  }

  // ------------------------------------------------------------------ Solver
  // blocks: [{label, s, phi, snrDb, Hre, Him}]  (only accepted blocks)
  // Returns drift estimate and per-label averaged transfer functions & arrival times.
  function solve(blocks, opts) {
    opts = opts || {};
    if (!blocks.length) return null;
    const groups = new Map();
    const phi0 = blocks[0].phi;
    for (const b of blocks) {
      const u = phi0 + wrapHalf(b.phi - phi0);
      if (!groups.has(b.label)) groups.set(b.label, []);
      groups.get(b.label).push({ b, u, t: b.s, keep: true });
    }
    const fit = (weighted) => {
      let num = 0, den = 0;
      for (const [, g] of groups) {
        const k = g.filter(x => x.keep);
        if (k.length < 2) continue;
        let tm = 0, um = 0;
        for (const x of k) { tm += x.t; um += x.u; }
        tm /= k.length; um /= k.length;
        const w = weighted ? (g.w || 1) : 1;
        for (const x of k) { num += w * (x.t - tm) * (x.u - um); den += w * (x.t - tm) * (x.t - tm); }
      }
      // need at least ~0.5 s of time spread to estimate drift
      return den > 0 && Math.sqrt(den) > FS * 0.3 ? num / den : 0;
    };
    let eps = 0;
    for (let pass = 0; pass < 3; pass++) {
      eps = fit(pass > 0);
      if (Math.abs(eps) > 5e-4) eps = 0;   // > 500 ppm is not a clock, it's garbage
      for (const [, g] of groups) {
        const k = g.filter(x => x.keep);
        let a = 0; for (const x of k) a += x.u - eps * x.t; a /= Math.max(1, k.length);
        const r = g.map(x => x.u - eps * x.t - a);
        const ar = r.filter((_, i) => g[i].keep).map(Math.abs).sort((p, q) => p - q);
        const mad = ar.length ? ar[Math.floor(ar.length / 2)] * 1.4826 : 0;
        g.sigma = Math.max(mad, 0.05);
        g.w = 1 / (g.sigma * g.sigma);
        const thr = Math.max(4 * g.sigma, 1.5);
        g.forEach((x, i) => { x.keep = Math.abs(r[i]) <= thr || g.length <= 2; });
        if (!g.some(x => x.keep)) g.forEach(x => { x.keep = true; });
      }
    }
    const zones = new Map();
    for (const [label, g] of groups) {
      const k = g.filter(x => x.keep);
      let a = 0; for (const x of k) a += x.u - eps * x.t; a /= k.length;
      const Hre = new Float64Array(HALF + 1), Him = new Float64Array(HALF + 1), pw = new Float64Array(HALF + 1);
      let snr = 0;
      for (const x of k) {
        const b = x.b; snr += b.snrDb;
        const sh = mod(eps * x.t, P);
        for (let kk = K_LO; kk <= K_HI; kk++) {
          const ang = 2 * Math.PI * ((kk * sh) % P) / P;  // * e^{+j 2 pi k eps t / P}
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const hr = b.Hre[kk] * ca - b.Him[kk] * sa, hi = b.Hre[kk] * sa + b.Him[kk] * ca;
          Hre[kk] += hr; Him[kk] += hi; pw[kk] += hr * hr + hi * hi;
        }
      }
      const M = k.length;
      const coh = new Float32Array(HALF + 1);
      for (let kk = K_LO; kk <= K_HI; kk++) {
        const sr = Hre[kk], si = Him[kk];
        coh[kk] = M > 1 ? (sr * sr + si * si) / (M * pw[kk] + 1e-300) : NaN;
        Hre[kk] = sr / M; Him[kk] = si / M;
      }
      const ir = analyticIR(Hre, Him);
      const pk = peakOf(ir.env);
      const T = a + wrapHalf(pk.pos - a);   // representative nearest to the fitted value
      zones.set(label, {
        label, n: M, nTotal: g.length, T, Tfit: a, snrDb: snr / M, irSnrDb: pk.snrDb,
        jitter: g.sigma, Hre, Him, coh, env: ir.env, h: ir.h
      });
    }
    return { eps, ppm: eps * 1e6, zones };
  }

  // Band-limited arrival (Smaart "Advanced Delay Finder" style: 1-octave band around f0)
  function bandArrival(z, f0, octaves) {
    const w = bandWindow(f0, octaves || 1);
    const ir = analyticIR(z.Hre, z.Him, w);
    // search near the broadband arrival only: 10 ms before .. 4 cycles after
    const pk = peakOf(ir.env, {
      center: mod(z.T, P), before: Math.round(0.010 * FS), after: Math.round(4 / f0 * FS),
      lookback: Math.round(Math.min(0.03, 2 / f0) * FS)
    });
    return z.T + wrapHalf(pk.pos - z.T);
  }

  // Mean coherence (0..1) over a frequency range
  function meanCoh(z, f1, f2) {
    let s = 0, n = 0;
    const k1 = Math.max(K_LO, Math.round(f1 * P / FS)), k2 = Math.min(K_HI, Math.round(f2 * P / FS));
    for (let k = k1; k <= k2; k++) { const c = z.coh[k]; if (c === c) { s += c; n++; } }
    return n ? s / n : NaN;
  }

  // ------------------------------------------------------------------ Sub <-> Main alignment
  // Time-window a zone's IR around tCenter (samples): keeps pre/post seconds, half-Hann tapers.
  // Gives a "direct-sound" transfer function with far less room reverb (like a short MTW window).
  function windowedTF(z, tCenter, preS, postS) {
    const fft = getFFT(P);
    const re = new Float64Array(P), im = new Float64Array(P);
    for (let k = K_LO; k <= K_HI; k++) {
      re[k] = z.Hre[k]; im[k] = z.Him[k];
      re[P - k] = z.Hre[k]; im[P - k] = -z.Him[k];
    }
    fft.transform(re, im, true);
    const pre = Math.round(preS * FS), post = Math.round(postS * FS);
    const c = Math.round(tCenter), tp = Math.round(pre * 0.5), tq = Math.round(post * 0.5);
    const w = new Float64Array(P);
    for (let d = -pre; d <= post; d++) {
      let g = 1;
      if (d < -pre + tp) g = 0.5 - 0.5 * Math.cos(Math.PI * (d + pre) / tp);
      else if (d > post - tq) g = 0.5 + 0.5 * Math.cos(Math.PI * (d - (post - tq)) / tq);
      w[mod(c + d, P)] = g;
    }
    for (let n = 0; n < P; n++) { re[n] = re[n] / P * w[n]; im[n] = 0; }
    fft.transform(re, im, false);
    const Hre = new Float64Array(HALF + 1), Him = new Float64Array(HALF + 1);
    for (let k = K_LO; k <= K_HI; k++) { Hre[k] = re[k]; Him[k] = im[k]; }
    return { Hre, Him, coh: z.coh, T: z.T };
  }

  function makeScorer(A, B, f1, f2) {
    const k1 = Math.max(K_LO, Math.floor(f1 * P / FS)), k2 = Math.min(K_HI, Math.ceil(f2 * P / FS));
    const bins = [];
    let idealSum = 0;
    for (let k = k1; k <= k2; k++) {
      const ca = A.coh[k], cb = B.coh[k];
      let w = 1;
      if (ca === ca && cb === cb) w = Math.max(0.02, Math.min(ca, cb));
      const f = k * FS / P;
      w /= f; // equal weight per octave
      const ma = Math.hypot(A.Hre[k], A.Him[k]), mb = Math.hypot(B.Hre[k], B.Him[k]);
      bins.push({ w, f, ar: A.Hre[k], ai: A.Him[k], br: B.Hre[k], bi: B.Him[k] });
      idealSum += w * (ma + mb) * (ma + mb);
    }
    return (tauMs, pol) => {
      let s = 0;
      const tauS = tauMs / 1000;
      for (const b of bins) {
        const ang = -2 * Math.PI * b.f * tauS;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const r = b.ar + pol * (b.br * ca - b.bi * sa), i = b.ai + pol * (b.br * sa + b.bi * ca);
        s += b.w * (r * r + i * i);
      }
      return s / (idealSum || 1e-300);
    };
  }

  // tau > 0 : delay B (sub) by tau ms.  tau < 0 : delay A (main) by -tau ms.
  // A0/B0 may be arrays (same zones measured at several mic positions): the summation
  // curves are averaged across positions, the way you would spatially average in Smaart.
  function alignPair(A0, B0, f0, opts) {
    opts = opts || {};
    const As = Array.isArray(A0) ? A0 : [A0], Bs = Array.isArray(B0) ? B0 : [B0];
    const maxMs = opts.maxMs || 20, step = opts.stepMs || 0.02;
    const o = opts.octaves || 1.5;
    const useWin = opts.window !== false;
    let expSum = 0;
    const narrowS = [], wideS = [];
    for (let i = 0; i < As.length; i++) {
      const a0 = As[i], b0 = Bs[i];
      expSum += -(bandArrival(b0, f0) - bandArrival(a0, f0)) / FS * 1000;
      const A = useWin ? windowedTF(a0, a0.T, 1.5 / f0, 3 / f0) : a0;
      const B = useWin ? windowedTF(b0, b0.T, 1.5 / f0, 3 / f0) : b0;
      narrowS.push(makeScorer(A, B, f0 * Math.pow(2, -o / 2), f0 * Math.pow(2, o / 2)));
      wideS.push(makeScorer(A, B, f0 * Math.pow(2, -1.5), f0 * Math.pow(2, 1.5)));
    }
    const avg = (arr) => (t, p) => { let s = 0; for (const f of arr) s += f(t, p); return s / arr.length; };
    const score = avg(narrowS), wide = avg(wideS);
    const expected = expSum / As.length;
    const fLo = f0 * Math.pow(2, -o / 2), fHi = f0 * Math.pow(2, o / 2);
    const curve = { taus: [], pos: [], neg: [] };
    for (let t = -maxMs; t <= maxMs + 1e-9; t += step) {
      curve.taus.push(t); curve.pos.push(score(t, 1)); curve.neg.push(score(t, -1));
    }
    let gmax = 0;
    for (let i = 0; i < curve.taus.length; i++) gmax = Math.max(gmax, curve.pos[i], curve.neg[i]);
    const cands = [];
    for (const [arr, pol] of [[curve.pos, 1], [curve.neg, -1]]) {
      for (let i = 1; i < arr.length - 1; i++) {
        if (arr[i] >= arr[i - 1] && arr[i] >= arr[i + 1] && arr[i] >= gmax * 0.79) {
          const a = arr[i - 1], b = arr[i], c = arr[i + 1];
          const den = a - 2 * b + c;
          const d = den < 0 ? 0.5 * (a - c) / den : 0;
          const tau = curve.taus[i] + d * step;
          cands.push({ tau, pol, eff: b, wide: wide(tau, pol) });
        }
      }
    }
    // Rank: narrow-band sum + wide-band sum (rejects wrong-cycle solutions), small preference
    // for normal polarity and for the band-limited arrival difference.
    const period = 1000 / f0;
    for (const c of cands) {
      c.rank = c.eff + c.wide - (c.pol < 0 ? 0.02 : 0) - 0.05 * Math.min(1, Math.abs(c.tau - expected) / period);
    }
    cands.sort((p, q) => q.rank - p.rank);
    const best = cands[0] || { tau: 0, pol: 1, eff: score(0, 1) };
    const now = score(0, 1);
    const runner = cands[1];
    const confident = !runner || (best.rank - runner.rank) > 0.08;
    return {
      confident, alt: runner || null,
      tauMs: best.tau, polarity: best.pol, eff: best.eff, effNow: now,
      gainDb: 10 * Math.log10(best.eff / Math.max(now, 1e-9)), expectedMs: expected,
      candidates: cands.slice(0, 4), curve, f0, fLo, fHi, windowed: useWin, positions: As.length
    };
  }

  // Complex sum of two zones with a delay (ms, applied to B) and polarity
  function sumZones(A, B, tauMs, pol) {
    const Hre = new Float64Array(HALF + 1), Him = new Float64Array(HALF + 1);
    const ts = (tauMs || 0) / 1000;
    for (let k = K_LO; k <= K_HI; k++) {
      const ang = -2 * Math.PI * (k * FS / P) * ts;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      Hre[k] = A.Hre[k] + pol * (B.Hre[k] * ca - B.Him[k] * sa);
      Him[k] = A.Him[k] + pol * (B.Hre[k] * sa + B.Him[k] * ca);
    }
    return { Hre, Him };
  }

  // Fractional-octave smoothed magnitude (dB) and phase (deg) on a log frequency grid.
  // delaySamples: removed from the phase (time reference).
  function smoothTF(Hre, Him, opts) {
    opts = opts || {};
    const frac = opts.frac || 6, nPts = opts.points || 360;
    const f1 = opts.f1 || 20, f2 = opts.f2 || 20000;
    const d = opts.delaySamples || 0;
    const cr = new Float64Array(HALF + 2), ci = new Float64Array(HALF + 2), cp = new Float64Array(HALF + 2);
    for (let k = 0; k <= HALF; k++) {
      let r = Hre[k] || 0, i = Him[k] || 0;
      if (d) {
        const a = 2 * Math.PI * ((k * mod(d, P)) % P) / P;
        const ca = Math.cos(a), sa = Math.sin(a);
        const nr = r * ca - i * sa; i = r * sa + i * ca; r = nr;
      }
      cr[k + 1] = cr[k] + r; ci[k + 1] = ci[k] + i; cp[k + 1] = cp[k] + r * r + i * i;
    }
    const f = [], mag = [], ph = [];
    const half = Math.pow(2, 1 / (2 * frac));
    for (let j = 0; j < nPts; j++) {
      const fc = f1 * Math.pow(f2 / f1, j / (nPts - 1));
      let ka = Math.max(K_LO, Math.floor(fc / half * P / FS)), kb = Math.min(K_HI, Math.ceil(fc * half * P / FS));
      if (kb < ka) kb = ka;
      const n = kb - ka + 1;
      const pr = (cp[kb + 1] - cp[ka]) / n;
      const sr = (cr[kb + 1] - cr[ka]) / n, si = (ci[kb + 1] - ci[ka]) / n;
      f.push(fc); mag.push(10 * Math.log10(pr + 1e-30)); ph.push(Math.atan2(si, sr) * 180 / Math.PI);
    }
    return { f, mag, ph };
  }

  function smoothCoh(coh, opts) {
    opts = opts || {};
    const frac = opts.frac || 6, nPts = opts.points || 360, f1 = opts.f1 || 20, f2 = opts.f2 || 20000;
    const half = Math.pow(2, 1 / (2 * frac));
    const out = [];
    for (let j = 0; j < nPts; j++) {
      const fc = f1 * Math.pow(f2 / f1, j / (nPts - 1));
      const ka = Math.max(K_LO, Math.floor(fc / half * P / FS)), kb = Math.max(ka, Math.min(K_HI, Math.ceil(fc * half * P / FS)));
      let s = 0, n = 0;
      for (let k = ka; k <= kb; k++) { const c = coh[k]; if (c === c) { s += c; n++; } }
      out.push(n ? s / n : NaN);
    }
    return out;
  }

  // Speed of sound in air (m/s) from temperature (deg C) and relative humidity (%).
  // Ideal-gas temperature term plus the standard humidity correction (+~0.0124 m/s per %RH at room temp,
  // growing with temperature because warm air holds more water vapour).
  function speedOfSound(tempC, rh) {
    const T = tempC == null ? 21 : tempC, H = rh == null ? 50 : Math.max(0, Math.min(100, rh));
    const dry = 331.3 * Math.sqrt(1 + T / 273.15);
    // water-vapour mole fraction (Buck saturation pressure, sea-level pressure)
    const psat = 0.61121 * Math.exp((18.678 - T / 234.5) * (T / (257.14 + T)));  // kPa
    const xw = (H / 100) * psat / 101.325;
    // c ~ c_dry * (1 + 0.16 * xw) (gamma/molar-mass change of moist air)
    return dry * (1 + 0.16 * xw);
  }

  // Simple windowed-sinc resampler (for decoded files / odd device rates)
  function resample(x, fromRate, toRate) {
    if (fromRate === toRate) return x;
    const ratio = fromRate / toRate, n = Math.floor(x.length / ratio);
    const y = new Float32Array(n), taps = 16;
    const fc = Math.min(1, 1 / ratio) * 0.95;
    for (let i = 0; i < n; i++) {
      const t = i * ratio, t0 = Math.floor(t);
      let s = 0, ws = 0;
      for (let j = t0 - taps + 1; j <= t0 + taps; j++) {
        if (j < 0 || j >= x.length) continue;
        const d = t - j;
        const sinc = d === 0 ? 1 : Math.sin(Math.PI * fc * d) / (Math.PI * fc * d);
        const w = 0.5 + 0.5 * Math.cos(Math.PI * d / taps);
        s += x[j] * sinc * w; ws += sinc * w;
      }
      y[i] = ws ? s / ws : 0;
    }
    return y;
  }

  const api = {
    FS, P, HALF, HOP, F_LO, F_HI, K_LO, K_HI, MANUAL_ID, MAX_ZONES,
    FFT, getFFT, getSequence, Analyzer, solve, bandArrival, alignPair, windowedTF, sumZones,
    smoothTF, smoothCoh, meanCoh, analyticIR, peakOf, wrapHalf, speedOfSound, resample, mulberry32
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
