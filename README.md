# TimeAlign

Speaker time alignment for Dante Virtual Soundcard / USB interfaces, using the same dual-FFT
transfer-function method as Smaart (H = Gxy/Gxx, coherence, IFFT impulse response, delay finder,
phase alignment of subs at the crossover).

- **Mac app (native, Core Audio):** download `TimeAlign.dmg` from Releases. Any Core Audio device and
  any of its channels (Dante Virtual Soundcard included) can be used for output and for the mic.
- **iPhone as the microphone:** open the GitHub Pages link in Safari on the iPhone, choose "Listen",
  tap Listen, then press "Play sequence only" in the Mac app.

Layout: `native/main.swift` (Mac app shell + Core Audio engine), `src/` (measurement engine `dsp.js`
and UI `app.js`), `python3 build.py` inlines `src/` into `dist/TimeAlign.html` → copy to `app/index.html`.
Tests in `test/` (Node simulations + Playwright).
