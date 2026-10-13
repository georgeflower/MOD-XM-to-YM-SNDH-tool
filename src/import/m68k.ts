// A compact Motorola 68000 interpreter, enough to run SNDH music routines (no cycle timing, no exceptions
// except a few no-ops). Memory is 4 MB RAM plus a hook for the I/O page at 0xFF8000.

export const RAM_SIZE = 0x400000;
const MASK = [0xff, 0xffff, 0xffffffff];
const MSB = [0x80, 0x8000, 0x80000000];
const BYTES = [1, 2, 4];

export interface Bus {
  ioRead(addr: number, size: number): number;
  ioWrite(addr: number, size: number, value: number): void;
}

export class M68k {
  d = new Int32Array(8);
  a = new Int32Array(8);
  pc = 0;
  x = 0; n = 0; z = 0; v = 0; c = 0;
  sr_hi = 0x2000;          // system byte (always supervisor)
  usp = 0;
  mem = new Uint8Array(RAM_SIZE);
  /** called for TRAP #n (the stack still holds the call's arguments) */
  onTrap: ((n: number) => void) | null = null;
  stopped = false;
  instructions = 0;
  // effective address scratch
  private k = 0; private ev = 0;

  constructor(private bus: Bus) {}

  // ---------------------------------------------------------------- memory
  rd8(a: number): number {
    a &= 0xffffff;
    return a >= 0xff8000 ? this.bus.ioRead(a, 0) & 0xff : this.mem[a % RAM_SIZE];
  }
  rd16(a: number): number {
    a &= 0xffffff;
    if (a >= 0xff8000) return this.bus.ioRead(a, 1) & 0xffff;
    a %= RAM_SIZE;
    return (this.mem[a] << 8) | this.mem[(a + 1) % RAM_SIZE];
  }
  rd32(a: number): number {
    a &= 0xffffff;
    if (a >= 0xff8000) return this.bus.ioRead(a, 2) >>> 0;
    return ((this.rd16(a) << 16) | this.rd16(a + 2)) >>> 0;
  }
  wr8(a: number, v: number) {
    a &= 0xffffff;
    if (a >= 0xff8000) this.bus.ioWrite(a, 0, v & 0xff); else this.mem[a % RAM_SIZE] = v;
  }
  wr16(a: number, v: number) {
    a &= 0xffffff;
    if (a >= 0xff8000) { this.bus.ioWrite(a, 1, v & 0xffff); return; }
    a %= RAM_SIZE;
    this.mem[a] = v >> 8; this.mem[(a + 1) % RAM_SIZE] = v;
  }
  wr32(a: number, v: number) {
    a &= 0xffffff;
    if (a >= 0xff8000) { this.bus.ioWrite(a, 2, v >>> 0); return; }
    this.wr16(a, v >>> 16); this.wr16(a + 2, v & 0xffff);
  }
  private fetch16(): number { const v = this.rd16(this.pc); this.pc = (this.pc + 2) >>> 0; return v; }
  private fetch32(): number { const v = this.rd32(this.pc); this.pc = (this.pc + 4) >>> 0; return v; }

  // ---------------------------------------------------------------- status register
  get sr(): number { return this.sr_hi | (this.x << 4) | (this.n << 3) | (this.z << 2) | (this.v << 1) | this.c; }
  set sr(v: number) {
    this.sr_hi = (v & 0xff00) | 0x2000;
    this.x = (v >> 4) & 1; this.n = (v >> 3) & 1; this.z = (v >> 2) & 1; this.v = (v >> 1) & 1; this.c = v & 1;
  }
  private cond(cc: number): boolean {
    switch (cc) {
      case 0: return true; case 1: return false;
      case 2: return !this.c && !this.z; case 3: return !!(this.c | this.z);
      case 4: return !this.c; case 5: return !!this.c;
      case 6: return !this.z; case 7: return !!this.z;
      case 8: return !this.v; case 9: return !!this.v;
      case 10: return !this.n; case 11: return !!this.n;
      case 12: return this.n === this.v; case 13: return this.n !== this.v;
      case 14: return !this.z && this.n === this.v; default: return !!this.z || this.n !== this.v;
    }
  }

