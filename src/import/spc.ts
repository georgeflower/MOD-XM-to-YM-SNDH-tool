/**
 * SNES SPC file player: SPC700 CPU + S-DSP emulation (sound only).
 *
 * An .spc file is a snapshot of the SNES sound unit: 64 KB RAM (music driver, sequence data and BRR samples), the 128 DSP
 * registers and the CPU state. The emulator runs the snapshot's own driver, so every music format of every game works.
 * The DSP follows the structure of the hardware (BRR decoder, gaussian interpolation, ADSR/GAIN envelopes, noise, pitch
 * modulation, echo with its FIR filter); only the 32-step internal pipeline is folded into one step per output sample.
 *
 * `SpcPlayer.run(n, out)` produces n stereo samples at 32 kHz; `SpcPlayer.dsp.onKon` and the per-voice state are what the
 * module converter (spcToModule) watches.
 */

const GAUSS = new Int16Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2,
  2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5,
  6, 6, 6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 9, 10, 10, 10,
  11, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 16, 16, 17, 17,
  18, 19, 19, 20, 20, 21, 21, 22, 23, 23, 24, 24, 25, 26, 27, 27,
  28, 29, 29, 30, 31, 32, 32, 33, 34, 35, 36, 36, 37, 38, 39, 40,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56,
  58, 59, 60, 61, 62, 64, 65, 66, 67, 69, 70, 71, 73, 74, 76, 77,
  78, 80, 81, 83, 84, 86, 87, 89, 90, 92, 94, 95, 97, 99, 100, 102,
  104, 106, 107, 109, 111, 113, 115, 117, 118, 120, 122, 124, 126, 128, 130, 132,
  134, 137, 139, 141, 143, 145, 147, 150, 152, 154, 156, 159, 161, 163, 166, 168,
  171, 173, 175, 178, 180, 183, 186, 188, 191, 193, 196, 199, 201, 204, 207, 210,
  212, 215, 218, 221, 224, 227, 230, 233, 236, 239, 242, 245, 248, 251, 254, 257,
  260, 263, 267, 270, 273, 276, 280, 283, 286, 290, 293, 297, 300, 304, 307, 311,
  314, 318, 321, 325, 328, 332, 336, 339, 343, 347, 351, 354, 358, 362, 366, 370,
  374, 378, 381, 385, 389, 393, 397, 401, 405, 410, 414, 418, 422, 426, 430, 434,
  439, 443, 447, 451, 456, 460, 464, 469, 473, 477, 482, 486, 491, 495, 499, 504,
  508, 513, 517, 522, 527, 531, 536, 540, 545, 550, 554, 559, 563, 568, 573, 577,
  582, 587, 592, 596, 601, 606, 611, 615, 620, 625, 630, 635, 640, 644, 649, 654,
  659, 664, 669, 674, 678, 683, 688, 693, 698, 703, 708, 713, 718, 723, 728, 732,
  737, 742, 747, 752, 757, 762, 767, 772, 777, 782, 787, 792, 797, 802, 806, 811,
  816, 821, 826, 831, 836, 841, 846, 851, 855, 860, 865, 870, 875, 880, 884, 889,
  894, 899, 904, 908, 913, 918, 923, 927, 932, 937, 941, 946, 951, 955, 960, 965,
  969, 974, 978, 983, 988, 992, 997, 1001, 1005, 1010, 1014, 1019, 1023, 1027, 1032, 1036,
  1040, 1045, 1049, 1053, 1057, 1061, 1066, 1070, 1074, 1078, 1082, 1086, 1090, 1094, 1098, 1102,
  1106, 1109, 1113, 1117, 1121, 1125, 1128, 1132, 1136, 1139, 1143, 1146, 1150, 1153, 1157, 1160,
  1164, 1167, 1170, 1174, 1177, 1180, 1183, 1186, 1190, 1193, 1196, 1199, 1202, 1205, 1207, 1210,
  1213, 1216, 1219, 1221, 1224, 1227, 1229, 1232, 1234, 1237, 1239, 1241, 1244, 1246, 1248, 1251,
  1253, 1255, 1257, 1259, 1261, 1263, 1265, 1267, 1269, 1270, 1272, 1274, 1275, 1277, 1279, 1280,
  1282, 1283, 1284, 1286, 1287, 1288, 1290, 1291, 1292, 1293, 1294, 1295, 1296, 1297, 1297, 1298,
  1299, 1300, 1300, 1301, 1302, 1302, 1303, 1303, 1303, 1304, 1304, 1304, 1304, 1304, 1305, 1305,
]);

const COUNTER_RANGE = 2048 * 5 * 3;
const COUNTER_RATES = [COUNTER_RANGE + 1, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1];
const COUNTER_OFFSETS = [1, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 0, 0];

const REL = 0, ATT = 1, DEC = 2, SUS = 3;

const clamp16 = (x: number): number => ((x << 16) >> 16) !== x ? (x >> 31) ^ 0x7fff : x;
const s16 = (x: number): number => (x << 16) >> 16;
const s8 = (x: number): number => (x << 24) >> 24;

export class Voice {
  buf = new Int32Array(24);
  bufPos = 0; interpPos = 0; brrAddr = 0; brrOffset = 1; konDelay = 0; envMode = REL; env = 0; hiddenEnv = 0; envxOut = 0;
  /** sum of the envelope level over the samples since the last reset (for the frame averages of the module converter) */
  envSum = 0;
  constructor(readonly vbit: number) {}
}

export interface KonEvent { voice: number; srcn: number; addr: number; loop: number; pitch: number; sample: number }

