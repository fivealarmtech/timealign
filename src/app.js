(() => {
  'use strict';
  const { FS, P, HOP } = TA;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const COLORS = ['#4fc3f7', '#ffb547', '#81c784', '#f06292', '#ba68c8', '#fff176', '#4db6ac', '#e57373',
    '#90a4ae', '#aed581', '#9575cd', '#ff8a65', '#64b5f6', '#dce775', '#a1887f', '#f48fb1', '#cfd8dc'];
  const ROLES = { main: 'Main', sub: 'Sub', fill: 'Delay / fill', other: 'Other' };
  const ALL_IDS = Array.from({ length: TA.MAX_ZONES + 1 }, (_, i) => i);   // 0 = manual noise, 1..16 zones
  const dbToGain = (db) => Math.pow(10, db / 20);
  const fix = (v, d = 2) => (v >= 0 ? '' : '−') + Math.abs(v).toFixed(d);
  const fixS = (v, d = 2) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d);

  // ------------------------------------------------------------------ settings
  const DEF = {
    role: 'mac', mode: 'auto',
    zones: [
      { id: 1, name: 'Main L', ch: '1', role: 'main', cur: 0, on: true },
      { id: 2, name: 'Main R', ch: '2', role: 'main', cur: 0, on: true },
      { id: 3, name: 'Subs', ch: '3', role: 'sub', cur: 0, on: true },
    ],
    outId: '', inId: '', micCh: 1, refMode: 'internal', refOut: 2, level: -18, xo: 100, haas: 5,
    temp: 72, tUnit: '°F', rh: 45, showAdj: false, showTemp: 82, showRh: 60, dUnit: 'ft', calcDist: 40,
    speed: 6, manCh: '1,2', posName: 'Position 1', avgSub: true,
  };
  let S = load();
  function load() {
    try {
      const j = JSON.parse(localStorage.getItem('timealign.v1') || 'null');
      if (j && Array.isArray(j.zones)) return Object.assign(JSON.parse(JSON.stringify(DEF)), j);
    } catch (e) { /* storage unavailable */ }
    return JSON.parse(JSON.stringify(DEF));
  }
  function save() { try { localStorage.setItem('timealign.v1', JSON.stringify(S)); } catch (e) { /* ignore */ } }

  const parseCh = (s) => String(s || '').split(/[\s,;+]+/).map(Number).filter((n) => n >= 1 && n <= 64 && Number.isInteger(n));
  const zoneCfg = (id) => S.zones.find((z) => z.id === id) ||
    { id, name: id === 0 ? 'Test noise' : 'Send ' + id, role: id === 1 ? 'main' : 'fill', cur: 0, on: true, ch: String(id) };
  const colorOf = (id) => COLORS[(id + 16) % COLORS.length];

  // ------------------------------------------------------------------ conditions
  const tempC = (t = S.temp, u = S.tUnit) => (u === '°F' ? (t - 32) * 5 / 9 : +t);
  const cNow = () => TA.speedOfSound(tempC(), S.rh);
  const cShow = () => TA.speedOfSound(tempC(S.showTemp), S.showRh);
  const distTxt = (ms, c) => {
    const m = Math.abs(ms) / 1000 * (c || cNow());
    return S.dUnit === 'ft' ? (m * 3.28084).toFixed(1) + ' ft' : m.toFixed(2) + ' m';
  };

  // ------------------------------------------------------------------ audio engine
  const E = {
    ctx: null, merger: null, nOut: 0, srcs: new Map(), t0F: 0, stream: null, cap: null, micSrc: null,
    an: null, inCh: 0, sinkOk: typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
    manualOn: false, devices: [], seqReady: false,
  };

  // ---- Native Mac app (Core Audio) bridge ----------------------------------------------------
  const NATIVE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ta);
  const nat = { devices: [], defOut: '', defIn: '', devWait: null, openWait: null, playRef: { frame: 0, t: 0 }, seqSent: false };
  const natPost = (o) => window.webkit.messageHandlers.ta.postMessage(o);
  function b64f32(str) {
    const bin = atob(str), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Float32Array(u8.buffer);
  }
  function f32b64(f) {
    const u8 = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let out = '';
    for (let i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(out);
  }
  window.__native = {
    onDevices(list, defs) { nat.devices = list || []; nat.defOut = (defs || [])[0] || ''; nat.defIn = (defs || [])[1] || ''; if (nat.devWait) { const w = nat.devWait; nat.devWait = null; w(); } },
    onDevicesChanged() { listDevices().catch(() => {}); },
    onOpen(r) { if (nat.openWait) { const w = nat.openWait; nat.openWait = null; w(r); } },
    onFile(names, b64) {
      const bin = atob(b64), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      analyzeFile({ name: (names || ['recording'])[0], arrayBuffer: async () => u8.buffer }).catch(showErr);
    },
    onChunk(f, micB64, refB64, playFrame) {
      nat.playRef = { frame: playFrame, t: performance.now() };
      onChunk(f, b64f32(micB64), b64f32(refB64), true);
    },
  };
  const engineOn = () => (NATIVE ? E.native : !!E.ctx);

  function setStatus(t, cls) { const el = $('#progTxt'); el.textContent = t; el.className = 'hint ' + (cls || ''); }
  function banner(html) { const b = $('#banner'); if (!html) { b.hidden = true; return; } b.innerHTML = html; b.hidden = false; }

  async function prepareSequences() {
    for (const id of ALL_IDS) {
      if (!E.seqReady) setStatus(`Preparing test signals… ${Math.round(id / ALL_IDS.length * 100)}%`);
      TA.getSequence(id);
      await new Promise((r) => setTimeout(r, 0));
    }
    E.seqReady = true;
  }

  function fillMicCh() {
    const sel = $('#micCh');
    const dev = nat.devices.find((d) => d.uid === S.inId);
    const n = NATIVE ? Math.max(1, Math.min(128, (dev && dev.inCh) || 2)) : 2;
    sel.innerHTML = '';
    for (let i = 1; i <= n; i++) { const o = document.createElement('option'); o.value = String(i); o.textContent = String(i); sel.appendChild(o); }
    if (+S.micCh > n) S.micCh = 1;
    sel.value = String(S.micCh);
  }
  async function listDevicesNative() {
    await new Promise((res) => { nat.devWait = res; natPost({ cmd: 'devices' }); setTimeout(res, 3000); });
    const outs = nat.devices.filter((d) => d.outCh > 0), ins = nat.devices.filter((d) => d.inCh > 0);
    const rateTxt = (d) => (Math.abs(d.rate - FS) > 1 && d.rate ? ` · ${d.rate / 1000} kHz` : '');
    const fillN = (sel, list, kind, val) => {
      sel.innerHTML = '';
      for (const d of list) {
        const o = document.createElement('option'); o.value = d.uid;
        o.textContent = `${d.name} — ${kind === 'out' ? d.outCh + ' out' : d.inCh + ' in'}${rateTxt(d)}`;
        sel.appendChild(o);
      }
      sel.value = val;
    };
    const has = (list, uid) => list.some((d) => d.uid === uid);
    if (!has(outs, S.outId)) S.outId = ((outs.find((d) => /dante|dvs/i.test(d.name)) || outs.find((d) => d.uid === nat.defOut) || outs[0]) || {}).uid || '';
    if (!has(ins, S.inId)) S.inId = ((ins.find((d) => d.uid === nat.defIn) || ins[0]) || {}).uid || '';
    fillN($('#outSel'), outs, 'out', S.outId); fillN($('#inSel'), ins, 'in', S.inId);
    fillMicCh(); save();
    const dante = nat.devices.some((d) => /dante|dvs/i.test(d.name));
    const msg = S.role === 'mac' && !dante
      ? 'Dante Virtual Soundcard isn’t running, so macOS isn’t offering it. Open Dante Virtual Soundcard and press Start; it appears here automatically.' : '';
    $('#devMsg').innerHTML = msg; $('#devMsg').hidden = !msg;
  }

  async function listDevices() {
    if (NATIVE) return listDevicesNative();
    const devs = await navigator.mediaDevices.enumerateDevices();
    E.devices = devs;
    const fill = (sel, kind, cur) => {
      sel.innerHTML = '';
      const list = devs.filter((d) => d.kind === kind);
      for (const d of list) {
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || (kind === 'audioinput' ? 'Microphone' : 'Output') + ' ' + (sel.length + 1);
        sel.appendChild(o);
      }
      if (cur && list.some((d) => d.deviceId === cur)) sel.value = cur;
      return sel.value;
    };
    S.inId = fill($('#inSel'), 'audioinput', S.inId);
    if (E.sinkOk) S.outId = fill($('#outSel'), 'audiooutput', S.outId);
    else {
      $('#outSel').innerHTML = '<option value="">System output (use Chrome to choose a device)</option>';
    }
    const outs = devs.filter((d) => d.kind === 'audiooutput');
    const named = outs.some((d) => d.label);
    let msg = '';
    if (S.role === 'mac') {
      if (!E.sinkOk) msg = 'This browser can’t choose an output. Use Google Chrome, or set macOS System Settings → Sound → Output to Dante Virtual Soundcard.';
      else if (!named) msg = 'Chrome is hiding device names. Click the mic/tune icon in the address bar, allow the microphone, then press ↻ Refresh.';
      else if (!outs.some((d) => /dante|dvs/i.test(d.label))) msg = 'Dante Virtual Soundcard isn’t in the list. In the DVS app press Start, check it appears in Audio MIDI Setup, then press ↻ Refresh. (If macOS blocked it: System Settings → Privacy &amp; Security → allow Audinate.)';
    }
    $('#devMsg').innerHTML = msg; $('#devMsg').hidden = !msg;
  }

  async function closeEngine() {
    stopAll(true);
    if (NATIVE) { if (E.native) natPost({ cmd: 'close' }); E.native = false; E.manualOn = false; $('#manNoise').textContent = '▶ Start noise'; return; }
    try { if (E.stream) E.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { if (E.ctx) await E.ctx.close(); } catch (e) { /* ignore */ }
    E.ctx = null; E.srcs.clear(); E.stream = null; E.cap = null; E.merger = null; E.manualOn = false;
    $('#manNoise').textContent = '▶ Start noise';
  }

  async function openNative() {
    await closeEngine();
    lastSol = null;
    const playback = S.role === 'mac';
    const ref = playback && S.refMode === 'loop' ? (+S.micCh === 1 ? 2 : 1) : 0;
    setStatus('Opening audio devices…');
    const r = await new Promise((res) => {
      nat.openWait = res;
      natPost({ cmd: 'open', out: playback ? S.outId : '', in: S.inId, micCh: +S.micCh, refCh: ref });
      setTimeout(() => res({ ok: false, error: 'No answer from the audio system (if a microphone permission box is showing, answer it, then press Restart audio).' }), 30000);
    });
    if (!r || !r.ok) { setStatus((r && r.error) || 'Could not open the audio devices.', 'bad'); return; }
    E.native = true; E.nOut = r.outCh || 0; E.inCh = r.inCh || 0;
    if (!nat.seqSent) { for (const id of ALL_IDS) natPost({ cmd: 'seq', id, data: f32b64(TA.getSequence(id).x) }); nat.seqSent = true; }
    E.an = new TA.Analyzer({ candidates: ALL_IDS, useRef: !!ref });
    if (playback) $('#outInfo').innerHTML = `<b>${esc(r.outName || '')}</b>: ${E.nOut} output channel${E.nOut === 1 ? '' : 's'}`;
    $('#ctxInfo').innerHTML = `48 kHz · ${esc(r.inName || '')}: mic on input ${r.micCh} of ${E.inCh}` + (ref ? `, loop-back on ${ref}` : '') +
      (playback ? ` · ${esc(r.outName || '')}: ${E.nOut} outputs` : '') + ' · native Core Audio';
    $('#audioCfg').hidden = false;
    $('#startBtn').textContent = 'Restart audio';
    $('#startBtn').classList.remove('primary');
    setStatus('Ready.');
    updateLevelTxt();
  }

  async function openEngine() {
    if (NATIVE) return openNative();
    await closeEngine();
    lastSol = null;
    const playback = S.role === 'mac';
    const opts = { sampleRate: FS, latencyHint: 'playback' };
    if (playback && E.sinkOk && S.outId) opts.sinkId = S.outId;
    let ctx;
    try { ctx = new AudioContext(opts); } catch (e) { delete opts.sinkId; ctx = new AudioContext(opts); }
    E.ctx = ctx;
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* needs gesture */ } }
    if (ctx.sampleRate !== FS) {
      banner(`This browser opened audio at ${ctx.sampleRate} Hz; TimeAlign needs 48 kHz. Use Chrome (Mac) or Safari (iPhone), and set the interface / Dante Virtual Soundcard to 48 kHz.`);
    }
    let info = '';
    if (playback) {
      const max = Math.max(1, Math.min(32, ctx.destination.maxChannelCount || 2));
      try {
        ctx.destination.channelCount = max;
        ctx.destination.channelCountMode = 'explicit';
        ctx.destination.channelInterpretation = 'discrete';
      } catch (e) { /* keep default */ }
      E.nOut = ctx.destination.channelCount;
      E.merger = ctx.createChannelMerger(E.nOut);
      E.merger.connect(ctx.destination);
      const t0 = Math.ceil((ctx.currentTime + 0.25) * FS) / FS;
      E.t0F = Math.round(t0 * FS);
      for (const id of ALL_IDS) {
        const seq = TA.getSequence(id);
        const buf = ctx.createBuffer(1, P, FS);
        buf.copyToChannel(seq.x, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        const g = ctx.createGain(); g.gain.value = 0;
        src.connect(g);
        src.start(t0);   // every sequence starts on the same sample: their periods stay phase-locked
        E.srcs.set(id, { src, g });
      }
      const outName = (E.devices.find((d) => d.kind === 'audiooutput' && d.deviceId === S.outId) || {}).label || 'system output';
      $('#outInfo').innerHTML = `<b>${outName}</b>: ${E.nOut} output channel${E.nOut > 1 ? 's' : ''} available` +
        (E.nOut <= 2 ? ' <span class="warn">(only 2: if this is Dante VS / a multichannel interface, check its channel count and that you are in Chrome)</span>' : '');
    }
    // microphone
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
    if (S.inId) audio.deviceId = { exact: S.inId };
    try { E.stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) { delete audio.deviceId; E.stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    const tr = E.stream.getAudioTracks()[0];
    const st = tr.getSettings ? tr.getSettings() : {};
    E.inCh = st.channelCount || 1;
    E.micSrc = ctx.createMediaStreamSource(E.stream);
    const sink = ctx.createGain(); sink.gain.value = 0;
    sink.connect(ctx.destination);
    try {
      // blob: URL works on http(s); a data: URL is the fallback for pages opened straight from disk (file://)
      try { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))); }
      catch (e1) { await ctx.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(WORKLET_SRC)); }
      E.cap = new AudioWorkletNode(ctx, 'ta-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete',
      });
      E.cap.port.onmessage = (ev) => onChunk(ev.data.f, ev.data.a, ev.data.b);
    } catch (e) {
      // Fallback for browsers without AudioWorklet
      const sp = ctx.createScriptProcessor(4096, 2, 1);
      sp.channelCountMode = 'explicit'; sp.channelInterpretation = 'discrete';
      sp.onaudioprocess = (ev) => {
        const ib = ev.inputBuffer;
        const a = new Float32Array(ib.getChannelData(0));
        const b = ib.numberOfChannels > 1 ? new Float32Array(ib.getChannelData(1)) : a;
        onChunk(Math.round(ev.playbackTime * FS), a, b);
      };
      E.cap = sp;
    }
    E.micSrc.connect(E.cap);
    E.cap.connect(sink);
    E.an = new TA.Analyzer({ candidates: ALL_IDS, useRef: playback && S.refMode === 'loop' });
    info += `${ctx.sampleRate / 1000} kHz · input ${E.inCh} ch` + (playback ? ` · output ${E.nOut} ch` : '') +
      ` · ${E.cap instanceof AudioWorkletNode ? 'worklet' : 'script'} capture`;
    if (E.inCh < 2 && (S.micCh === 2 || S.refMode === 'loop')) info += ' · <span class="warn">input is mono: use “Mic is on input 1” and Internal reference</span>';
    $('#ctxInfo').innerHTML = info;
    $('#audioCfg').hidden = false;
    await listDevices();          // the engine's own mic stream is open now: names are visible
    $('#startBtn').textContent = 'Restart audio';
    $('#startBtn').classList.remove('primary');
    setStatus('Ready.');
    updateLevelTxt();
  }

  // ------------------------------------------------------------------ playback control
  function holdAt(param, t) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
    else { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); }
  }
  // Same calls drive Web Audio (browser) or the native Core Audio engine (Mac app).
  const pb = {
    now() { return NATIVE ? Math.round(nat.playRef.frame + (performance.now() - nat.playRef.t) * FS / 1000) : Math.round(E.ctx.currentTime * FS); },
    t0() { return NATIVE ? 0 : E.t0F; },
    route(id, chans) {
      const used = chans.filter((c) => c >= 1 && c <= E.nOut);
      const extra = S.refMode === 'loop' && S.refOut >= 1 && S.refOut <= E.nOut && !used.includes(+S.refOut) ? [+S.refOut] : [];
      if (NATIVE) { natPost({ cmd: 'route', id, chans: used.concat(extra) }); return used; }
      const s = E.srcs.get(id); if (!s) return [];
      try { s.g.disconnect(E.merger); } catch (e) { /* not connected */ }
      for (const c of used.concat(extra)) s.g.connect(E.merger, 0, c - 1);
      return used;
    },
    on(id, frame, level, rampS) {
      if (NATIVE) { natPost({ cmd: 'gate', id, frame, target: level, ramp: Math.round(rampS * FS) }); return; }
      const g = E.srcs.get(id).g.gain, t = frame / FS;
      g.setValueAtTime(0, t); g.linearRampToValueAtTime(level, t + rampS);
    },
    off(id, frame, level, rampS) {
      if (NATIVE) { natPost({ cmd: 'gate', id, frame: frame - Math.round(rampS * FS), target: 0, ramp: Math.round(rampS * FS) }); return; }
      const g = E.srcs.get(id).g.gain, t = frame / FS;
      g.setValueAtTime(level, t - rampS); g.linearRampToValueAtTime(0, t);
    },
    set(id, level, rampS) {
      if (NATIVE) { natPost({ cmd: 'gate', id, frame: -1, target: level, ramp: Math.round(rampS * FS) }); return; }
      const g = E.srcs.get(id).g.gain, t = E.ctx.currentTime;
      holdAt(g, t); g.linearRampToValueAtTime(level, t + rampS);
    },
    silence() {
      if (NATIVE) { if (E.native) natPost({ cmd: 'stopAll' }); return; }
      if (!E.ctx) return;
      const t = E.ctx.currentTime;
      for (const s of E.srcs.values()) { holdAt(s.g.gain, t); s.g.gain.linearRampToValueAtTime(0, t + 0.03); }
    },
  };
  function route(id, chans) { return pb.route(id, chans); }
  function stopAll(quiet) {
    pb.silence();
    E.manualOn = false;
    $('#manNoise').textContent = '▶ Start noise';
    if (seq.timer) { clearInterval(seq.timer); seq.timer = null; }
    seq.playing = false;
    $('#stopBtn').classList.remove('live');
    if (sess.kind === 'auto' && !quiet) { sess.kind = null; setStatus('Stopped.', 'warn'); }
    if (!quiet) setProg(0);
  }
  function updateLevelTxt() {
    $('#levelTxt').textContent = `${S.level} dB → pink noise ≈ ${(S.level - 12).toFixed(0)} dBFS RMS`;
    if (engineOn() && E.manualOn) pb.set(0, dbToGain(S.level), 0.05);
  }

  // Auto sequence: each checked speaker gets K periods of its own noise sequence, then the first
  // one again at the end (book-end) so clock drift between devices can be measured precisely.
  const seq = { timer: null, playing: false };
  function playSequence(listen) {
    if (!engineOn() || S.role !== 'mac') { setStatus('Start audio first.', 'bad'); return; }
    stopAll(true);
    const zones = S.zones.filter((z) => z.on && z.id >= 1);
    if (!zones.length) { setStatus('Check at least one speaker.', 'bad'); return; }
    const missing = [];
    for (const z of zones) {
      const used = route(z.id, parseCh(z.ch));
      if (!used.length) missing.push(z.name);
    }
    if (missing.length) { setStatus(`No valid output channel for: ${missing.join(', ')} (device has ${E.nOut} channels).`, 'bad'); return; }
    const K = +S.speed;
    const order = zones.map((z) => z.id); order.push(zones[0].id);
    const nowF = pb.now();
    const m = Math.ceil((nowF + 0.3 * FS - pb.t0()) / P);
    const start = pb.t0() + m * P, segF = K * P, L = dbToGain(S.level), ramp = 0.02;
    order.forEach((id, i) => {
      pb.on(id, start + i * segF, L, ramp);
      pb.off(id, start + (i + 1) * segF, L, ramp);
    });
    const endF = start + order.length * segF;
    seq.playing = true;
    $('#stopBtn').classList.add('live');
    if (listen) startSession('auto', { name: S.posName || 'Position', ids: new Set(order) });
    const total = (endF - nowF) / FS + (listen ? (P / FS + 0.6) : 0);
    const t0 = pb.now() / FS;
    seq.timer = setInterval(() => {
      const f = pb.now(), t = f / FS;
      setProg((t - t0) / total);
      if (f < start) setStatus('Starting…');
      else if (f < endF) {
        const i = Math.floor((f - start) / segF), z = zoneCfg(order[i]);
        setStatus(`Playing ${i + 1}/${order.length}: ${z.name} (out ${z.ch})${i === order.length - 1 ? ' · repeat for drift check' : ''}`);
      } else if (t - t0 < total) setStatus(listen ? 'Analyzing…' : 'Sequence finished.');
      if (t - t0 >= total) {
        clearInterval(seq.timer); seq.timer = null; seq.playing = false;
        $('#stopBtn').classList.remove('live');
        setProg(1);
        if (listen) finishSession(); else setStatus('Sequence finished. Results are on the listening device.', 'good');
      }
    }, 120);
  }

  function toggleManualNoise() {
    if (!engineOn() || S.role !== 'mac') { setStatus('Start audio first.', 'bad'); return; }
    if (E.manualOn) { stopAll(true); setStatus('Noise off.'); return; }
    stopAll(true);
    const used = route(0, parseCh(S.manCh));
    if (!used.length) { setStatus(`Noise out channel must be 1–${E.nOut}.`, 'bad'); return; }
    pb.set(0, dbToGain(S.level), 0.5);
    E.manualOn = true;
    $('#manNoise').textContent = '■ Stop noise';
    $('#stopBtn').classList.add('live');
    if (sess.kind !== 'manual') startSession('manual', { name: S.posName || 'Manual' });
    setStatus(`Noise on out ${used.join(', ')}. Unmute one speaker, tap its name, then Capture.`);
  }

  function testZone(z) {
    if (!engineOn() || S.role !== 'mac') { setStatus('Start audio first.', 'bad'); return; }
    stopAll(true);
    const used = route(z.id, parseCh(z.ch));
    if (!used.length) { setStatus(`Out ch for ${z.name} must be 1–${E.nOut}.`, 'bad'); return; }
    pb.set(z.id, dbToGain(S.level), 0.1);
    pb.off(z.id, pb.now() + Math.round(2.2 * FS), dbToGain(S.level), 0.1);
    setStatus(`Test: ${z.name} on out ${used.join(', ')} for 2 s.`);
  }

  // ------------------------------------------------------------------ listening sessions
  // kind: 'auto' (Mac measures its own sequence), 'listen' (phone), 'manual'
  let sess = { kind: null, blocks: [], name: '', ids: null, capture: null, lastId: null, lastS: -1e15, idleSince: 0 };
  let wake = null;
  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
      if (!on && wake) { await wake.release(); wake = null; }
    } catch (e) { /* not supported */ }
  }
  function startSession(kind, o) {
    if (S.role === 'listen') keepAwake(true);
    sess = { kind, blocks: kind === 'manual' && sess.kind === 'manual' ? sess.blocks : [], name: o.name, ids: o.ids || null,
      capture: null, lastId: null, lastS: -1e15, idleSince: performance.now(), seen: new Map() };
    if (E.an) E.an.reset();
  }
  function finishSession() {
    if (!sess.kind) return;
    const kind = sess.kind, blocks = sess.blocks.slice();
    keepAwake(false);
    if (kind !== 'manual') sess.kind = null;
    $('#listenBtn').textContent = '● Listen';
    if (!blocks.length) { setStatus('No usable signal was detected. Check the mic level and that the noise is reaching the speakers.', 'bad'); return; }
    makeSnapshot(blocks, sess.name, kind);
  }

  // Each accepted block. The first block of each run is dropped (it straddles a switch-over).
  function onBlock(b) {
    showLive(b);
    if (!sess.kind) return;
    const isRunStart = b.id !== sess.lastId || b.s - sess.lastS > HOP * 1.5;
    sess.lastId = b.ok ? b.id : null; sess.lastS = b.s;
    if (!b.ok) {
      if (sess.kind === 'listen' && sess.blocks.length && performance.now() - sess.idleSince > 4000 && sess.seen.size >= 1) {
        // phone: sequence over (4 s of nothing after hearing speakers)
        if (sess.seen.size >= 2 || sess.blocks.length > 6) { setStatus('Sequence finished — analyzing…'); finishSession(); }
      }
      return;
    }
    sess.idleSince = performance.now();
    if (sess.kind === 'manual') {
      const c = sess.capture;
      if (!c || b.id !== 0 || b.s < c.fromFrame) return;
      b.label = c.zoneId; sess.blocks.push(b); c.got++;
      setProg(c.got / c.need);
      setStatus(`Capturing ${zoneCfg(c.zoneId).name}: ${c.got}/${c.need}`);
      if (c.got >= c.need) {
        sess.capture = null;
        $('#captureBtn').disabled = false;
        makeSnapshot(sess.blocks.slice(), sess.name, 'manual');
        setStatus(`${zoneCfg(c.zoneId).name} captured. Unmute the next speaker, tap it, Capture.`, 'good');
      }
      return;
    }
    if (b.id === 0) return;                              // manual noise heard during an auto run
    if (sess.ids && !sess.ids.has(b.id)) return;
    if (isRunStart) return;
    b.label = b.id; sess.blocks.push(b);
    sess.seen.set(b.id, (sess.seen.get(b.id) || 0) + 1);
    if (sess.kind === 'listen') {
      setStatus('Hearing: ' + Array.from(sess.seen.entries()).map(([id, n]) => `${zoneCfg(id).name} (${n})`).join(', '));
    }
  }

  function startCapture() {
    if (!E.an) { setStatus('Start audio first.', 'bad'); return; }
    const zid = +($('#manZones button.on') || {}).dataset?.id;
    if (!zid) { setStatus('Tap the speaker that is playing first.', 'bad'); return; }
    if (S.role === 'mac' && !E.manualOn) { setStatus('Start the noise first.', 'bad'); return; }
    if (sess.kind !== 'manual') startSession('manual', { name: S.posName || 'Manual' });
    sess.blocks = sess.blocks.filter((b) => b.label !== zid);   // re-capture replaces
    const nowF = lastFrame;
    sess.capture = { zoneId: zid, need: Math.max(4, +S.speed), got: 0, fromFrame: nowF + Math.round(0.25 * FS) };
    $('#captureBtn').disabled = true;
    setProg(0);
    setStatus(`Capturing ${zoneCfg(zid).name}…`);
    setTimeout(() => { if (sess.capture && sess.capture.zoneId === zid && sess.capture.got === 0) { setStatus(`Nothing usable yet from ${zoneCfg(zid).name}: check it is unmuted and the mic level.`, 'warn'); } }, 6000);
    setTimeout(() => { if (sess.capture && sess.capture.zoneId === zid) { sess.capture = null; $('#captureBtn').disabled = false; setStatus('Capture timed out — no clean signal. Is the noise reaching that speaker?', 'bad'); } }, 20000);
  }

  // ------------------------------------------------------------------ audio input
  let lastFrame = 0, meterPk = -120, meterT = 0;
  function onChunk(f, a, b, preselected) {
    lastFrame = f + a.length;
    const mic = preselected ? a : (S.micCh === 2 ? b : a);
    const ref = preselected ? b : (mic === a ? b : a);
    let pk = 0, ss = 0;
    for (let i = 0; i < mic.length; i++) { const v = mic[i]; ss += v * v; const av = v < 0 ? -v : v; if (av > pk) pk = av; }
    const now = performance.now();
    const pkDb = 20 * Math.log10(pk + 1e-9), rmsDb = 10 * Math.log10(ss / mic.length + 1e-12);
    meterPk = Math.max(pkDb, meterPk - (now - meterT) * 0.02); meterT = now;
    $('#meterBar').style.width = Math.max(0, Math.min(100, (rmsDb + 70) / 70 * 100)) + '%';
    let o2 = 0; const other = mic === a ? b : a;
    for (let i = 0; i < other.length; i += 4) o2 += other[i] * other[i];
    const otherDb = 10 * Math.log10(o2 / (other.length / 4) + 1e-12);
    $('#meterTxt').textContent = `in ${S.micCh} (mic) ${rmsDb.toFixed(0)} dBFS · peak ${meterPk.toFixed(0)}` + (meterPk > -1 ? ' CLIP' : '') +
      (E.inCh > 1 && !preselected ? `  |  in ${S.micCh === 1 ? 2 : 1}: ${otherDb.toFixed(0)}` : '');
    $('#meterTxt').style.color = meterPk > -1 ? '#ff6b6b' : '';
    if (!E.an) return;
    const blocks = E.an.push(mic, E.an.useRef ? ref : null, f);
    for (const blk of blocks) onBlock(blk);
  }

  // ------------------------------------------------------------------ live display
  let lastSol = null;   // most recent solve (for live delay readout)
  function showLive(b) {
    const cv = $('#liveCv');
    const z = zoneCfg(b.id);
    if (b.ok) {
      let txt = '—', info = `${b.id === 0 ? 'Test noise' : z.name} · quality ${b.snrDb.toFixed(0)} dB`;
      if (lastSol && lastSol.refT != null && lastSol.sol) {
        const sol = lastSol.sol;
        const ph = lastSol.phi0 + TA.wrapHalf(b.phi - lastSol.phi0);
        const rel = (ph - sol.eps * b.s - lastSol.refT);
        const relW = TA.wrapHalf(rel);
        txt = fix(relW / FS * 1000) + ' ms';
        info += ` · vs ${lastSol.refName}`;
      } else {
        txt = (b.phi / FS * 1000).toFixed(2) + ' ms';
        info += ' · raw (measure a reference first)';
      }
      $('#liveDelay').textContent = txt;
      $('#liveInfo').textContent = info;
    } else {
      $('#liveDelay').textContent = '—';
      $('#liveInfo').textContent = `No clear test signal (mic ${b.levelDb.toFixed(0)} dBFS)`;
    }
    // ETC around the peak
    const env = b.env, pk = Math.round(b.phi);
    const pre = Math.round(0.01 * FS), post = Math.round(0.09 * FS);
    let mx = 1e-12;
    for (let d = -pre; d <= post; d++) mx = Math.max(mx, env[((pk + d) % P + P) % P]);
    const ys = [], xs = [];
    const step = 8;
    for (let d = -pre; d <= post; d += step) {
      let m = 0; for (let j = 0; j < step; j++) m = Math.max(m, env[((pk + d + j) % P + P) % P]);
      xs.push(d / FS * 1000); ys.push(20 * Math.log10(m / mx + 1e-9));
    }
    plot(cv, { x: { min: -10, max: 90, label: 'ms from peak' }, y: { min: -60, max: 0, label: 'dB' },
      series: [{ xs, ys, color: b.ok ? colorOf(b.id) : '#556' }] });
  }

  // ------------------------------------------------------------------ snapshots & results
  const snaps = [];
  let snapSeq = 0, curSnap = null;
  function makeSnapshot(blocks, name, kind) {
    const sol = TA.solve(blocks);
    if (!sol || !sol.zones.size) { setStatus('Could not solve — not enough clean signal.', 'bad'); return; }
    for (const [id, z] of [...sol.zones]) if (z.n < 1) sol.zones.delete(id);
    let snap = kind === 'manual' ? snaps.find((s) => s.kind === 'manual' && s.name === name && s.open) : null;
    if (!snap) { snap = { id: ++snapSeq, name, kind, open: kind === 'manual' }; snaps.push(snap); }
    snap.sol = sol; snap.time = new Date(); snap.cond = { tC: tempC(), rh: +S.rh, c: cNow() };
    snap.cur = Object.fromEntries(S.zones.map((z) => [z.id, +z.cur || 0]));
    snap.loop = kind !== 'file' && !!(E.an && E.an.useRef);
    // remember for live delay readout
    const plan = computePlan(snap);
    if (plan && kind !== 'file') {
      const phi0 = sol.zones.get(plan.refId).T;
      lastSol = { sol, refT: sol.zones.get(plan.refId).T, refName: zoneCfg(plan.refId).name, phi0 };
    }
    curSnap = snap;
    renderSnapList();
    renderResults();
    if (kind !== 'manual') setStatus(`Measured ${sol.zones.size} speaker${sol.zones.size > 1 ? 's' : ''}` +
      (Math.abs(sol.ppm) > 0.5 ? ` · clock difference ${sol.ppm.toFixed(1)} ppm removed` : '') + '.', 'good');
  }

  function snapsWith(a, b, like) {
    return snaps.filter((s) => s.sol.zones.has(a) && s.sol.zones.has(b) &&
      (!like || ((s.cur[a] || 0) === (like.cur[a] || 0) && (s.cur[b] || 0) === (like.cur[b] || 0))));
  }

  function computePlan(snap) {
    if (!snap) return null;
    const zs = snap.sol.zones;
    const ids = [...zs.keys()].sort((a, b) => a - b);
    if (!ids.length) return null;
    const mains = ids.filter((id) => zoneCfg(id).role === 'main');
    const refId = mains.length ? mains[0] : ids[0];
    const ref = zs.get(refId);
    const c = snap.cond.c;
    const rows = [];
    const subs = ids.filter((id) => zoneCfg(id).role === 'sub' && id !== refId);
    const subRes = new Map();
    for (const sid of subs) {
      const use = S.avgSub ? snapsWith(refId, sid, snap) : [snap];
      const As = use.map((s) => s.sol.zones.get(refId)), Bs = use.map((s) => s.sol.zones.get(sid));
      subRes.set(sid, TA.alignPair(As, Bs, +S.xo || 100));
    }
    // If a sub needs negative delay, the mains (and everything aligned to them) move instead.
    let mainAdd = 0;
    for (const al of subRes.values()) mainAdd = Math.max(mainAdd, -al.tauMs);
    for (const id of ids) {
      const z = zs.get(id), cfg = zoneCfg(id);
      const rel = TA.wrapHalf(z.T - ref.T) / FS * 1000;
      let add = null, pol = 1, why = '';
      const role = cfg.role;
      if (role === 'main') { add = mainAdd; why = mainAdd > 0 ? 'moved later so the subs line up' : (id === refId ? 'reference' : ''); }
      else if (role === 'sub') {
        const al = subRes.get(id);
        if (al) { add = al.tauMs + mainAdd; pol = al.polarity; why = 'phase-aligned at ' + (+S.xo) + ' Hz'; }
      } else if (role === 'fill') { add = -rel + mainAdd + (+S.haas || 0); why = 'aligned to ' + zoneCfg(refId).name + (S.haas > 0 ? ` + ${S.haas} ms precedence` : ''); }
      const cur = snap.cur && snap.cur[id] != null ? snap.cur[id] : (+cfg.cur || 0);
      const setTo = add == null ? null : cur + add;
      let setShow = null;
      if (setTo != null && S.showAdj) {
        const h = role === 'fill' ? (+S.haas || 0) : 0;
        setShow = (setTo - h) * c / cShow() + h;
      }
      const coh = role === 'sub' ? TA.meanCoh(z, 40, 160) : TA.meanCoh(z, 300, 6000);
      rows.push({ id, cfg, z, rel, add, setTo, setShow, pol, why, coh, cur, isRef: id === refId });
    }
    return { refId, rows, subRes, mainAdd, c };
  }

  function renderSnapList() {
    const sel = $('#snapSel');
    sel.innerHTML = snaps.length ? '' : '<option value="">— none yet —</option>';
    for (const s of snaps) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = `${s.name} · ${s.time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${s.sol.zones.size} spk`;
      sel.appendChild(o);
    }
    if (curSnap) sel.value = curSnap.id;
  }

  function renderResults() {
    const plan = computePlan(curSnap);
    const todo = $('#todo'), body = $('#resBody'), notes = $('#notes');
    todo.innerHTML = ''; body.innerHTML = ''; notes.innerHTML = '';
    $('#thShow').hidden = !S.showAdj;
    if (!plan) { drawPlot(); return; }
    const cards = [];
    for (const r of plan.rows) {
      if (r.add == null) continue;
      const changed = Math.abs(r.add) >= 0.02 || r.pol < 0;
      const neg = r.setTo < -0.005;
      const cls = neg ? 'w' : changed ? '' : 'ok';
      let v = neg ? 'n/a' : `${Math.max(0, r.setTo).toFixed(2)}<small> ms</small>`;
      let s = changed ? `change ${fixS(r.add)} ms · ${r.why}` : 'already aligned ✓';
      if (neg) s = `needs ${fix(r.setTo)} ms: this speaker already arrives late here. Re-measure where it overlaps the mains, or delay the mains instead.`;
      if (r.setShow != null && !neg) s += ` · show: ${Math.max(0, r.setShow).toFixed(2)} ms`;
      const samples = !neg ? ` · ${Math.round(Math.max(0, r.setTo) * FS / 1000)} smp @48k` : '';
      cards.push(`<div class="t ${cls}"><div class="n">${esc(r.cfg.name)} · ${ROLES[r.cfg.role] || ''}</div><div class="v">${v}</div>` +
        `<div class="s">${s}${samples}</div>${r.pol < 0 ? '<div class="s warn"><b>Invert polarity</b> on this output</div>' : ''}` +
        (changed && !neg ? `<button data-apply="${r.id}" data-v="${Math.max(0, r.setTo).toFixed(2)}" style="margin-top:6px;font-size:12px;padding:3px 8px">Mark as entered</button>` : '') + `</div>`);
    }
    todo.innerHTML = cards.join('') || '<div class="hint">Mark speakers as Main / Sub / Delay to get console values.</div>';
    todo.querySelectorAll('button[data-apply]').forEach((btn) => {
      btn.onclick = () => {
        const z = S.zones.find((q) => q.id === +btn.dataset.apply);
        if (z) { z.cur = +btn.dataset.v; save(); renderZones(); }
        btn.textContent = 'Entered ✓ (measure again to verify)'; btn.disabled = true;
      };
    });
    for (const r of plan.rows) {
      const lowQ = r.z.snrDb < 15 || (r.coh === r.coh && r.coh < 0.5);
      const isSub = r.cfg.role === 'sub';
      body.insertAdjacentHTML('beforeend', `<tr class="${r.isRef ? 'ref' : ''}">
        <td><span class="sw" style="background:${colorOf(r.id)};width:10px;height:10px;display:inline-block;border-radius:3px;margin-right:6px"></span>${esc(r.cfg.name)}${r.isRef ? ' (ref)' : ''}</td>
        <td>${ROLES[r.cfg.role] || ''}</td>
        <td class="num">${isSub ? '≈ ' : ''}${fix(r.rel)} ms</td>
        <td class="num">${r.isRef ? '' : (r.rel < 0 ? 'closer ' : 'farther ') + distTxt(r.rel, plan.c)}</td>
        <td class="num ${lowQ ? 'warn' : ''}" title="impulse-response peak-to-noise · mean coherence · blocks">${r.z.snrDb.toFixed(0)} dB · ${r.coh === r.coh ? Math.round(r.coh * 100) + '%' : '—'} · ${r.z.n}</td>
        <td class="num">${r.add == null ? '—' : fixS(r.add)}${r.pol < 0 ? ' ⟲' : ''}</td>
        <td class="num"><b>${r.setTo == null ? '—' : r.setTo.toFixed(2) + ' ms'}</b></td>
        ${S.showAdj ? `<td class="num">${r.setShow == null ? '—' : r.setShow.toFixed(2) + ' ms'}</td>` : ''}</tr>`);
    }
    const n = [];
    const sol = curSnap.sol;
    if (Math.abs(sol.ppm) > 0.5) n.push(`Clock difference between the playing and listening devices: ${sol.ppm.toFixed(1)} ppm (removed).`);
    if (curSnap.loop) n.push('Loop-back reference: true flight times (system latency removed): ' +
      plan.rows.map((r) => `${esc(r.cfg.name)} ${(TA.wrapHalf(r.z.T) / FS * 1000).toFixed(2)} ms (${distTxt(TA.wrapHalf(r.z.T) / FS * 1000, plan.c)})`).join(' · '));
    for (const [sid, al] of plan.subRes) {
      const nm = esc(zoneCfg(sid).name);
      n.push(`${nm}: best sum at ${+S.xo} Hz is ${al.tauMs >= 0 ? `delay ${nm} ${al.tauMs.toFixed(2)} ms` : `delay the mains ${(-al.tauMs).toFixed(2)} ms`}` +
        `${al.polarity < 0 ? ', polarity inverted' : ''}: <b>+${al.gainDb.toFixed(1)} dB</b> more output through the crossover (${Math.round(al.eff * 100)}% of a perfect sum, now ${Math.round(al.effNow * 100)}%).` +
        ` Based on ${al.positions} position${al.positions > 1 ? 's' : ''}.` +
        (!al.confident && al.alt ? ` <span class="warn">Close second choice: ${al.alt.tau >= 0 ? 'sub' : 'mains'} +${Math.abs(al.alt.tau).toFixed(2)} ms${al.alt.pol < 0 ? ', inverted' : ''}. Measure 1–2 more spots and keep “Average” on.</span>` : ''));
    }
    if (plan.mainAdd > 0) n.push(`The subs arrive late, so the mains get +${plan.mainAdd.toFixed(2)} ms and every delay speaker includes it.`);
    const low = plan.rows.filter((r) => r.z.snrDb < 12);
    if (low.length) n.push(`<span class="warn">Weak measurement for ${low.map((r) => esc(r.cfg.name)).join(', ')}: raise the noise level or use “Noisy room”.</span>`);
    notes.innerHTML = n.join('<br>');
    drawPlot();
  }

  function resultsText() {
    const plan = computePlan(curSnap);
    if (!plan) return 'No results yet.';
    const lines = [`TimeAlign: ${curSnap.name} · ${curSnap.time.toLocaleString()}`,
      `Conditions: ${S.temp}${S.tUnit}, ${S.rh}% RH (c = ${plan.c.toFixed(1)} m/s)` + (S.showAdj ? ` · show: ${S.showTemp}${S.tUnit}, ${S.showRh}%` : ''), ''];
    for (const r of plan.rows) {
      let l = `${r.cfg.name.padEnd(14)} ${(ROLES[r.cfg.role] || '').padEnd(12)} arrival ${fix(r.rel).padStart(8)} ms`;
      if (r.setTo != null) l += `  SET ${Math.max(0, r.setTo).toFixed(2)} ms (${fixS(r.add)})` + (r.pol < 0 ? ' POLARITY INVERT' : '');
      if (r.setShow != null) l += `  show ${Math.max(0, r.setShow).toFixed(2)} ms`;
      lines.push(l);
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ plots
  let plotKind = 'etc';
  function plot(cv, o) {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 600, H = cv.clientHeight || 200;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const L = 44, R = 10, T = 10, B = 24;
    const pw = W - L - R, ph = H - T - B;
    const xl = o.x.log;
    const xmap = (x) => L + pw * (xl ? Math.log(x / o.x.min) / Math.log(o.x.max / o.x.min) : (x - o.x.min) / (o.x.max - o.x.min));
    const ymap = (y) => T + ph * (1 - (y - o.y.min) / (o.y.max - o.y.min));
    g.font = '11px ui-monospace, Menlo, monospace';
    g.strokeStyle = '#1f2833'; g.fillStyle = '#6b7888'; g.lineWidth = 1;
    // grid
    const xt = xl ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((v) => v >= o.x.min && v <= o.x.max)
      : niceTicks(o.x.min, o.x.max, 8);
    for (const v of xt) {
      const x = xmap(v); g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
      g.fillText(xl ? (v >= 1000 ? v / 1000 + 'k' : v) : +v.toFixed(1), x - 8, H - 8);
    }
    for (const v of niceTicks(o.y.min, o.y.max, 6)) {
      const y = ymap(v); g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      g.fillText(+v.toFixed(0), 4, y + 4);
    }
    if (o.x.label) { g.fillStyle = '#56626f'; g.fillText(o.x.label, L + pw - g.measureText(o.x.label).width, T + 12); }
    for (const v of (o.vlines || [])) {
      g.strokeStyle = v.color || '#55606d'; g.setLineDash([4, 4]);
      const x = xmap(v.x); g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.setLineDash([]);
      if (v.label) { g.fillStyle = v.color || '#8b98a7'; g.fillText(v.label, x + 3, T + 22); }
    }
    g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
    for (const s of o.series) {
      g.strokeStyle = s.color; g.lineWidth = s.width || 1.6; g.setLineDash(s.dash || []);
      g.beginPath(); let pen = false;
      for (let i = 0; i < s.xs.length; i++) {
        const y = s.ys[i];
        if (y == null || y !== y) { pen = false; continue; }
        const X = xmap(s.xs[i]), Y = ymap(Math.max(o.y.min - 5, Math.min(o.y.max + 5, y)));
        if (s.breakJump && pen && Math.abs(y - s.ys[i - 1]) > s.breakJump) pen = false;
        if (!pen) { g.moveTo(X, Y); pen = true; } else g.lineTo(X, Y);
      }
      g.stroke();
    }
    g.restore(); g.setLineDash([]);
  }
  function niceTicks(a, b, n) {
    const span = b - a, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = []; for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }

  function drawPlot() {
    const cv = $('#plotCv'), leg = $('#plotLegend');
    const plan = computePlan(curSnap);
    if (!plan) { plot(cv, { x: { min: -10, max: 60 }, y: { min: -60, max: 0 }, series: [] }); leg.innerHTML = ''; return; }
    const zs = curSnap.sol.zones, ref = zs.get(plan.refId);
    const legend = [], series = [];
    if (plotKind === 'etc') {
      let lo = -10, hi = 60;
      for (const r of plan.rows) { lo = Math.min(lo, r.rel - 10); hi = Math.max(hi, r.rel + 40); }
      lo = Math.max(lo, -200); hi = Math.min(hi, 300);
      let mx = 1e-12;
      for (const r of plan.rows) for (let i = 0; i < P; i++) mx = Math.max(mx, r.z.env[i]);
      const W = 700, step = Math.max(1, Math.round((hi - lo) / 1000 * FS / W));
      for (const r of plan.rows) {
        const xs = [], ys = [];
        const a = Math.round(lo / 1000 * FS), b = Math.round(hi / 1000 * FS);
        for (let d = a; d <= b; d += step) {
          let m = 0; for (let j = 0; j < step; j++) m = Math.max(m, r.z.env[((Math.round(ref.T) + d + j) % P + P) % P]);
          xs.push(d / FS * 1000); ys.push(20 * Math.log10(m / mx + 1e-9));
        }
        series.push({ xs, ys, color: colorOf(r.id) }); legend.push([colorOf(r.id), r.cfg.name]);
      }
      plot(cv, { x: { min: lo, max: hi, label: `ms after ${zoneCfg(plan.refId).name}` }, y: { min: -60, max: 0 }, series,
        vlines: [{ x: 0, color: '#ffb547' }] });
    } else if (plotKind === 'mag' || plotKind === 'phase') {
      let top = -1e9;
      const data = plan.rows.map((r) => {
        const t = TA.smoothTF(r.z.Hre, r.z.Him, { frac: plotKind === 'mag' ? 6 : 12, points: 420, delaySamples: ref.T });
        for (let i = 0; i < t.f.length; i++) top = Math.max(top, t.mag[i]);
        return { r, t };
      });
      for (const { r, t } of data) {
        const ys = plotKind === 'mag' ? t.mag.map((m) => m - top) :
          t.ph.map((p, i) => (t.mag[i] - top < -30 ? NaN : p));
        series.push({ xs: t.f, ys, color: colorOf(r.id), breakJump: plotKind === 'phase' ? 180 : 0 });
        legend.push([colorOf(r.id), r.cfg.name]);
      }
      plot(cv, plotKind === 'mag'
        ? { x: { min: 20, max: 20000, log: true, label: 'Hz' }, y: { min: -50, max: 5 }, series }
        : { x: { min: 20, max: 20000, log: true, label: `Hz · phase re ${zoneCfg(plan.refId).name} arrival` }, y: { min: -180, max: 180 }, series });
    } else {
      const sid = [...plan.subRes.keys()][0];
      if (sid == null) {
        plot(cv, { x: { min: 20, max: 500, log: true }, y: { min: -40, max: 5 }, series: [] });
        leg.innerHTML = 'Mark one speaker as Sub and one as Main to see the crossover sum.'; return;
      }
      const A = zs.get(plan.refId), B = zs.get(sid), al = plan.subRes.get(sid);
      const opt = { frac: 6, points: 300, f1: 20, f2: 500 };
      const now = TA.sumZones(A, B, 0, 1), best = TA.sumZones(A, B, al.tauMs, al.polarity);
      const curves = [
        [A, colorOf(plan.refId), zoneCfg(plan.refId).name, []],
        [B, colorOf(sid), zoneCfg(sid).name, []],
        [now, '#9aa5b1', 'Sum now', [5, 4]],
        [best, '#ffffff', 'Sum after alignment', []],
      ].map(([z, color, name, dash]) => ({ t: TA.smoothTF(z.Hre, z.Him, opt), color, name, dash }));
      let top = -1e9; for (const c of curves) for (const m of c.t.mag) top = Math.max(top, m);
      for (const c of curves) { series.push({ xs: c.t.f, ys: c.t.mag.map((m) => m - top), color: c.color, dash: c.dash, width: c.name.startsWith('Sum after') ? 2.4 : 1.5 }); legend.push([c.color, c.name]); }
      plot(cv, { x: { min: 20, max: 500, log: true, label: 'Hz' }, y: { min: -36, max: 3 }, series, vlines: [{ x: +S.xo, label: 'crossover', color: '#ffb547' }] });
    }
    leg.innerHTML = legend.map(([c, n]) => `<span><i style="background:${c}"></i>${esc(n)}</span>`).join('');
  }

  // ------------------------------------------------------------------ recording import
  async function analyzeFile(file) {
    setStatus(`Decoding ${file.name}…`); setProg(0);
    let buf;
    try {
      const ab = await file.arrayBuffer();
      const dctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, FS, FS);
      buf = await dctx.decodeAudioData(ab);
    } catch (e) { setStatus('Could not decode that file. Use WAV, or a Voice Memo in “Compressed” (not Lossless) format.', 'bad'); return; }
    let x = buf.getChannelData(0);
    if (buf.sampleRate !== FS) x = TA.resample(x, buf.sampleRate, FS);
    if (!E.seqReady) await prepareSequences();
    const an = new TA.Analyzer({ candidates: ALL_IDS });
    const blocksOut = [], seen = new Map();
    let lastId = null, lastS = -1e15;
    const CH = 4096;
    for (let i = 0; i + CH <= x.length; i += CH) {
      const blocks = an.push(x.subarray(i, i + CH), null, i);
      for (const b of blocks) {
        const isRunStart = b.id !== lastId || b.s - lastS > HOP * 1.5;
        lastId = b.ok ? b.id : null; lastS = b.s;
        if (b.ok && b.id !== 0 && !isRunStart) { b.label = b.id; blocksOut.push(b); seen.set(b.id, (seen.get(b.id) || 0) + 1); }
      }
      if (blocks.length) { setProg(i / x.length); setStatus(`Analyzing ${file.name}… ${Math.round(i / x.length * 100)}%`); await new Promise((r) => setTimeout(r, 0)); }
    }
    setProg(1);
    if (!blocksOut.length) { setStatus('No TimeAlign test sequence found in that recording.', 'bad'); return; }
    makeSnapshot(blocksOut, 'Recording: ' + file.name.replace(/\.[^.]+$/, ''), 'file');
  }

  // ------------------------------------------------------------------ setup code (Mac -> phone)
  function setupCode() {
    const o = { z: S.zones.map((z) => [z.id, z.name, z.role, +z.cur || 0]), x: +S.xo, h: +S.haas };
    return 'TA1:' + btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  }
  function applyCode(code) {
    const m = String(code).trim().match(/^TA1:(.+)$/);
    if (!m) throw new Error('not a TimeAlign code');
    const o = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
    S.zones = o.z.map(([id, name, role, cur]) => ({ id, name, role, cur, ch: String(id), on: true }));
    S.xo = o.x; S.haas = o.h; save(); syncInputs(); renderZones(); renderResults();
  }

  // ------------------------------------------------------------------ UI wiring
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  async function copyText(t) { if (NATIVE) { natPost({ cmd: 'copy', text: t }); return; } await navigator.clipboard.writeText(t); }
  function setProg(f) { $('#progBar').style.width = Math.max(0, Math.min(1, f)) * 100 + '%'; }

  function renderZones() {
    const tb = $('#zoneBody'); tb.innerHTML = '';
    for (const z of S.zones) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><input type="checkbox" ${z.on ? 'checked' : ''} title="Include in Auto measurement"></td>
        <td class="nm"><span class="sw" style="background:${colorOf(z.id)}"></span> <input type="text" value="${esc(z.name)}"></td>
        <td class="ch mac-only"><input type="text" value="${esc(z.ch)}"></td>
        <td><select>${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${z.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td class="cur"><input type="number" step="0.01" value="${z.cur}"></td>
        <td class="mac-only"><button title="Play noise to this speaker for 2 s">Test</button></td>
        <td><button title="Remove">✕</button></td>`;
      const [on, name, ch, role, cur] = tr.querySelectorAll('input, select');
      on.onchange = () => { z.on = on.checked; save(); };
      name.oninput = () => { z.name = name.value; save(); renderManualZones(); updateCode(); };
      name.onchange = () => renderResults();
      ch.oninput = () => { z.ch = ch.value; save(); };
      role.onchange = () => { z.role = role.value; save(); updateCode(); renderResults(); };
      cur.oninput = () => { z.cur = +cur.value || 0; save(); updateCode(); renderResults(); };
      const [test, del] = tr.querySelectorAll('button');
      test.onclick = () => testZone(z);
      del.onclick = () => { S.zones = S.zones.filter((q) => q !== z); save(); renderZones(); };
      tb.appendChild(tr);
    }
    renderManualZones(); updateCode();
  }
  function renderManualZones() {
    const box = $('#manZones'); const sel = +(($('#manZones button.on') || {}).dataset || {}).id;
    box.innerHTML = '';
    for (const z of S.zones) {
      const b = document.createElement('button');
      b.textContent = z.name; b.dataset.id = z.id;
      if (z.id === sel) b.classList.add('on');
      b.onclick = () => { $$('#manZones button').forEach((q) => q.classList.remove('on')); b.classList.add('on'); };
      box.appendChild(b);
    }
  }
  function updateCode() { $('#codeOut').value = setupCode(); }
  function nextZoneId() { for (let i = 1; i <= TA.MAX_ZONES; i++) if (!S.zones.some((z) => z.id === i)) return i; return null; }

  function syncInputs() {
    for (const k of ['xo', 'haas', 'temp', 'rh', 'showTemp', 'showRh', 'calcDist', 'manCh', 'posName', 'refOut', 'level']) { const el = $('#' + k); if (el) el.value = S[k]; }
    $('#tUnit').value = S.tUnit; $('#dUnit').value = S.dUnit; $('#speed').value = String(S.speed);
    $('#micCh').value = String(S.micCh); $('#refMode').value = S.refMode; $('#refOutLbl').hidden = S.refMode !== 'loop';
    $('#showAdj').checked = !!S.showAdj; $('#showRow').hidden = !S.showAdj; $('#avgSub').checked = !!S.avgSub;
    setRole(S.role, true); setMode(S.mode); updateCond();
  }
  function updateCond() {
    const c = cNow();
    const ftPerMs = c * 3.28084 / 1000, mPerMs = c / 1000;
    $('#cInfo').innerHTML = `Speed of sound <b>${c.toFixed(1)} m/s</b> (${(c * 3.28084).toFixed(0)} ft/s) · 1 ms = ${S.dUnit === 'ft' ? ftPerMs.toFixed(3) + ' ft' : (mPerMs * 100).toFixed(1) + ' cm'}` +
      (S.showAdj ? ` · show: ${cShow().toFixed(1)} m/s (delays ×${(c / cShow()).toFixed(4)})` : '');
    const d = +S.calcDist || 0, m = S.dUnit === 'ft' ? d / 3.28084 : d;
    const ms = m / c * 1000;
    let out = `${d} ${S.dUnit} → <b>${ms.toFixed(2)} ms</b> (${Math.round(ms * FS / 1000)} samples @48k)`;
    if (S.haas > 0) out += `<br>+ ${S.haas} ms precedence → <b>${(ms + +S.haas).toFixed(2)} ms</b>`;
    if (S.showAdj) out += `<br>at show conditions → <b>${(m / cShow() * 1000).toFixed(2)} ms</b>`;
    $('#calcOut').innerHTML = out;
  }
  function setRole(role, silent) {
    S.role = role; save();
    document.body.className = 'role-' + role;
    $$('#roleSeg button').forEach((b) => b.classList.toggle('on', b.dataset.role === role));
    if (!silent && engineOn()) openEngine().catch(showErr);
  }
  function setMode(mode) {
    S.mode = mode; save();
    $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#autoPane').hidden = mode !== 'auto'; $('#manualPane').hidden = mode !== 'manual';
    if (mode === 'auto' && E.manualOn) stopAll(true);
  }
  function showErr(e) {
    console.error(e);
    let msg = e && e.message ? e.message : String(e);
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) msg = 'Microphone permission was blocked. Allow the mic for this page (and for Chrome in macOS System Settings → Privacy → Microphone).';
    setStatus(msg, 'bad');
  }

  function bind() {
    $('#startBtn').onclick = async () => {
      if (NATIVE) {
        try { setStatus('Finding audio devices…'); await listDevices(); if (!E.seqReady) await prepareSequences(); await openEngine(); } catch (e) { showErr(e); }
        return;
      }
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          banner('This page can’t reach the microphone here. Open it from <b>https://</b> or <b>http://localhost</b> (see the included launcher), in Chrome on the Mac or Safari on iPhone.');
          return;
        }
        setStatus('Requesting microphone…');
        // Chrome only reveals device names (e.g. "Dante Virtual Soundcard") while a mic stream is open,
        // so list the devices BEFORE closing the permission stream.
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        await listDevices();
        tmp.getTracks().forEach((t) => t.stop());
        if (!E.seqReady) await prepareSequences();
        await openEngine();
      } catch (e) { showErr(e); }
    };
    $('#refreshDev').onclick = () => listDevices().catch(showErr);
    if (!NATIVE && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => { if (E.stream) listDevices().catch(() => {}); });
    }
    $('#outSel').onchange = () => { S.outId = $('#outSel').value; save(); openEngine().catch(showErr); };
    $('#inSel').onchange = () => { S.inId = $('#inSel').value; save(); if (NATIVE) fillMicCh(); openEngine().catch(showErr); };
    $('#micCh').onchange = () => { S.micCh = +$('#micCh').value; save(); if (NATIVE && engineOn()) openEngine().catch(showErr); };
    $('#refMode').onchange = () => { S.refMode = $('#refMode').value; save(); $('#refOutLbl').hidden = S.refMode !== 'loop'; if (E.ctx) openEngine().catch(showErr); };
    $('#refOut').onchange = () => { S.refOut = +$('#refOut').value; save(); };
    $('#level').oninput = () => { S.level = +$('#level').value; save(); updateLevelTxt(); };
    $('#stopBtn').onclick = () => { stopAll(false); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') stopAll(false); });
    $$('#roleSeg button').forEach((b) => { b.onclick = () => setRole(b.dataset.role); });
    $$('#modeSeg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    $$('#plotSeg button').forEach((b) => { b.onclick = () => { plotKind = b.dataset.p; $$('#plotSeg button').forEach((q) => q.classList.toggle('on', q === b)); drawPlot(); }; });
    $('#addZone').onclick = () => {
      const id = nextZoneId(); if (!id) return;
      const maxCh = S.zones.reduce((m, z) => Math.max(m, ...parseCh(z.ch), 0), 0);
      S.zones.push({ id, name: 'Delay ' + id, ch: String(maxCh + 1), role: 'fill', cur: 0, on: true }); save(); renderZones();
    };
    $('#presetBtn').onclick = () => {
      S.zones = [
        { id: 1, name: 'Main L', ch: '1', role: 'main', cur: 0, on: true },
        { id: 2, name: 'Main R', ch: '2', role: 'main', cur: 0, on: true },
        { id: 3, name: 'Subs', ch: '3', role: 'sub', cur: 0, on: true },
        { id: 4, name: 'Delay 1', ch: '4', role: 'fill', cur: 0, on: true },
        { id: 5, name: 'Delay 2', ch: '5', role: 'fill', cur: 0, on: true },
      ]; save(); renderZones();
    };
    const num = (id, key, after) => { $('#' + id).oninput = () => { S[key] = +$('#' + id).value; save(); updateCond(); if (after) after(); }; };
    num('xo', 'xo', renderResults); num('haas', 'haas', renderResults); num('temp', 'temp', renderResults); num('rh', 'rh', renderResults);
    num('showTemp', 'showTemp', renderResults); num('showRh', 'showRh', renderResults); num('calcDist', 'calcDist');
    $('#tUnit').onchange = () => {
      const u = $('#tUnit').value;
      if (u !== S.tUnit) {
        const conv = (t) => (u === '°C' ? (t - 32) * 5 / 9 : t * 9 / 5 + 32);
        S.temp = Math.round(conv(S.temp) * 10) / 10; S.showTemp = Math.round(conv(S.showTemp) * 10) / 10; S.tUnit = u;
        $('#temp').value = S.temp; $('#showTemp').value = S.showTemp;
      }
      save(); updateCond(); renderResults();
    };
    $('#dUnit').onchange = () => { S.dUnit = $('#dUnit').value; save(); updateCond(); renderResults(); };
    $('#showAdj').onchange = () => { S.showAdj = $('#showAdj').checked; $('#showRow').hidden = !S.showAdj; save(); updateCond(); renderResults(); };
    $('#avgSub').onchange = () => { S.avgSub = $('#avgSub').checked; save(); renderResults(); };
    $('#speed').onchange = () => { S.speed = +$('#speed').value; save(); };
    $('#posName').oninput = () => { S.posName = $('#posName').value; save(); };
    $('#manCh').oninput = () => { S.manCh = $('#manCh').value; save(); };
    $('#measureBtn').onclick = () => playSequence(true);
    $('#playSeqBtn').onclick = () => playSequence(false);
    $('#listenBtn').onclick = () => {
      if (!E.an) { setStatus('Start audio first.', 'bad'); return; }
      if (sess.kind === 'listen') { finishSession(); return; }
      startSession('listen', { name: S.posName || 'Position' });
      $('#listenBtn').textContent = '■ Finish';
      setStatus('Listening… press “Play sequence only” on the Mac.');
    };
    $('#manNoise').onclick = toggleManualNoise;
    $('#manListen').onclick = () => {
      if (!E.an) { setStatus('Start audio first.', 'bad'); return; }
      startSession('manual', { name: S.posName || 'Manual' });
      setStatus('Listening for the Mac’s manual noise. Tap the speaker that is on, then Capture.');
    };
    $('#captureBtn').onclick = startCapture;
    $('#newPosBtn').onclick = () => {
      for (const s of snaps) if (s.kind === 'manual') s.open = false;
      const n = (S.posName.match(/(\d+)$/) || [0, 0])[1];
      S.posName = n ? S.posName.replace(/\d+$/, String(+n + 1)) : S.posName + ' 2'; $('#posName').value = S.posName; save();
      sess = { kind: 'manual', blocks: [], name: S.posName, capture: null, lastId: null, lastS: -1e15, idleSince: performance.now(), seen: new Map() };
      setStatus(`New position: ${S.posName}. Capture each speaker again.`);
    };
    if (NATIVE) $('#fileIn').addEventListener('click', (e) => { e.preventDefault(); natPost({ cmd: 'openFile' }); });
    $('#fileIn').onchange = (e) => { const f = e.target.files[0]; if (f) analyzeFile(f).catch(showErr); e.target.value = ''; };
    $('#snapSel').onchange = () => { curSnap = snaps.find((s) => String(s.id) === $('#snapSel').value) || null; renderResults(); };
    $('#copyRes').onclick = async () => { try { await copyText(resultsText()); setStatus('Results copied.', 'good'); } catch (e) { setStatus('Copy failed: select the table and copy manually.', 'warn'); } };
    $('#clearRes').onclick = () => { snaps.length = 0; curSnap = null; lastSol = null; renderSnapList(); renderResults(); };
    $('#copyCode').onclick = async () => { try { await copyText(setupCode()); setStatus('Setup code copied — paste it on the iPhone.', 'good'); } catch (e) { $('#codeOut').select(); } };
    $('#applyCode').onclick = () => { try { applyCode($('#codeIn').value); setStatus('Speaker names loaded from the Mac.', 'good'); } catch (e) { setStatus('That code didn’t work: copy it again from the Mac.', 'bad'); } };
    window.addEventListener('resize', () => drawPlot());
  }

  // ------------------------------------------------------------------ boot
  bind(); renderZones(); syncInputs(); drawPlot();
  if (NATIVE) {
    document.documentElement.classList.add('native');
    $('#roleSeg button[data-role=listen]').textContent = 'Listen only';
  } else if (!window.isSecureContext) {
    banner('Microphone access needs a secure address. On the Mac, open TimeAlign with the included launcher (http://localhost) or from https://. On iPhone it must be an https:// link.');
  } else if (/iPhone|iPad|iPod/.test(navigator.userAgent) && S.role === 'mac') {
    setRole('listen', true);
  }
  // test hook
  window.__TA_APP = { NATIVE, pb, S, snaps, computePlan: () => computePlan(curSnap), get sess() { return sess; }, E, analyzeFile, applyCode, setupCode };
})();