  // ---------------------------------------------------------------- effective addresses
  private ea(mode: number, reg: number, size: number) {
    switch (mode) {
      case 0: this.k = 0; this.ev = reg; return;
      case 1: this.k = 1; this.ev = reg; return;
      case 2: this.k = 2; this.ev = this.a[reg] >>> 0; return;
      case 3: {
        this.k = 2; this.ev = this.a[reg] >>> 0;
        this.a[reg] += size === 0 && reg === 7 ? 2 : BYTES[size];
        return;
      }
      case 4: {
        this.k = 2;
        this.a[reg] -= size === 0 && reg === 7 ? 2 : BYTES[size];
        this.ev = this.a[reg] >>> 0; return;
      }
      case 5: this.k = 2; this.ev = (this.a[reg] + ((this.fetch16() << 16) >> 16)) >>> 0; return;
      case 6: this.k = 2; this.ev = this.index(this.a[reg]); return;
      default:
        switch (reg) {
          case 0: this.k = 2; this.ev = ((this.fetch16() << 16) >> 16) >>> 0; return;
          case 1: this.k = 2; this.ev = this.fetch32(); return;
          case 2: { const base = this.pc; this.k = 2; this.ev = (base + ((this.fetch16() << 16) >> 16)) >>> 0; return; }
          case 3: { const base = this.pc; this.k = 2; this.ev = this.index(base); return; }
          case 4:
            this.k = 3;
            this.ev = size === 2 ? this.fetch32() : size === 1 ? this.fetch16() : this.fetch16() & 0xff;
            return;
          default: throw new Error('bad addressing mode');
        }
    }
  }
  private index(base: number): number {
    const ext = this.fetch16();
    const r = (ext >> 12) & 7;
    let idx = ext & 0x8000 ? this.a[r] : this.d[r];
    if (!(ext & 0x800)) idx = (idx << 16) >> 16;
    return (base + idx + ((ext << 24) >> 24)) >>> 0;
  }
  private get(size: number): number {
    switch (this.k) {
      case 0: return (this.d[this.ev] & MASK[size]) >>> 0;
      case 1: return (this.a[this.ev] & MASK[size]) >>> 0;
      case 2: return size === 0 ? this.rd8(this.ev) : size === 1 ? this.rd16(this.ev) : this.rd32(this.ev);
      default: return this.ev >>> 0;
    }
  }
  private set(size: number, val: number) {
    switch (this.k) {
      case 0:
        if (size === 2) this.d[this.ev] = val;
        else if (size === 1) this.d[this.ev] = (this.d[this.ev] & ~0xffff) | (val & 0xffff);
        else this.d[this.ev] = (this.d[this.ev] & ~0xff) | (val & 0xff);
        return;
      case 1: this.a[this.ev] = val; return;
      case 2:
        if (size === 0) this.wr8(this.ev, val); else if (size === 1) this.wr16(this.ev, val); else this.wr32(this.ev, val);
        return;
      default: throw new Error('write to immediate');
    }
  }

  // ---------------------------------------------------------------- arithmetic helpers (unsigned inputs)
  private add(s: number, d: number, size: number, ci = 0, ext = false): number {
    const r = s + d + ci, m = MASK[size];
    const res = r % (m + 1);
    this.c = this.x = r > m ? 1 : 0;
    this.v = ((((s ^ res) & (d ^ res)) >>> 0) & MSB[size]) ? 1 : 0;
    this.n = res & MSB[size] ? 1 : 0;
    this.z = ext ? (res === 0 ? this.z : 0) : res === 0 ? 1 : 0;
    return res;
  }
  private sub(s: number, d: number, size: number, ci = 0, ext = false, store = true): number {
    const r = d - s - ci, m = MASK[size];
    const res = (r + (m + 1) * 2) % (m + 1);
    this.c = r < 0 ? 1 : 0;
    if (store) this.x = this.c;
    this.v = ((((s ^ d) & (d ^ res)) >>> 0) & MSB[size]) ? 1 : 0;
    this.n = res & MSB[size] ? 1 : 0;
    this.z = ext ? (res === 0 ? this.z : 0) : res === 0 ? 1 : 0;
    return res;
  }
  private logic(res: number, size: number): number {
    res = (res & MASK[size]) >>> 0;
    this.n = res & MSB[size] ? 1 : 0; this.z = res === 0 ? 1 : 0; this.v = 0; this.c = 0;
    return res;
  }
  private sext(v: number, size: number): number {
    return size === 0 ? (v << 24) >> 24 : size === 1 ? (v << 16) >> 16 : v | 0;
  }