export class Dsp {
  regs = new Uint8Array(128);
  voices: Voice[] = [];
  noise = 0x4000; counter = 0; everyOther = 1; kon = 0; newKon = 0; tKoff = 0;
  tOutput = 0; endxBuf = 0; tLooped = 0;
  mainL = 0; mainR = 0; echoOutL = 0; echoOutR = 0; echoInL = 0; echoInR = 0;
  histL = new Int32Array(16); histR = new Int32Array(16); histPos = 0;
  echoOffset = 0; echoLength = 0; echoPtr = 0;
  sample = 0;
  /** called when a voice starts a new note (key-on takes effect) */
  onKon: ((e: KonEvent) => void) | null = null;
  outL = 0; outR = 0;
  mute = 0;

  constructor(public ram: Uint8Array) { for (let i = 0; i < 8; i++) this.voices.push(new Voice(1 << i)); }

  load(regs: Uint8Array): void {
    this.regs.set(regs.subarray(0, 128));
    this.newKon = this.regs[0x4c];
    this.kon = 0; this.noise = 0x4000; this.histPos = 0; this.everyOther = 1; this.echoOffset = 0; this.counter = 0;
    this.histL.fill(0); this.histR.fill(0);
    for (const v of this.voices) { v.bufPos = 0; v.brrOffset = 1; v.konDelay = 0; v.envMode = REL; v.env = 0; v.hiddenEnv = 0; v.interpPos = 0; v.buf.fill(0); }
  }

  write(addr: number, data: number): void {
    this.regs[addr] = data;
    if ((addr & 0x0f) === 0x0c) {
      if (addr === 0x4c) this.newKon = data;
      else if (addr === 0x7c) { this.endxBuf = 0; this.regs[0x7c] = 0; }
    }
  }

  private readCounter(rate: number): number { return (this.counter + COUNTER_OFFSETS[rate]) % COUNTER_RATES[rate]; }

  private runEnvelope(v: Voice, b: number): void {
    const r = this.regs;
    let env = v.env;
    if (v.envMode === REL) { env -= 8; if (env < 0) env = 0; v.env = env; return; }
    let rate: number, envData = r[b + 6];
    const adsr0 = r[b + 5];
    if (adsr0 & 0x80) {
      if (v.envMode >= DEC) {
        env--; env -= env >> 8;
        rate = envData & 0x1f;
        if (v.envMode === DEC) rate = ((adsr0 >> 3) & 0x0e) + 0x10;
      } else {
        rate = (adsr0 & 0x0f) * 2 + 1;
        env += rate < 31 ? 0x20 : 0x400;
      }
    } else {
      envData = r[b + 7];
      const mode = envData >> 5;
      if (mode < 4) { env = envData * 0x10; rate = 31; }
      else {
        rate = envData & 0x1f;
        if (mode === 4) env -= 0x20;
        else if (mode < 6) { env--; env -= env >> 8; }
        else { env += 0x20; if (mode > 6 && v.hiddenEnv >= 0x600) env += 0x8 - 0x20; }
      }
    }
    if ((env >> 8) === (envData >> 5) && v.envMode === DEC) v.envMode = SUS;
    v.hiddenEnv = env;
    if (env > 0x7ff || env < 0) {
      env = env < 0 ? 0 : 0x7ff;
      if (v.envMode === ATT) v.envMode = DEC;
    }
    if (!this.readCounter(rate)) v.env = env;
  }

  private decodeBrr(v: Voice, header: number, byte: number): void {
    const ram = this.ram;
    let nyb = byte * 0x100 + ram[(v.brrAddr + v.brrOffset + 1) & 0xffff];
    const buf = v.buf;
    let pos = v.bufPos;
    v.bufPos += 4; if (v.bufPos >= 12) v.bufPos = 0;
    for (let k = 0; k < 4; k++, pos++, nyb <<= 4) {
      let s = s16(nyb) >> 12;
      const shift = header >> 4;
      s = (s << shift) >> 1;
      if (shift >= 0xd) s = (s >> 25) << 11;
      const filter = header & 0x0c;
      const p1 = buf[pos + 11], p2 = buf[pos + 10] >> 1;
      if (filter >= 8) {
        s += p1; s -= p2;
        if (filter === 8) { s += p2 >> 4; s += (p1 * -3) >> 6; }
        else { s += (p1 * -13) >> 7; s += (p2 * 3) >> 4; }
      } else if (filter) { s += p1 >> 1; s += (-p1) >> 5; }
      s = clamp16(s);
      s = s16(s * 2);
      buf[pos + 12] = buf[pos] = s;
    }
  }

  private interpolate(v: Voice): number {
    const offset = (v.interpPos >> 4) & 0xff;
    const f = 255 - offset, r = offset;
    const i = (v.interpPos >> 12) + v.bufPos;
    const b = v.buf;
    let out = (GAUSS[f] * b[i]) >> 11;
    out += (GAUSS[f + 256] * b[i + 1]) >> 11;
    out += (GAUSS[r + 256] * b[i + 2]) >> 11;
    out = s16(out);
    out += (GAUSS[r] * b[i + 3]) >> 11;
    out = clamp16(out);
    return out & ~1;
  }

