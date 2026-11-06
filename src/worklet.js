// AudioWorklet: forwards microphone (and loop-back) samples to the main thread in 2048-frame
// chunks, stamped with the context frame index so the analyzer keeps an exact sample clock.
class TACapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = 2048;
    this.a = new Float32Array(this.N);
    this.b = new Float32Array(this.N);
    this.fill = 0;
    this.f0 = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) {
      const c0 = inp[0], c1 = inp[1] || inp[0];
      let off = 0;
      while (off < c0.length) {
        if (this.fill === 0) this.f0 = currentFrame + off;
        const n = Math.min(c0.length - off, this.N - this.fill);
        this.a.set(c0.subarray(off, off + n), this.fill);
        this.b.set(c1.subarray(off, off + n), this.fill);
        this.fill += n; off += n;
        if (this.fill === this.N) {
          this.port.postMessage({ f: this.f0, a: this.a, b: this.b }, [this.a.buffer, this.b.buffer]);
          this.a = new Float32Array(this.N);
          this.b = new Float32Array(this.N);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('ta-capture', TACapture);