  // ---------------------------------------------------------------- stack
  private push32(v: number) { this.a[7] -= 4; this.wr32(this.a[7], v); }
  private pop32(): number { const v = this.rd32(this.a[7]); this.a[7] += 4; return v; }

  // ---------------------------------------------------------------- run
  /** run until PC == stopAt or the instruction budget is used up; returns false on budget exhaustion */
  run(stopAt: number, budget: number): boolean {
    this.stopped = false;
    while (this.pc !== stopAt) {
      if (budget-- <= 0) return false;
      if (this.stopped) return true;
      this.step();
    }
    return true;
  }

  step() {
    this.instructions++;
    const op = this.fetch16();
    switch (op >> 12) {
      case 0x0: return this.group0(op);
      case 0x1: return this.move(op, 0);
      case 0x2: return this.move(op, 2);
      case 0x3: return this.move(op, 1);
      case 0x4: return this.group4(op);
      case 0x5: return this.group5(op);
      case 0x6: return this.branch(op);
      case 0x7: {
        const v = (op << 24) >> 24; this.d[(op >> 9) & 7] = v;
        this.n = v < 0 ? 1 : 0; this.z = v === 0 ? 1 : 0; this.v = 0; this.c = 0; return;
      }
      case 0x8: return this.group8(op);
      case 0x9: return this.addsub(op, true);
      case 0xb: return this.groupB(op);
      case 0xc: return this.groupC(op);
      case 0xd: return this.addsub(op, false);
      case 0xe: return this.shift(op);
      default: return; // line A / line F: ignored
    }
  }

  private move(op: number, size: number) {
    // MOVE: size code 1 = byte, 3 = word, 2 = long in the opcode -> mapped by the caller (0=byte,1=word,2=long)
    const sm = (op >> 3) & 7, sr = op & 7, dm = (op >> 6) & 7, dr = (op >> 9) & 7;
    this.ea(sm, sr, size);
    let v = this.get(size);
    if (dm === 1) { this.a[dr] = this.sext(v, size); return; } // MOVEA, no flags
    this.ea(dm, dr, size);
    this.logic(v, size);
    this.set(size, v);
  }

  private group0(op: number) {
    const mode = (op >> 3) & 7, reg = op & 7;
    if (op & 0x100) {
      if (mode === 1) { this.movep(op); return; }
      // dynamic bit ops
      this.bitop(op, this.d[(op >> 9) & 7]);
      return;
    }
    const sel = (op >> 9) & 7;
    if (sel === 4) { const bit = this.fetch16(); this.bitop(op, bit); return; }
    if (op === 0x003c || op === 0x023c || op === 0x0a3c) {
      const v = this.fetch16() & 0xff, c = this.sr & 0xff;
      this.sr = (this.sr & 0xff00) | (op === 0x003c ? c | v : op === 0x023c ? c & v : c ^ v); return;
    }
    if (op === 0x007c || op === 0x027c || op === 0x0a7c) {
      const v = this.fetch16(), c = this.sr;
      this.sr = op === 0x007c ? c | v : op === 0x027c ? c & v : c ^ v; return;
    }
    const size = (op >> 6) & 3;
    if (size === 3) throw new Error(`illegal opcode ${op.toString(16)}`);
    const imm = size === 2 ? this.fetch32() : this.fetch16() & MASK[size];
    this.ea(mode, reg, size);
    const dst = this.get(size);
    switch (sel) {
      case 0: this.set(size, this.logic(dst | imm, size)); return;
      case 1: this.set(size, this.logic(dst & imm, size)); return;
      case 2: this.set(size, this.sub(imm, dst, size)); return;
      case 3: this.set(size, this.add(imm, dst, size)); return;
      case 5: this.set(size, this.logic(dst ^ imm, size)); return;
      case 6: this.sub(imm, dst, size, 0, false, false); return;
      default: throw new Error(`illegal opcode ${op.toString(16)}`);
    }
  }

