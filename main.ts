// Tiny stack VM for make.fun tiny-stack-vm-01 (ISA.md in the kit): runs each
// /input/<id>/program.bin on /input/<id>/input.bin, writes /output/<id>/stdout.bin
// and /output/<id>/exit.txt. Deterministic: no clock, env, or randomness.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Traps: 2 underflow, 3 overflow, 4 div-by-zero, 5 bad opcode, 6 bad address,
// 7 call depth, 8 empty RET, 9 pc outside, 10 step limit, 11 output limit.
// A trap keeps the output written before it; its code is the exit code.
function run(p, inp) {
  const D = new Int32Array(256); let sp = 0;
  const C = new Int32Array(64); let cp = 0;
  const M = new Int32Array(256);
  const out = new Uint8Array(65536); let ol = 0;
  let pc = 0, ip = 0, steps = 0;
  const done = (code) => ({ out: out.subarray(0, ol), code });
  for (;;) {
    if (steps === 1e6) return done(10);
    if (pc < 0 || pc >= p.length) return done(9);
    const op = p[pc];
    let im = 0, po = 0, pu = 0;
    if (op < 8) {
      if (op === 1) im = 1; else if (op === 2) im = 4;
      po = op === 7 ? 3 : op === 5 || op === 6 ? 2 : op === 3 || op === 4 ? 1 : 0;
      pu = op === 6 || op === 7 ? 3 : op === 4 || op === 5 ? 2 : op === 1 || op === 2 ? 1 : 0;
    } else if (op >= 0x10 && op <= 0x22) { po = op === 0x17 || op === 0x1b ? 1 : 2; pu = 1; }
    else if (op >= 0x30 && op <= 0x33) { im = 2; po = op === 0x31 || op === 0x32 ? 1 : 0; }
    else if (op === 0x34) { /* RET: no immediate, no stack effect */ }
    else if (op === 0x40) { po = 1; pu = 1; }
    else if (op === 0x41) { po = 2; }
    else if (op >= 0x50 && op <= 0x53) { po = op === 0x52 ? 0 : 1; pu = op === 0x52 ? 1 : 0; }
    else return done(5);
    if (pc + im >= p.length) return done(9);
    steps++;
    if (sp < po) return done(2);
    if (sp - po + pu > 256) return done(3);
    pc += 1 + im;
    switch (op) {
      case 0: return done(0);
      case 1: D[sp++] = (p[pc - 1] << 24) >> 24; break;
      case 2: D[sp++] = p[pc - 4] | (p[pc - 3] << 8) | (p[pc - 2] << 16) | (p[pc - 1] << 24); break;
      case 3: sp--; break;
      case 4: D[sp] = D[sp - 1]; sp++; break;
      case 5: { const x = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = x; break; }
      case 6: D[sp] = D[sp - 2]; sp++; break;
      case 7: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; }
      case 0x17: D[sp - 1] = (-D[sp - 1]) | 0; break;
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break;
      case 0x30: case 0x31: case 0x32: {
        const rel = ((p[pc - 2] | (p[pc - 1] << 8)) << 16) >> 16;
        let take = op === 0x30;
        if (!take) { const v = D[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc += rel;
        break;
      }
      case 0x33:
        if (cp === 64) return done(7);
        C[cp++] = pc;
        pc = p[pc - 2] | (p[pc - 1] << 8);
        break;
      case 0x34:
        if (cp === 0) return done(8);
        pc = C[--cp];
        break;
      case 0x40: {
        const a = D[sp - 1];
        if (a < 0 || a >= 256) return done(6);
        D[sp - 1] = M[a];
        break;
      }
      case 0x41: {
        const a = D[sp - 1];
        if (a < 0 || a >= 256) return done(6);
        M[a] = D[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: {
        const s = String(D[sp - 1]);
        if (ol + s.length > 65536) return done(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51:
        if (ol + 1 > 65536) return done(11);
        out[ol++] = D[--sp] & 255;
        break;
      case 0x52: D[sp++] = ip < inp.length ? inp[ip++] : -1; break;
      case 0x53: return done(D[--sp] & 255);
      default: {
        const b = D[sp - 1], a = D[sp - 2];
        let r;
        switch (op) {
          case 0x10: r = (a + b) | 0; break;
          case 0x11: r = (a - b) | 0; break;
          case 0x12: r = Math.imul(a, b); break;
          case 0x13:
            if (b === 0) return done(4);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14:
            if (b === 0) return done(4);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15:
            if (b === 0) return done(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16:
            if (b === 0) return done(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break;
          case 0x1d: r = a >> (b & 31); break;
          case 0x1e: r = (a >>> (b & 31)) | 0; break;
          case 0x20: r = a === b ? 1 : 0; break;
          case 0x21: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
        }
        sp -= 2;
        D[sp++] = r;
        break;
      }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  let prog = new Uint8Array(0), inp = new Uint8Array(0);
  try { prog = new Uint8Array(readFileSync(join(I, id, 'program.bin'))); } catch {}
  try { inp = new Uint8Array(readFileSync(join(I, id, 'input.bin'))); } catch {}
  const r = run(prog, inp);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), r.code + '\n');
}
