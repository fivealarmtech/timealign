# TimeAlign

Speaker time alignment for Dante Virtual Soundcard / USB interfaces, using the same dual-FFT
transfer-function method as Smaart (H = Gxy/Gxx, coherence, IFFT impulse response, delay finder,
phase alignment of subs at the crossover).

- **Mac app:** download the latest `.dmg` from Releases (arm64 = Apple Silicon).
- **iPhone as the microphone:** open the GitHub Pages link on the iPhone in Safari, choose
  "This device only listens", tap Listen, then press "Play sequence only" on the Mac.

Source: `src/` (dsp.js = measurement engine, app.js = UI). `python3 build.py` inlines everything
into `dist/TimeAlign.html`; copy it to `app/index.html`. Tests: `test/` (Node simulations).