  private bitop(op: number, bitnum: number) {
    const mode = (op >> 3) & 7, reg = op & 7;
    const type = (op >> 6) & 3;
    const size = mode === 0 ? 2 : 0;
    this.ea(mode, reg, size);
    const bit = size === 2 ? bitnum & 31 : bitnum & 7;
    const val = this.get(size);
    this.z = ((val >>> bit) & 1) ? 0 : 1;
    if (type === 0) return;
    const m = (1 << bit) >>> 0;
    const nv = type === 1 ? (val ^ m) : type === 2 ? (val & ~m) : (val | m);
    this.set(size, nv >>> 0);
  }

  private movep(op: number) {
    const dr = (op >> 9) & 7, ar = op & 7, om = (op >> 6) & 7;
    const addr = (this.a[ar] + ((this.fetch16() << 16) >> 16)) >>> 0;
    if (om === 4) this.d[dr] = (this.d[dr] & ~0xffff) | (this.rd8(addr) << 8) | this.rd8(addr + 2);
    else if (om === 5) this.d[dr] = (this.rd8(addr) << 24) | (this.rd8(addr + 2) << 16) | (this.rd8(addr + 4) << 8) | this.rd8(addr + 6);
    else if (om === 6) { this.wr8(addr, this.d[dr] >> 8); this.wr8(addr + 2, this.d[dr]); }
    else { this.wr8(addr, this.d[dr] >>> 24); this.wr8(addr + 2, this.d[dr] >>> 16); this.wr8(addr + 4, this.d[dr] >>> 8); this.wr8(addr + 6, this.d[dr]); }
  }

  private group4(op: number) {
    const mode = (op >> 3) & 7, reg = op & 7;
    if (op >= 0x4e40 && op <= 0x4e4f) { this.onTrap?.(op & 15); return; } // TRAP: only what the host hooks (GEMDOS memory calls), else ignored
    switch (op) {
      case 0x4afc: throw new Error('ILLEGAL instruction');
      case 0x4e70: return;                       // RESET
      case 0x4e71: return;                       // NOP
      case 0x4e72: this.fetch16(); this.stopped = true; return; // STOP
      case 0x4e73: { this.sr = this.rd16(this.a[7]); this.a[7] += 2; this.pc = this.pop32(); return; } // RTE
      case 0x4e75: this.pc = this.pop32(); return;
      case 0x4e76: return;
      case 0x4e77: { this.sr = (this.sr & 0xff00) | (this.rd16(this.a[7]) & 0xff); this.a[7] += 2; this.pc = this.pop32(); return; }
    }
    if ((op & 0xfff8) === 0x4e50) { // LINK
      this.push32(this.a[reg]); this.a[reg] = this.a[7]; this.a[7] += (this.fetch16() << 16) >> 16; return;
    }
    if ((op & 0xfff8) === 0x4e58) { this.a[7] = this.a[reg]; this.a[reg] = this.pop32(); return; } // UNLK
    if ((op & 0xfff8) === 0x4e60) { this.usp = this.a[reg]; return; }
    if ((op & 0xfff8) === 0x4e68) { this.a[reg] = this.usp; return; }
    if ((op & 0xffc0) === 0x4e80) { this.ea(mode, reg, 2); this.push32(this.pc); this.pc = this.ev; return; } // JSR
    if ((op & 0xffc0) === 0x4ec0) { this.ea(mode, reg, 2); this.pc = this.ev; return; }                       // JMP
    if ((op & 0xffb8) === 0x4880) { // EXT
      if (op & 0x40) this.d[reg] = this.logic((this.d[reg] << 16) >> 16, 2) | 0;
      else this.d[reg] = (this.d[reg] & ~0xffff) | (this.logic(((this.d[reg] << 24) >> 24) & 0xffff, 1) & 0xffff);
      return;
    }
    if ((op & 0xfb80) === 0x4880) { this.movem(op); return; }
    if ((op & 0xf1c0) === 0x41c0) { this.ea(mode, reg, 2); this.a[(op >> 9) & 7] = this.ev; return; } // LEA
    if ((op & 0xf1c0) === 0x4180) { // CHK (no trap emulation)
      this.ea(mode, reg, 1); this.get(1); return;
    }
    if ((op & 0xffc0) === 0x4840) {
      if (mode === 0) { const v = this.d[reg]; const r = ((v << 16) | (v >>> 16)) | 0; this.d[reg] = r; this.logic(r >>> 0, 2); return; } // SWAP
      this.ea(mode, reg, 2); this.push32(this.ev); return; // PEA
    }
    if ((op & 0xffc0) === 0x40c0) { this.ea(mode, reg, 1); this.set(1, this.sr); return; }        // MOVE from SR
    if ((op & 0xffc0) === 0x44c0) { this.ea(mode, reg, 1); this.sr = (this.sr & 0xff00) | (this.get(1) & 0xff); return; }
    if ((op & 0xffc0) === 0x46c0) { this.ea(mode, reg, 1); this.sr = this.get(1); return; }
    if ((op & 0xffc0) === 0x4800) { // NBCD
      this.ea(mode, reg, 0); const d = this.get(0); this.set(0, this.sbcd(d, 0)); return;
    }
    if ((op & 0xffc0) === 0x4ac0) { // TAS
      this.ea(mode, reg, 0); const v = this.get(0); this.logic(v, 0); this.set(0, v | 0x80); return;
    }
    const size = (op >> 6) & 3;
    if (size === 3) throw new Error(`illegal opcode ${op.toString(16)}`);
    switch (op & 0xff00) {
      case 0x4000: { this.ea(mode, reg, size); const d = this.get(size); this.set(size, this.sub(d, 0, size, this.x, true)); return; } // NEGX
      case 0x4200: this.ea(mode, reg, size); this.get(size); this.set(size, 0); this.n = 0; this.z = 1; this.v = 0; this.c = 0; return; // CLR
      case 0x4400: { this.ea(mode, reg, size); const d = this.get(size); this.set(size, this.sub(d, 0, size)); return; } // NEG
      case 0x4600: { this.ea(mode, reg, size); const d = this.get(size); this.set(size, this.logic(~d, size)); return; } // NOT
      case 0x4a00: { this.ea(mode, reg, size); this.logic(this.get(size), size); return; } // TST
    }
    throw new Error(`illegal opcode ${op.toString(16)}`);
  }

