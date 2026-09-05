/* demo-polyfills.js — runs first in the demo page.
   1. Surfaces any startup failure as a visible banner (instead of a silently broken page).
   2. Provides crypto.subtle.digest (SHA-1 / SHA-256) for viewers that are not a secure context. */
(() => {
  // ------------------------------------------------------------ 1. banner --
  const banner = (title, detail) => {
    const show = () => {
      let el = document.getElementById('demo-fatal');
      if (!el) {
        el = document.createElement('div');
        el.id = 'demo-fatal';
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:#cf222e;color:#fff;padding:10px 16px;font:13px/1.4 system-ui,sans-serif;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,.3)';
        document.body ? document.body.appendChild(el) : document.documentElement.appendChild(el);
      }
      el.textContent = `ColabHub demo — ${title}\n${detail}`;
    };
    document.body ? show() : document.addEventListener('DOMContentLoaded', show);
  };
  window.addEventListener('error', (e) => banner('script error', (e.error && e.error.stack) || e.message || String(e)));
  window.addEventListener('unhandledrejection', (e) => banner('unhandled promise rejection', (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason)));
  // Watchdog: if the module bundle never booted, scripts are being blocked by the host page.
  setTimeout(() => {
    if (typeof window.__popupBoot !== 'function') {
      banner(
        'the extension code did not start',
        'This viewer appears to block inline scripts. Download colabhub-demo.html and open it directly in Chrome, or use the live preview link.',
      );
    }
  }, 2500);

  // ------------------------------------------------- 2. crypto.subtle shim --
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  function pad(bytes) {
    const ml = bytes.length;
    const total = ((ml + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[ml] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor((ml * 8) / 0x100000000), false);
    dv.setUint32(total - 4, (ml * 8) >>> 0, false);
    return { dv, total };
  }

  function sha1(bytes) {
    const { dv, total } = pad(bytes);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Uint32Array(80);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
        e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    const out = new DataView(new ArrayBuffer(20));
    [h0, h1, h2, h3, h4].forEach((h, i) => out.setUint32(i * 4, h, false));
    return out.buffer;
  }

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256(bytes) {
    const { dv, total } = pad(bytes);
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    const out = new DataView(new ArrayBuffer(32));
    H.forEach((h, i) => out.setUint32(i * 4, h, false));
    return out.buffer;
  }

  const digest = async (alg, data) => {
    const name = String(typeof alg === 'string' ? alg : alg.name).toUpperCase().replace('-', '');
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (name === 'SHA1') return sha1(bytes);
    if (name === 'SHA256') return sha256(bytes);
    throw new Error('demo digest shim: unsupported algorithm ' + name);
  };
  const getRandomValues = (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; };

  globalThis.__demoDigest = digest; // exposed for the self-test
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    try {
      if (!globalThis.crypto) globalThis.crypto = {};
      if (!globalThis.crypto.getRandomValues) Object.defineProperty(globalThis.crypto, 'getRandomValues', { value: getRandomValues, configurable: true });
      Object.defineProperty(globalThis.crypto, 'subtle', { value: { digest }, configurable: true });
    } catch {
      globalThis.crypto = { getRandomValues, subtle: { digest } };
    }
    globalThis.__demoUsedDigestShim = true;
  }
})();
