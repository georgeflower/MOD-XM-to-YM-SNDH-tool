/** In-place iterative radix-2 complex FFT (n must be a power of two). */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const xr = re[i + k + len / 2], xi = im[i + k + len / 2];
        const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

export const nextPow2 = (n: number) => { let p = 1; while (p < n) p <<= 1; return p; };

/** power spectrum |X[k]|^2 for k = 0..n/2 of a real signal zero-padded to a power of two */
export function powerSpectrum(x: Float64Array): { power: Float64Array; size: number } {
  const size = nextPow2(x.length);
  const re = new Float64Array(size), im = new Float64Array(size);
  re.set(x);
  fft(re, im);
  const power = new Float64Array(size / 2 + 1);
  for (let k = 0; k <= size / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  return { power, size };
}