  private movem(op: number) {
    const mode = (op >> 3) & 7, reg = op & 7, size = op & 0x40 ? 2 : 1;
    const mask = this.fetch16();
    const toReg = (op & 0x400) !== 0;
    const step = BYTES[size];
    if (toReg) {
      this.ea(mode === 3 ? 2 : mode, reg, size);
      let addr = this.ev;
      for (let i = 0; i < 16; i++) {
        if (!(mask & (1 << i))) continue;
        const v = size === 2 ? this.rd32(addr) | 0 : (this.rd16(addr) << 16) >> 16;
        if (i < 8) this.d[i] = v; else this.a[i - 8] = v;
        addr += step;
      }
      if (mode === 3) this.a[reg] = addr;
    } else if (mode === 4) {
      let addr = this.a[reg] >>> 0;
      for (let i = 0; i < 16; i++) {
        if (!(mask & (1 << i))) continue;
        const r = 15 - i;                               // mask bit 0 = A7 in predecrement mode
        const v = r < 8 ? this.d[r] : this.a[r - 8];
        addr -= step;
        if (size === 2) this.wr32(addr, v); else this.wr16(addr, v);
      }
      this.a[reg] = addr;
    } else {
      this.ea(mode, reg, size);
      let addr = this.ev;
      for (let i = 0; i < 16; i++) {
        if (!(mask & (1 << i))) continue;
        const v = i < 8 ? this.d[i] : this.a[i - 8];
        if (size === 2) this.wr32(addr, v); else this.wr16(addr, v);
        addr += step;
      }
    }
  }

