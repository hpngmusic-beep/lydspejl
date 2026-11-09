// Lydspejl – måle-worklet
// K-vægtet loudness (ITU-R BS.1770-4) i 100 ms-blokke + true peak (4x oversampling).
class LydspejlMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    this.blk = Math.round(fs * 0.1);
    // Trin 1: high-shelf (hovedets akustik)
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    this.s1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0,
               2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
    // Trin 2: RLB high-pass
    f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs);
    a0 = 1 + K / Q + K * K;
    this.s2 = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
    this.z = new Float64Array(16);
    // True peak: 48-taps polyfase-FIR, 4 faser
    const N = 48; this.h = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      const t = (n - (N - 1) / 2) / 4;
      const s = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (N - 1));
      this.h[n] = s * w;
    }
    this.hl = new Float32Array(12); this.hr = new Float32Array(12); this.hp = 0;
    this.reset();
  }
  reset() { this.kl = 0; this.kr = 0; this.tl = 0; this.tr = 0; this.c = 0; }
  kf(x, o) {
    const z = this.z, a = this.s1, b = this.s2;
    let y = a[0] * x + a[1] * z[o] + a[2] * z[o + 1] - a[3] * z[o + 2] - a[4] * z[o + 3];
    z[o + 1] = z[o]; z[o] = x; z[o + 3] = z[o + 2]; z[o + 2] = y;
    x = y;
    y = x - 2 * z[o + 4] + z[o + 5] - b[3] * z[o + 6] - b[4] * z[o + 7];
    z[o + 5] = z[o + 4]; z[o + 4] = x; z[o + 7] = z[o + 6]; z[o + 6] = y;
    return y;
  }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const L = inp[0], R = inp[1] || inp[0], n = L.length, h = this.h, hl = this.hl, hr = this.hr;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const yl = this.kf(l, 0), yr = this.kf(r, 8);
      this.kl += yl * yl; this.kr += yr * yr;
      this.hp = (this.hp + 11) % 12; hl[this.hp] = l; hr[this.hp] = r;
      let tl = Math.abs(l), tr = Math.abs(r);
      for (let p = 0; p < 4; p++) {
        let al = 0, ar = 0;
        for (let k = 0; k < 12; k++) {
          const c = h[p + 4 * k], idx = (this.hp + k) % 12;
          al += c * hl[idx]; ar += c * hr[idx];
        }
        al = Math.abs(al); ar = Math.abs(ar);
        if (al > tl) tl = al; if (ar > tr) tr = ar;
      }
      if (tl > this.tl) this.tl = tl; if (tr > this.tr) this.tr = tr;
      if (++this.c >= this.blk) {
        this.port.postMessage({ kl: this.kl / this.c, kr: this.kr / this.c, tl: this.tl, tr: this.tr });
        this.reset();
      }
    }
    return true;
  }
}
registerProcessor('lydspejl-meter', LydspejlMeter);