  /** one 32 kHz output sample */
  step(): void {
    const r = this.regs, ram = this.ram;
    const tPmon = r[0x2d] & 0xfe, tNon = r[0x3d], tEon = r[0x4d], dir = r[0x5d];
    // misc 29/30
    this.everyOther ^= 1;
    if (this.everyOther) this.newKon &= ~this.kon;
    if (this.everyOther) { this.kon = this.newKon; this.tKoff = r[0x5c] | this.mute; }
    if (--this.counter < 0) this.counter = COUNTER_RANGE - 1;
    if (!this.readCounter(r[0x6c] & 0x1f)) {
      const fb = (this.noise << 13) ^ (this.noise << 14);
      this.noise = (fb & 0x4000) ^ (this.noise >> 1);
    }
    let mainL = 0, mainR = 0, echoL = this.echoOutL, echoR = this.echoOutR;
    echoL = 0; echoR = 0; // echo accumulators restart each sample (the feedback is added in the echo step)
    let tOutput = this.tOutput;
    for (let n = 0; n < 8; n++) {
      const v = this.voices[n], b = n * 16;
      const srcn = r[b + 4];
      const dirAddr = dir * 0x100 + srcn * 4;
      let entry = dirAddr;
      if (!v.konDelay) entry += 2;
      const brrNext = ram[entry & 0xffff] | (ram[(entry + 1) & 0xffff] << 8);
      let pitch = r[b + 2] + ((r[b + 3] & 0x3f) << 8);
      let brrByte = ram[(v.brrAddr + v.brrOffset) & 0xffff];
      let header = ram[v.brrAddr & 0xffff];
      if (tPmon & v.vbit) pitch += ((tOutput >> 5) * pitch) >> 10;
      if (v.konDelay) {
        if (v.konDelay === 5) {
          v.brrAddr = brrNext; v.brrOffset = 1; v.bufPos = 0; header = 0;
          if (this.onKon) this.onKon({ voice: n, srcn, addr: brrNext, loop: ram[(dirAddr + 2) & 0xffff] | (ram[(dirAddr + 3) & 0xffff] << 8), pitch: r[b + 2] + ((r[b + 3] & 0x3f) << 8), sample: this.sample });
        }
        v.env = 0; v.hiddenEnv = 0;
        v.interpPos = 0;
        if (--v.konDelay & 3) v.interpPos = 0x4000;
        pitch = 0;
      }
      let output = this.interpolate(v);
      if (tNon & v.vbit) output = s16(this.noise * 2);
      tOutput = (output * v.env) >> 11 & ~1;
      v.envxOut = (v.env >> 4) & 0xff;
      if ((r[0x6c] & 0x80) || (header & 3) === 1) { v.envMode = REL; v.env = 0; }
      if (this.everyOther) {
        if (this.tKoff & v.vbit) v.envMode = REL;
        if (this.kon & v.vbit) { v.konDelay = 5; v.envMode = ATT; }
      }
      if (!v.konDelay) this.runEnvelope(v, b);
      v.envSum += v.env;
      // V4: BRR decode, pitch
      let looped = 0;
      if (v.interpPos >= 0x4000) {
        this.decodeBrr(v, header, brrByte);
        v.brrOffset += 2;
        if (v.brrOffset >= 9) {
          v.brrAddr = (v.brrAddr + 9) & 0xffff;
          if (header & 1) { v.brrAddr = brrNext; looped = v.vbit; }
          v.brrOffset = 1;
        }
      }
      v.interpPos = (v.interpPos & 0x3fff) + pitch;
      if (v.interpPos > 0x7fff) v.interpPos = 0x7fff;
      // outputs
      const al = (tOutput * s8(r[b])) >> 7, ar = (tOutput * s8(r[b + 1])) >> 7;
      mainL = clamp16(mainL + al); mainR = clamp16(mainR + ar);
      if (tEon & v.vbit) { echoL = clamp16(echoL + al); echoR = clamp16(echoR + ar); }
      let endx = r[0x7c] | looped;
      if (v.konDelay === 5) endx &= ~v.vbit;
      r[0x7c] = endx;
      r[b + 9] = (tOutput >> 8) & 0xff;
      r[b + 8] = v.envxOut;
    }
    this.tOutput = tOutput;
    // echo
    const hp = this.histPos = (this.histPos + 1) & 7;
    const esa = r[0x6d];
    const ptr = this.echoPtr = (esa * 0x100 + this.echoOffset) & 0xffff;
    const hl = this.histL, hr = this.histR;
    let sl = s16(ram[ptr] | (ram[(ptr + 1) & 0xffff] << 8)) >> 1;
    let sr = s16(ram[(ptr + 2) & 0xffff] | (ram[(ptr + 3) & 0xffff] << 8)) >> 1;
    hl[hp] = hl[hp + 8] = sl; hr[hp] = hr[hp + 8] = sr;
    let fl = 0, fr = 0;
    for (let i = 0; i < 8; i++) {
      const c = s8(r[0x0f + i * 0x10]);
      const l = (hl[hp + i + 1 > 15 ? hp + i + 1 - 8 : hp + i + 1] * c) >> 6;
      const rr = (hr[hp + i + 1 > 15 ? hp + i + 1 - 8 : hp + i + 1] * c) >> 6;
      if (i < 7) { fl += l; fr += rr; } else { fl = clamp16(s16(fl) + s16(l)); fr = clamp16(s16(fr) + s16(rr)); }
    }
    fl = clamp16(fl) & ~1; fr = clamp16(fr) & ~1;
    this.echoInL = fl; this.echoInR = fr;
    let outL = clamp16(s16((mainL * s8(r[0x0c])) >> 7) + s16((fl * s8(r[0x2c])) >> 7));
    let outR = clamp16(s16((mainR * s8(r[0x1c])) >> 7) + s16((fr * s8(r[0x3c])) >> 7));
    const efb = s8(r[0x0d]);
    const nl = clamp16(echoL + s16((fl * efb) >> 7)) & ~1;
    const nr = clamp16(echoR + s16((fr * efb) >> 7)) & ~1;
    if (r[0x6c] & 0x40) { outL = 0; outR = 0; }
    if (!this.echoOffset) this.echoLength = (r[0x7d] & 0x0f) * 0x800;
    this.echoOffset += 4;
    if (this.echoOffset >= this.echoLength) this.echoOffset = 0;
    if (!(r[0x6c] & 0x20)) {
      ram[ptr] = nl & 0xff; ram[(ptr + 1) & 0xffff] = (nl >> 8) & 0xff;
      ram[(ptr + 2) & 0xffff] = nr & 0xff; ram[(ptr + 3) & 0xffff] = (nr >> 8) & 0xff;
    }
    this.outL = outL; this.outR = outR;
    this.sample++;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// SPC700

const CYCLES = [
  0x28,0x47,0x34,0x36,0x26,0x54,0x54,0x68, 0x48,0x47,0x45,0x56,0x55,0x65,0x22,0x46,
  0x28,0x47,0x34,0x36,0x26,0x54,0x54,0x74, 0x48,0x47,0x45,0x56,0x55,0x65,0x22,0x38,
  0x28,0x47,0x34,0x36,0x26,0x44,0x54,0x66, 0x48,0x47,0x45,0x56,0x55,0x45,0x22,0x43,
  0x28,0x47,0x34,0x36,0x26,0x44,0x54,0x75, 0x48,0x47,0x45,0x56,0x55,0x55,0x22,0x36,
  0x28,0x47,0x34,0x36,0x26,0x54,0x52,0x45, 0x48,0x47,0x45,0x56,0x55,0x55,0x22,0xC5,
  0x38,0x47,0x34,0x36,0x26,0x44,0x52,0x44, 0x48,0x47,0x45,0x56,0x55,0x55,0x22,0x34,
  0x38,0x47,0x45,0x47,0x25,0x64,0x52,0x49, 0x48,0x47,0x56,0x67,0x45,0x55,0x22,0x83,
  0x28,0x47,0x34,0x36,0x24,0x53,0x43,0x40, 0x48,0x47,0x45,0x56,0x34,0x54,0x22,0x60,
];
const CYC = new Uint8Array(256);
for (let i = 0; i < 128; i++) { CYC[i * 2] = CYCLES[i] >> 4; CYC[i * 2 + 1] = CYCLES[i] & 15; }

const F_C = 1, F_Z = 2, F_I = 4, F_H = 8, F_B = 16, F_P = 32, F_V = 64, F_N = 128;

export class Spc700 {
  ram: Uint8Array;
  rom = new Uint8Array(64);
  a = 0; x = 0; y = 0; sp = 0xef; pc = 0;
  // flags kept unpacked
  c = 0; z = 0; i = 0; h = 0; b = 0; p = 0; v = 0; n = 0;
  dsp: Dsp;
  dspAddr = 0;
  ctrl = 0;
  portIn = [0, 0, 0, 0];
  portOut = [0, 0, 0, 0];
  target = [0, 0, 0];
  counter = [0, 0, 0];
  divider = [0, 0, 0];
  acc = [0, 0, 0];
  enabled = [false, false, false];
  cycles = 0;
  stopped = false;

  constructor(ram: Uint8Array, dsp: Dsp) { this.ram = ram; this.dsp = dsp; }

  get psw(): number {
    return this.c | (this.z === 0 ? F_Z : 0) | (this.i ? F_I : 0) | (this.h ? F_H : 0) | (this.b ? F_B : 0) | (this.p ? F_P : 0) | (this.v ? F_V : 0) | (this.n & 0x80 ? F_N : 0);
  }
  set psw(f: number) {
    this.c = f & 1; this.z = f & F_Z ? 0 : 1; this.i = f & F_I ? 1 : 0; this.h = f & F_H ? 1 : 0; this.b = f & F_B ? 1 : 0; this.p = f & F_P ? 1 : 0;
    this.v = f & F_V ? 1 : 0; this.n = f & F_N ? 0x80 : 0;
  }
  // z is stored as the last result (z === 0 means the Z flag is set) so that setting flags is cheap

  setControl(v: number): void {
    for (let t = 0; t < 3; t++) {
      const on = !!(v & (1 << t));
      if (on && !this.enabled[t]) { this.divider[t] = 0; this.counter[t] = 0; }
      this.enabled[t] = on;
    }
    if (v & 0x10) { this.portIn[0] = 0; this.portIn[1] = 0; }
    if (v & 0x20) { this.portIn[2] = 0; this.portIn[3] = 0; }
    this.ctrl = v;
  }

  rd(a: number): number {
    a &= 0xffff;
    if (a >= 0xf0 && a < 0x100) {
      switch (a) {
        case 0xf2: return this.dspAddr;
        case 0xf3: return this.dsp.regs[this.dspAddr & 0x7f];
        case 0xf4: case 0xf5: case 0xf6: case 0xf7: return this.portIn[a - 0xf4];
        case 0xfd: case 0xfe: case 0xff: { const t = a - 0xfd, r = this.counter[t]; this.counter[t] = 0; return r; }
        default: return this.ram[a];
      }
    }
    if (a >= 0xffc0 && (this.ctrl & 0x80)) return this.rom[a - 0xffc0];
    return this.ram[a];
  }

  wr(a: number, v: number): void {
    a &= 0xffff; v &= 0xff;
    if (a >= 0xf0 && a < 0x100) {
      switch (a) {
        case 0xf1: this.setControl(v); this.ram[a] = v; return;
        case 0xf2: this.dspAddr = v; this.ram[a] = v; return;
        case 0xf3: if (this.dspAddr < 0x80) this.dsp.write(this.dspAddr, v); return;
        case 0xf4: case 0xf5: case 0xf6: case 0xf7: this.portOut[a - 0xf4] = v; this.ram[a] = v; return;
        case 0xfa: case 0xfb: case 0xfc: this.target[a - 0xfa] = v; this.ram[a] = v; return;
        default: this.ram[a] = v; return;
      }
    }
    this.ram[a] = v;
  }

  private fetch(): number { const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  private fetch16(): number { const l = this.fetch(); return l | (this.fetch() << 8); }
  private push(v: number): void { this.ram[0x100 + this.sp] = v; this.sp = (this.sp - 1) & 0xff; }
  private pop(): number { this.sp = (this.sp + 1) & 0xff; return this.ram[0x100 + this.sp]; }
  private dp(o: number): number { return (this.p ? 0x100 : 0) + (o & 0xff); }
  private dpWord(o: number): number { const l = this.rd(this.dp(o)); return l | (this.rd(this.dp(o + 1)) << 8); }
  private nz(v: number): number { this.n = v & 0x80; this.z = v & 0xff; return v & 0xff; }

  private adc(a: number, b: number): number {
    const r = a + b + this.c;
    this.v = (~(a ^ b) & (a ^ r) & 0x80) ? 1 : 0;
    this.h = ((a & 15) + (b & 15) + this.c) > 15 ? 1 : 0;
    this.c = r > 255 ? 1 : 0;
    return this.nz(r);
  }
  private sbc(a: number, b: number): number {
    const r = a - b - (1 - this.c);
    this.v = ((a ^ b) & (a ^ r) & 0x80) ? 1 : 0;
    this.h = ((a & 15) - (b & 15) - (1 - this.c)) >= 0 ? 1 : 0;
    this.c = r >= 0 ? 1 : 0;
    return this.nz(r);
  }
  private cmp(a: number, b: number): void { const r = a - b; this.c = r >= 0 ? 1 : 0; this.nz(r); }
  private alu(op: number, a: number, b: number): number {
    switch (op) {
      case 0: return this.nz(a | b);
      case 1: return this.nz(a & b);
      case 2: return this.nz(a ^ b);
      case 3: this.cmp(a, b); return a;
      case 4: return this.adc(a, b);
      default: return this.sbc(a, b);
    }
  }
  private asl(v: number): number { this.c = (v >> 7) & 1; return this.nz(v << 1); }
  private lsr(v: number): number { this.c = v & 1; return this.nz(v >> 1); }
  private rol(v: number): number { const c = this.c; this.c = (v >> 7) & 1; return this.nz((v << 1) | c); }
  private ror(v: number): number { const c = this.c; this.c = v & 1; return this.nz((v >> 1) | (c << 7)); }
  private branch(cond: boolean): void {
    const o = s8(this.fetch());
    if (cond) { this.pc = (this.pc + o) & 0xffff; } else this.cyc -= 2;
  }
  private cyc = 0;

  /** executes one instruction, returns its cycle count */
  step(): number {
    const op = this.fetch();
    this.cyc = CYC[op];
    const hi = op >> 4, lo = op & 15;
    switch (op) {
      case 0x00: break;
      case 0x0f: { this.push(this.pc >> 8); this.push(this.pc & 255); this.push(this.psw); this.b = 1; this.i = 0; this.pc = this.rd(0xffde) | (this.rd(0xffdf) << 8); break; }
      case 0x1a: case 0x3a: { // DECW / INCW
        const o = this.fetch(), w = (this.dpWord(o) + (op === 0x3a ? 1 : -1)) & 0xffff;
        this.wr(this.dp(o), w & 255); this.wr(this.dp(o + 1), w >> 8); this.n = (w >> 8) & 0x80; this.z = w; break;
      }
      case 0x5a: { const w = this.dpWord(this.fetch()), ya = this.a | (this.y << 8); const r = ya - w; this.c = r >= 0 ? 1 : 0; this.n = (r >> 8) & 0x80; this.z = r & 0xffff; break; }
      case 0x7a: { // ADDW
        const w = this.dpWord(this.fetch());
        this.c = 0; const lo2 = this.adc(this.a, w & 255); const hi2 = this.adc(this.y, w >> 8);
        // flags N, V, H from the high byte; Z from the whole word
        this.a = lo2; this.y = hi2; this.z = lo2 | hi2; break;
      }
      case 0x9a: { // SUBW
        const w = this.dpWord(this.fetch());
        this.c = 1; const lo2 = this.sbc(this.a, w & 255); const hi2 = this.sbc(this.y, w >> 8);
        this.a = lo2; this.y = hi2; this.z = lo2 | hi2; break;
      }
      case 0xba: { const w = this.dpWord(this.fetch()); this.a = w & 255; this.y = w >> 8; this.n = (w >> 8) & 0x80; this.z = w; break; }
      case 0xda: { const o = this.fetch(); this.wr(this.dp(o), this.a); this.wr(this.dp(o + 1), this.y); break; }
      case 0xcf: { const r = this.y * this.a; this.a = r & 255; this.y = r >> 8; this.nz(this.y); break; }
      case 0x9e: { // DIV YA,X
        const ya = this.a | (this.y << 8), x = this.x;
        this.h = (this.y & 15) >= (x & 15) ? 1 : 0;
        this.v = this.y >= x ? 1 : 0;
        if (this.y < (x << 1)) { this.a = x ? Math.floor(ya / x) & 255 : 255; this.y = x ? ya % x : this.y; }
        else { const t = ya - (x << 9), d = 256 - x; this.a = (255 - Math.floor(t / d)) & 255; this.y = (x + (t % d)) & 255; }
        this.nz(this.a); break;
      }
      case 0x9f: this.a = this.nz(((this.a << 4) | (this.a >> 4)) & 255); break;
      case 0xdf: { // DAA
        if (this.c || this.a > 0x99) { this.a += 0x60; this.c = 1; }
        if (this.h || (this.a & 15) > 9) this.a += 6;
        this.a &= 255; this.nz(this.a); break;
      }
      case 0xbe: { // DAS
        if (!this.c || this.a > 0x99) { this.a -= 0x60; this.c = 0; }
        if (!this.h || (this.a & 15) > 9) this.a -= 6;
        this.a &= 255; this.nz(this.a); break;
      }
      case 0x20: this.p = 0; break; case 0x40: this.p = 1; break;
      case 0x60: this.c = 0; break; case 0x80: this.c = 1; break;
      case 0xa0: this.i = 1; break; case 0xc0: this.i = 0; break;
      case 0xe0: this.v = 0; this.h = 0; break;
      case 0xed: this.c ^= 1; break;
      case 0x0d: this.push(this.psw); break; case 0x2d: this.push(this.a); break; case 0x4d: this.push(this.x); break; case 0x6d: this.push(this.y); break;
      case 0x8e: this.psw = this.pop(); break;
      case 0xae: this.a = this.pop(); break; case 0xce: this.x = this.pop(); break; case 0xee: this.y = this.pop(); break;
      case 0x0e: { const a = this.fetch16(), v = this.rd(a); this.nz((this.a - v) & 255); this.wr(a, v | this.a); break; }
      case 0x4e: { const a = this.fetch16(), v = this.rd(a); this.nz((this.a - v) & 255); this.wr(a, v & ~this.a); break; }
      case 0x10: this.branch(!this.n); break; case 0x30: this.branch(!!this.n); break;
      case 0x50: this.branch(!this.v); break; case 0x70: this.branch(!!this.v); break;
      case 0x90: this.branch(!this.c); break; case 0xb0: this.branch(!!this.c); break;
      case 0xd0: this.branch(!!this.z); break; case 0xf0: this.branch(!this.z); break;
      case 0x2f: this.branch(true); break;
      case 0x1d: this.x = this.nz(this.x - 1); break; case 0x3d: this.x = this.nz(this.x + 1); break;
      case 0xdc: this.y = this.nz(this.y - 1); break; case 0xfc: this.y = this.nz(this.y + 1); break;
      case 0x9c: this.a = this.nz(this.a - 1); break; case 0xbc: this.a = this.nz(this.a + 1); break;
      case 0x5d: this.x = this.nz(this.a); break; case 0x7d: this.a = this.nz(this.x); break;
      case 0x9d: this.x = this.nz(this.sp); break; case 0xbd: this.sp = this.x; break;
      case 0xdd: this.a = this.nz(this.y); break; case 0xfd: this.y = this.nz(this.a); break;
      case 0x1c: this.a = this.asl(this.a); break; case 0x3c: this.a = this.rol(this.a); break;
      case 0x5c: this.a = this.lsr(this.a); break; case 0x7c: this.a = this.ror(this.a); break;
      case 0x0b: case 0x2b: case 0x4b: case 0x6b: { const ad = this.dp(this.fetch()); this.wr(ad, this.shift(op, this.rd(ad))); break; }
      case 0x1b: case 0x3b: case 0x5b: case 0x7b: { const ad = this.dp(this.fetch() + this.x); this.wr(ad, this.shift(op - 0x10, this.rd(ad))); break; }
      case 0x0c: case 0x2c: case 0x4c: case 0x6c: { const ad = this.fetch16(); this.wr(ad, this.shift(op - 1, this.rd(ad))); break; }
      case 0x8b: { const ad = this.dp(this.fetch()); this.wr(ad, this.nz(this.rd(ad) - 1)); break; }
      case 0x9b: { const ad = this.dp(this.fetch() + this.x); this.wr(ad, this.nz(this.rd(ad) - 1)); break; }
      case 0x8c: { const ad = this.fetch16(); this.wr(ad, this.nz(this.rd(ad) - 1)); break; }
      case 0xab: { const ad = this.dp(this.fetch()); this.wr(ad, this.nz(this.rd(ad) + 1)); break; }
      case 0xbb: { const ad = this.dp(this.fetch() + this.x); this.wr(ad, this.nz(this.rd(ad) + 1)); break; }
      case 0xac: { const ad = this.fetch16(); this.wr(ad, this.nz(this.rd(ad) + 1)); break; }
      // CMP X / Y
      case 0xc8: this.cmp(this.x, this.fetch()); break;
      case 0x3e: this.cmp(this.x, this.rd(this.dp(this.fetch()))); break;
      case 0x1e: this.cmp(this.x, this.rd(this.fetch16())); break;
      case 0xad: this.cmp(this.y, this.fetch()); break;
      case 0x7e: this.cmp(this.y, this.rd(this.dp(this.fetch()))); break;
      case 0x5e: this.cmp(this.y, this.rd(this.fetch16())); break;
      // MOV
      case 0xe8: this.a = this.nz(this.fetch()); break;
      case 0xcd: this.x = this.nz(this.fetch()); break;
      case 0x8d: this.y = this.nz(this.fetch()); break;
      case 0xe4: this.a = this.nz(this.rd(this.dp(this.fetch()))); break;
      case 0xf4: this.a = this.nz(this.rd(this.dp(this.fetch() + this.x))); break;
      case 0xe5: this.a = this.nz(this.rd(this.fetch16())); break;
      case 0xf5: this.a = this.nz(this.rd(this.fetch16() + this.x)); break;
      case 0xf6: this.a = this.nz(this.rd(this.fetch16() + this.y)); break;
      case 0xe6: this.a = this.nz(this.rd(this.dp(this.x))); break;
      case 0xbf: this.a = this.nz(this.rd(this.dp(this.x))); this.x = (this.x + 1) & 255; break;
      case 0xe7: { const p = this.dpWord(this.fetch() + this.x); this.a = this.nz(this.rd(p)); break; }
      case 0xf7: { const p = this.dpWord(this.fetch()); this.a = this.nz(this.rd(p + this.y)); break; }
      case 0xf8: this.x = this.nz(this.rd(this.dp(this.fetch()))); break;
      case 0xf9: this.x = this.nz(this.rd(this.dp(this.fetch() + this.y))); break;
      case 0xe9: this.x = this.nz(this.rd(this.fetch16())); break;
      case 0xeb: this.y = this.nz(this.rd(this.dp(this.fetch()))); break;
      case 0xfb: this.y = this.nz(this.rd(this.dp(this.fetch() + this.x))); break;
      case 0xec: this.y = this.nz(this.rd(this.fetch16())); break;
      case 0xc4: this.wr(this.dp(this.fetch()), this.a); break;
      case 0xd4: this.wr(this.dp(this.fetch() + this.x), this.a); break;
      case 0xc5: this.wr(this.fetch16(), this.a); break;
      case 0xd5: this.wr(this.fetch16() + this.x, this.a); break;
      case 0xd6: this.wr(this.fetch16() + this.y, this.a); break;
      case 0xc6: this.wr(this.dp(this.x), this.a); break;
      case 0xaf: this.wr(this.dp(this.x), this.a); this.x = (this.x + 1) & 255; break;
      case 0xc7: { const p = this.dpWord(this.fetch() + this.x); this.wr(p, this.a); break; }
      case 0xd7: { const p = this.dpWord(this.fetch()); this.wr(p + this.y, this.a); break; }
      case 0xd8: this.wr(this.dp(this.fetch()), this.x); break;
      case 0xd9: this.wr(this.dp(this.fetch() + this.y), this.x); break;
      case 0xc9: this.wr(this.fetch16(), this.x); break;
      case 0xcb: this.wr(this.dp(this.fetch()), this.y); break;
      case 0xdb: this.wr(this.dp(this.fetch() + this.x), this.y); break;
      case 0xcc: this.wr(this.fetch16(), this.y); break;
      case 0x8f: { const v = this.fetch(); this.wr(this.dp(this.fetch()), v); break; }
      case 0xfa: { const v = this.rd(this.dp(this.fetch())); this.wr(this.dp(this.fetch()), v); break; }
      // bit ops
      case 0x0a: case 0x2a: case 0x4a: case 0x6a: case 0x8a: case 0xaa: case 0xca: case 0xea: {
        const w = this.fetch16(), ad = w & 0x1fff, bit = w >> 13, m = (this.rd(ad) >> bit) & 1;
        switch (op) {
          case 0x0a: this.c |= m; break; case 0x2a: this.c |= m ^ 1; break;
          case 0x4a: this.c &= m; break; case 0x6a: this.c &= m ^ 1; break;
          case 0x8a: this.c ^= m; break; case 0xaa: this.c = m; break;
          case 0xca: { const v = this.rd(ad); this.wr(ad, this.c ? v | (1 << bit) : v & ~(1 << bit)); break; }
          default: this.wr(ad, this.rd(ad) ^ (1 << bit));
        }
        break;
      }
      // jumps and calls
      case 0x5f: this.pc = this.fetch16(); break;
      case 0x1f: { const a = this.fetch16() + this.x; this.pc = this.rd(a) | (this.rd(a + 1) << 8); break; }
      case 0x3f: { const t = this.fetch16(); this.push(this.pc >> 8); this.push(this.pc & 255); this.pc = t; break; }
      case 0x4f: { const t = 0xff00 | this.fetch(); this.push(this.pc >> 8); this.push(this.pc & 255); this.pc = t; break; }
      case 0x6f: { const l = this.pop(); this.pc = l | (this.pop() << 8); break; }
      case 0x7f: { this.psw = this.pop(); const l = this.pop(); this.pc = l | (this.pop() << 8); break; }
      case 0x2e: { const v = this.rd(this.dp(this.fetch())); this.branch(this.a !== v); break; }
      case 0xde: { const v = this.rd(this.dp(this.fetch() + this.x)); this.branch(this.a !== v); break; }
      case 0x6e: { const ad = this.dp(this.fetch()), v = (this.rd(ad) - 1) & 255; this.wr(ad, v); this.branch(v !== 0); break; }
      case 0xfe: { this.y = (this.y - 1) & 255; this.branch(this.y !== 0); break; }
      case 0xef: case 0xff: this.stopped = true; this.pc = (this.pc - 1) & 0xffff; break;
      default:
        if (lo === 1) { // TCALL
          this.push(this.pc >> 8); this.push(this.pc & 255);
          const a = 0xffde - hi * 2; this.pc = this.rd(a) | (this.rd(a + 1) << 8);
        } else if (lo === 2 && !(hi & 1)) { // SET1
          const ad = this.dp(this.fetch()); this.wr(ad, this.rd(ad) | (1 << (hi >> 1)));
        } else if (lo === 2) { // CLR1
          const ad = this.dp(this.fetch()); this.wr(ad, this.rd(ad) & ~(1 << (hi >> 1)));
        } else if (lo === 3) { // BBS / BBC
          const v = this.rd(this.dp(this.fetch())); const set = (v >> (hi >> 1)) & 1;
          this.branch(hi & 1 ? !set : !!set);
        } else {
          this.aluOp(op);
        }
    }
    return this.cyc;
  }

  private shift(op: number, v: number): number {
    switch (op & 0x60) { case 0x00: return this.asl(v); case 0x20: return this.rol(v); case 0x40: return this.lsr(v); default: return this.ror(v); }
  }

  /** the OR / AND / EOR / CMP / ADC / SBC families */
  private aluOp(op: number): void {
    const kind = op >> 5;                       // 0 OR 1 AND 2 EOR 3 CMP 4 ADC 5 SBC
    if (kind > 5) throw new Error('SPC700: unknown opcode ' + op.toString(16) + ' at ' + ((this.pc - 1) & 0xffff).toString(16));
    const f = op & 0x1f;
    switch (f) {
      case 0x04: this.a = this.alu(kind, this.a, this.rd(this.dp(this.fetch()))); break;
      case 0x14: this.a = this.alu(kind, this.a, this.rd(this.dp(this.fetch() + this.x))); break;
      case 0x05: this.a = this.alu(kind, this.a, this.rd(this.fetch16())); break;
      case 0x15: this.a = this.alu(kind, this.a, this.rd(this.fetch16() + this.x)); break;
      case 0x16: this.a = this.alu(kind, this.a, this.rd(this.fetch16() + this.y)); break;
      case 0x06: this.a = this.alu(kind, this.a, this.rd(this.dp(this.x))); break;
      case 0x07: { const p = this.dpWord(this.fetch() + this.x); this.a = this.alu(kind, this.a, this.rd(p)); break; }
      case 0x17: { const p = this.dpWord(this.fetch()); this.a = this.alu(kind, this.a, this.rd(p + this.y)); break; }
      case 0x08: this.a = this.alu(kind, this.a, this.fetch()); break;
      case 0x09: { const s = this.rd(this.dp(this.fetch())); const d = this.dp(this.fetch()); const r = this.alu(kind, this.rd(d), s); if (kind !== 3) this.wr(d, r); break; }
      case 0x18: { const s = this.fetch(); const d = this.dp(this.fetch()); const r = this.alu(kind, this.rd(d), s); if (kind !== 3) this.wr(d, r); break; }
      case 0x19: { const s = this.rd(this.dp(this.y)); const d = this.dp(this.x); const r = this.alu(kind, this.rd(d), s); if (kind !== 3) this.wr(d, r); break; }
      default: throw new Error('SPC700: unknown opcode ' + op.toString(16) + ' at ' + ((this.pc - 1) & 0xffff).toString(16));
    }
  }

  /** advances the three timers by `c` CPU cycles (1.024 MHz) */
  tick(c: number): void {
    for (let t = 0; t < 3; t++) {
      if (!this.enabled[t]) continue;
      const period = t === 2 ? 16 : 128;
      this.acc[t] += c;
      while (this.acc[t] >= period) {
        this.acc[t] -= period;
        if (++this.divider[t] === (this.target[t] || 256)) { this.divider[t] = 0; this.counter[t] = (this.counter[t] + 1) & 15; }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// SPC files

export const SPC_RATE = 32000;

export function isSpc(d: Uint8Array): boolean {
  const sig = 'SNES-SPC700 Sound File Data';
  if (d.length < 0x10180) return false;
  for (let i = 0; i < sig.length; i++) if (d[i] !== sig.charCodeAt(i)) return false;
  return true;
}

export interface SpcTags { title: string; game: string; dumper: string; comment: string; artist: string; seconds: number; fadeMs: number }

const text = (d: Uint8Array, o: number, n: number): string => {
  let s = '';
  for (let i = o; i < o + n && d[i]; i++) s += String.fromCharCode(d[i]);
  return s.trim();
};

export function spcTags(d: Uint8Array): SpcTags {
  const has = d[0x23] === 26;
  if (!has) return { title: '', game: '', dumper: '', comment: '', artist: '', seconds: 0, fadeMs: 0 };
  // text format; the binary format (rare) stores the numbers differently, so only trust digits
  const num = (o: number, n: number) => { const s = text(d, o, n); return /^\d+$/.test(s) ? +s : 0; };
  return {
    title: text(d, 0x2e, 32), game: text(d, 0x4e, 32), dumper: text(d, 0x6e, 16), comment: text(d, 0x7e, 32),
    seconds: num(0xa9, 3), fadeMs: num(0xac, 5), artist: text(d, 0xb1, 32),
  };
}

export class SpcPlayer {
  ram = new Uint8Array(65536);
  dsp = new Dsp(this.ram);
  cpu = new Spc700(this.ram, this.dsp);
  private budget = 0;
  tags: SpcTags;

  constructor(file: Uint8Array) {
    if (!isSpc(file)) throw new Error('Not an SPC file');
    this.tags = spcTags(file);
    const cpu = this.cpu;
    this.ram.set(file.subarray(0x100, 0x10100));
    this.dsp.load(file.subarray(0x10100, 0x10180));
    if (file.length >= 0x10200) cpu.rom.set(file.subarray(0x101c0, 0x10200));
    cpu.pc = file[0x25] | (file[0x26] << 8);
    cpu.a = file[0x27]; cpu.x = file[0x28]; cpu.y = file[0x29]; cpu.psw = file[0x2a]; cpu.sp = file[0x2b];
    const r = this.ram;
    cpu.dspAddr = r[0xf2];
    cpu.setControl(r[0xf1]);
    cpu.target[0] = r[0xfa]; cpu.target[1] = r[0xfb]; cpu.target[2] = r[0xfc];
    for (let i = 0; i < 4; i++) { cpu.portIn[i] = r[0xf4 + i]; }
    cpu.ctrl = r[0xf1];
    // the echo buffer in the file is often garbage: start it silent
    if (!(this.dsp.regs[0x6c] & 0x20)) {
      const a = this.dsp.regs[0x6d] * 0x100, n = (this.dsp.regs[0x7d] & 15) * 0x800;
      this.ram.fill(0, a, Math.min(0x10000, a + n));
    }
  }

  /** runs `n` output samples (32 kHz). out receives interleaved stereo int16 when given. */
  run(n: number, out?: Int16Array, at = 0): void {
    const cpu = this.cpu, dsp = this.dsp;
    for (let k = 0; k < n; k++) {
      this.budget += 32;
      if (!cpu.stopped) {
        while (this.budget > 0) { const c = cpu.step(); this.budget -= c; cpu.tick(c); }
      } else { this.budget = 0; cpu.tick(32); }
      dsp.step();
      if (out) { out[at + k * 2] = dsp.outL; out[at + k * 2 + 1] = dsp.outR; }
    }
  }
}