  private group5(op: number) {
    const mode = (op >> 3) & 7, reg = op & 7;
    const size = (op >> 6) & 3;
    if (size === 3) {
      const cc = (op >> 8) & 15;
      if (mode === 1) { // DBcc
        const base = this.pc, disp = (this.fetch16() << 16) >> 16;
        if (!this.cond(cc)) {
          const w = ((this.d[reg] & 0xffff) - 1) & 0xffff;
          this.d[reg] = (this.d[reg] & ~0xffff) | w;
          if (w !== 0xffff) this.pc = (base + disp) >>> 0;
        }
        return;
      }
      this.ea(mode, reg, 0);
      this.set(0, this.cond(cc) ? 0xff : 0); return; // Scc
    }
    let q = (op >> 9) & 7; if (q === 0) q = 8;
    if (mode === 1) { // address register: no flags, whole register
      this.a[reg] += op & 0x100 ? -q : q; return;
    }
    this.ea(mode, reg, size);
    const d = this.get(size);
    this.set(size, op & 0x100 ? this.sub(q, d, size) : this.add(q, d, size));
  }

  private branch(op: number) {
    const cc = (op >> 8) & 15;
    const base = this.pc;
    let disp = (op << 24) >> 24;
    if ((op & 0xff) === 0) disp = (this.fetch16() << 16) >> 16;
    else if ((op & 0xff) === 0xff) disp = this.fetch32() | 0;
    if (cc === 1) { this.push32(this.pc); this.pc = (base + disp) >>> 0; return; } // BSR
    if (this.cond(cc)) this.pc = (base + disp) >>> 0;
  }

  private group8(op: number) {
    const mode = (op >> 3) & 7, reg = op & 7, dn = (op >> 9) & 7;
    const opm = (op >> 6) & 7;
    if (opm === 3) { // DIVU
      this.ea(mode, reg, 1); this.divide(this.get(1), dn, false); return;
    }
    if (opm === 7) { this.ea(mode, reg, 1); this.divide(this.get(1), dn, true); return; }
    if ((op & 0x1f0) === 0x100) { // SBCD
      const rm = op & 8;
      if (rm) {
        this.a[reg] -= 1; const s = this.rd8(this.a[reg]);
        this.a[dn] -= 1; const d = this.rd8(this.a[dn]);
        this.wr8(this.a[dn], this.sbcd(s, d));
      } else this.d[dn] = (this.d[dn] & ~0xff) | this.sbcd(this.d[reg] & 0xff, this.d[dn] & 0xff);
      return;
    }
    const size = opm & 3;
    this.ea(mode, reg, size);
    if (opm < 3) { const r = this.logic((this.d[dn] & MASK[size]) | this.get(size), size); this.setDn(dn, size, r); }
    else { const r = this.logic(this.get(size) | (this.d[dn] & MASK[size]), size); this.set(size, r); }
  }
  private setDn(dn: number, size: number, v: number) {
    if (size === 2) this.d[dn] = v;
    else if (size === 1) this.d[dn] = (this.d[dn] & ~0xffff) | (v & 0xffff);
    else this.d[dn] = (this.d[dn] & ~0xff) | (v & 0xff);
  }
  private divide(src: number, dn: number, signed: boolean) {
    if (src === 0) { this.v = 1; this.c = 0; return; } // zero divide trap is not emulated
    const dv = this.d[dn];
    if (signed) {
      const s = (src << 16) >> 16, q = Math.trunc(dv / s), r = dv - q * s;
      if (q > 32767 || q < -32768) { this.v = 1; this.c = 0; return; }
      this.d[dn] = ((r & 0xffff) << 16) | (q & 0xffff);
      this.n = q < 0 ? 1 : 0; this.z = q === 0 ? 1 : 0; this.v = 0; this.c = 0;
    } else {
      const u = dv >>> 0, q = Math.floor(u / src), r = u % src;
      if (q > 0xffff) { this.v = 1; this.c = 0; return; }
      this.d[dn] = ((r & 0xffff) << 16) | q;
      this.n = q & 0x8000 ? 1 : 0; this.z = q === 0 ? 1 : 0; this.v = 0; this.c = 0;
    }
  }
  /** dst - src - X in packed BCD (SBCD; NBCD calls it with dst = 0) */
  private sbcd(src: number, dst: number): number {
    let res = ((dst & 0xf) - (src & 0xf) - this.x) >>> 0;
    if (res > 9) res = (res - 6) >>> 0;
    res = (res + (dst & 0xf0) - (src & 0xf0)) >>> 0;
    this.c = this.x = res > 0x99 ? 1 : 0;
    if (this.c) res = (res + 0xa0) >>> 0;
    res &= 0xff;
    if (res !== 0) this.z = 0;
    this.n = res & 0x80 ? 1 : 0;
    return res;
  }
  private abcd(src: number, dst: number): number {
    let res = (src & 0xf) + (dst & 0xf) + this.x;
    if (res > 9) res += 6;
    res += (src & 0xf0) + (dst & 0xf0);
    this.c = this.x = res > 0x99 ? 1 : 0;
    if (this.c) res -= 0xa0;
    res &= 0xff;
    if (res !== 0) this.z = 0;
    this.n = res & 0x80 ? 1 : 0;
    return res;
  }

  private addsub(op: number, sub: boolean) {
    const mode = (op >> 3) & 7, reg = op & 7, dn = (op >> 9) & 7;
    const opm = (op >> 6) & 7;
    if (opm === 3 || opm === 7) { // ADDA/SUBA
      const size = opm === 3 ? 1 : 2;
      this.ea(mode, reg, size);
      const s = this.sext(this.get(size), size);
      this.a[dn] += sub ? -s : s; return;
    }
    const size = opm & 3;
    if (opm >= 4 && (mode === 0 || mode === 1)) { // ADDX/SUBX
      if (mode === 0) {
        const s = this.d[reg] & MASK[size], d = this.d[dn] & MASK[size];
        const r = sub ? this.sub(s >>> 0, d >>> 0, size, this.x, true) : this.add(s >>> 0, d >>> 0, size, this.x, true);
        this.setDn(dn, size, r);
      } else {
        this.a[reg] -= BYTES[size]; const s = size === 0 ? this.rd8(this.a[reg]) : size === 1 ? this.rd16(this.a[reg]) : this.rd32(this.a[reg]);
        this.a[dn] -= BYTES[size]; const d = size === 0 ? this.rd8(this.a[dn]) : size === 1 ? this.rd16(this.a[dn]) : this.rd32(this.a[dn]);
        const r = sub ? this.sub(s, d, size, this.x, true) : this.add(s, d, size, this.x, true);
        if (size === 0) this.wr8(this.a[dn], r); else if (size === 1) this.wr16(this.a[dn], r); else this.wr32(this.a[dn], r);
      }
      return;
    }
    this.ea(mode, reg, size);
    if (opm < 3) {
      const s = this.get(size), d = (this.d[dn] & MASK[size]) >>> 0;
      this.setDn(dn, size, sub ? this.sub(s, d, size) : this.add(s, d, size));
    } else {
      const d = this.get(size), s = (this.d[dn] & MASK[size]) >>> 0;
      this.set(size, sub ? this.sub(s, d, size) : this.add(s, d, size));
    }
  }

  private groupB(op: number) {
    const mode = (op >> 3) & 7, reg = op & 7, dn = (op >> 9) & 7;
    const opm = (op >> 6) & 7;
    if (opm === 3 || opm === 7) { // CMPA
      const size = opm === 3 ? 1 : 2;
      this.ea(mode, reg, size);
      const s = this.sext(this.get(size), size) >>> 0;
      this.sub(s, this.a[dn] >>> 0, 2, 0, false, false); return;
    }
    const size = opm & 3;
    if (opm >= 4) {
      if (mode === 1) { // CMPM
        const rd = (a: number) => (size === 0 ? this.rd8(a) : size === 1 ? this.rd16(a) : this.rd32(a));
        const s = rd(this.a[reg]); this.a[reg] += BYTES[size];
        const d = rd(this.a[dn]); this.a[dn] += BYTES[size];
        this.sub(s, d, size, 0, false, false); return;
      }
      this.ea(mode, reg, size); // EOR
      const r = this.logic(this.get(size) ^ (this.d[dn] & MASK[size]), size); this.set(size, r); return;
    }
    this.ea(mode, reg, size);
    this.sub(this.get(size), (this.d[dn] & MASK[size]) >>> 0, size, 0, false, false);
  }

  private groupC(op: number) {
    const mode = (op >> 3) & 7, reg = op & 7, dn = (op >> 9) & 7;
    const opm = (op >> 6) & 7;
    if (opm === 3) { // MULU
      this.ea(mode, reg, 1); const r = ((this.d[dn] & 0xffff) * this.get(1)) >>> 0;
      this.d[dn] = r | 0; this.logic(r, 2); return;
    }
    if (opm === 7) { // MULS
      this.ea(mode, reg, 1); const r = (((this.d[dn] << 16) >> 16) * ((this.get(1) << 16) >> 16)) | 0;
      this.d[dn] = r; this.logic(r >>> 0, 2); return;
    }
    if ((op & 0x1f0) === 0x100) { // ABCD
      if (op & 8) {
        this.a[reg] -= 1; const s = this.rd8(this.a[reg]);
        this.a[dn] -= 1; const d = this.rd8(this.a[dn]);
        this.wr8(this.a[dn], this.abcd(s, d));
      } else this.d[dn] = (this.d[dn] & ~0xff) | this.abcd(this.d[reg] & 0xff, this.d[dn] & 0xff);
      return;
    }
    if ((op & 0x1f8) === 0x140) { const t = this.d[dn]; this.d[dn] = this.d[reg]; this.d[reg] = t; return; }   // EXG Dx,Dy
    if ((op & 0x1f8) === 0x148) { const t = this.a[dn]; this.a[dn] = this.a[reg]; this.a[reg] = t; return; }   // EXG Ax,Ay
    if ((op & 0x1f8) === 0x188) { const t = this.d[dn]; this.d[dn] = this.a[reg]; this.a[reg] = t; return; }   // EXG Dx,Ay
    const size = opm & 3;
    this.ea(mode, reg, size);
    if (opm < 3) { const r = this.logic((this.d[dn] & MASK[size]) & this.get(size), size); this.setDn(dn, size, r); }
    else { const r = this.logic(this.get(size) & (this.d[dn] & MASK[size]), size); this.set(size, r); }
  }

  private shift(op: number) {
    const size = (op >> 6) & 3;
    if (size === 3) { // memory shift, word, by 1
      const mode = (op >> 3) & 7, reg = op & 7;
      this.ea(mode, reg, 1);
      const v = this.get(1);
      this.set(1, this.doShift((op >> 9) & 3, (op & 0x100) !== 0, v, 1, 1));
      return;
    }
    const reg = op & 7, cnt = (op >> 9) & 7;
    const count = op & 0x20 ? this.d[cnt] & 63 : cnt === 0 ? 8 : cnt;
    const v = (this.d[reg] & MASK[size]) >>> 0;
    this.setDn(reg, size, this.doShift((op >> 3) & 3, (op & 0x100) !== 0, v, size, count));
  }

  /** type: 0 AS, 1 LS, 2 ROX, 3 RO */
  private doShift(type: number, left: boolean, val: number, size: number, count: number): number {
    const bits = BYTES[size] * 8, m = MASK[size], msb = MSB[size];
    let v = val >>> 0, c = 0, ov = 0;
    if (count === 0) {
      this.c = type === 2 ? this.x : 0; this.v = 0;
      this.n = v & msb ? 1 : 0; this.z = v === 0 ? 1 : 0;
      return v;
    }
    for (let i = 0; i < count; i++) {
      if (left) {
        c = v & msb ? 1 : 0;
        const nv = (v * 2) % (m + 1);
        if (type === 0 && ((nv ^ v) & msb)) ov = 1;
        v = nv;
        if (type === 2) { v = (v | this.x) >>> 0; this.x = c; } else if (type === 3) v = (v | c) >>> 0;
        if (type !== 3) this.x = type === 2 ? this.x : c;
      } else {
        c = v & 1;
        const top = v & msb;
        v = Math.floor(v / 2);
        if (type === 0) v = (v | top) >>> 0;
        else if (type === 2) { if (this.x) v = (v | msb) >>> 0; this.x = c; }
        else if (type === 3) { if (c) v = (v | msb) >>> 0; }
        if (type < 2) this.x = c;
      }
    }
    this.c = c; this.v = type === 0 ? ov : 0;
    v >>>= 0;
    this.n = v & msb ? 1 : 0; this.z = v === 0 ? 1 : 0;
    return v;
  }
}
