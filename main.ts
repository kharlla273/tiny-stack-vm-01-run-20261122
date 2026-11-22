// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA (ISA.md in the kit).
// Runs every /input/<id>/program.bin on /input/<id>/input.bin and writes
// /output/<id>/stdout.bin + /output/<id>/exit.txt. Pure and deterministic:
// no clock, no environment, no randomness; the same set always gives the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Opcode table: [immediate bytes, values popped, values pushed] per opcode byte.
// Every opcode the ISA names; any other byte traps 5 (unknown opcode).
const T: Record<number, [number, number, number]> = {
  0x00: [0, 0, 0], 0x01: [1, 0, 1], 0x02: [4, 0, 1], 0x03: [0, 1, 0],
  0x04: [0, 1, 2], 0x05: [0, 2, 2], 0x06: [0, 2, 3], 0x07: [0, 3, 3],
  0x10: [0, 2, 1], 0x11: [0, 2, 1], 0x12: [0, 2, 1], 0x13: [0, 2, 1],
  0x14: [0, 2, 1], 0x15: [0, 2, 1], 0x16: [0, 2, 1], 0x17: [0, 1, 1],
  0x18: [0, 2, 1], 0x19: [0, 2, 1], 0x1a: [0, 2, 1], 0x1b: [0, 1, 1],
  0x1c: [0, 2, 1], 0x1d: [0, 2, 1], 0x1e: [0, 2, 1], 0x20: [0, 2, 1],
  0x21: [0, 2, 1], 0x22: [0, 2, 1],
  0x30: [2, 0, 0], 0x31: [2, 1, 0], 0x32: [2, 1, 0], 0x33: [2, 0, 0],
  0x34: [0, 0, 0], 0x40: [0, 1, 1], 0x41: [0, 2, 0],
  0x50: [0, 1, 0], 0x51: [0, 1, 0], 0x52: [0, 0, 1], 0x53: [0, 1, 0],
};

// Trap codes: 2 underflow, 3 overflow, 4 div-by-zero, 5 bad opcode, 6 bad
// memory address, 7 call-depth, 8 empty RET, 9 pc outside program, 10 step
// limit, 11 output limit. A trap keeps the output written before it.
function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const D = new Int32Array(256); let sp = 0;   // data stack, at most 256 values
  const C = new Int32Array(64); let cp = 0;    // call stack, at most 64 returns
  const M = new Int32Array(256);                // memory, 256 words, all 0
  const out = new Uint8Array(65536); let ol = 0;
  let pc = 0, ip = 0, steps = 0;
  const done = (code: number) => ({ out: out.subarray(0, ol), code });
  for (;;) {
    if (steps === 1000000) return done(10);          // step limit, checked first
    if (pc < 0 || pc >= p.length) return done(9);    // pc outside the program
    const op = p[pc];
    const t = T[op];
    if (!t) return done(5);                          // unknown opcode
    const [im, po, pu] = t;
    if (pc + im >= p.length) return done(9);         // immediate cut off by the end
    steps++;
    if (sp < po) return done(2);                     // stack underflow
    if (sp - po + pu > 256) return done(3);          // stack overflow
    pc += 1 + im;                                    // past opcode + immediate
    switch (op) {
      case 0x00: return done(0);                     // HALT
      case 0x01: D[sp++] = (p[pc - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 0x02: D[sp++] = p[pc - 4] | (p[pc - 3] << 8) | (p[pc - 2] << 16) | (p[pc - 1] << 24); break; // PUSH32
      case 0x03: sp--; break;                        // POP
      case 0x04: D[sp] = D[sp - 1]; sp++; break;     // DUP
      case 0x05: { const x = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = x; break; } // SWAP
      case 0x06: D[sp] = D[sp - 2]; sp++; break;     // OVER
      case 0x07: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; } // ROT
      case 0x17: D[sp - 1] = (-D[sp - 1]) | 0; break; // NEG, wraps at INT_MIN
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break;      // NOT
      case 0x30: case 0x31: case 0x32: {             // JMP / JZ / JNZ
        const rel = ((p[pc - 2] | (p[pc - 1] << 8)) << 16) >> 16;
        let take = op === 0x30;
        if (op !== 0x30) { const v = D[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc += rel;
        break;
      }
      case 0x33:                                     // CALL, unsigned 16-bit target
        if (cp === 64) return done(7);
        C[cp++] = pc;
        pc = p[pc - 2] | (p[pc - 1] << 8);
        break;
      case 0x34:                                     // RET
        if (cp === 0) return done(8);
        pc = C[--cp];
        break;
      case 0x40: {                                   // LOAD
        const a = D[sp - 1];
        if (a < 0 || a >= 256) return done(6);
        D[sp - 1] = M[a];
        break;
      }
      case 0x41: {                                   // STORE: ( v addr -- ), addr on top
        const a = D[sp - 1];
        if (a < 0 || a >= 256) return done(6);
        M[a] = D[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: {                                   // PRINT: decimal ASCII, no newline
        const s = String(D[sp - 1]);
        if (ol + s.length > 65536) return done(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51:                                     // PUTC: low byte
        if (ol + 1 > 65536) return done(11);
        out[ol++] = D[--sp] & 255;
        break;
      case 0x52: D[sp++] = ip < inp.length ? inp[ip++] : -1; break; // IN, -1 at end
      case 0x53: return done(D[--sp] & 255);         // EXIT, low byte is the code
      default: {                                     // binary ops 0x10-0x16, 0x18-0x1a, 0x1c-0x1e, 0x20-0x22
        const b = D[sp - 1], a = D[sp - 2];
        let r: number;
        switch (op) {
          case 0x10: r = (a + b) | 0; break;         // ADD, wraps
          case 0x11: r = (a - b) | 0; break;         // SUB, wraps
          case 0x12: r = Math.imul(a, b); break;     // MUL, low 32 bits of exact product
          case 0x13:                                 // DIV, truncates toward zero
            if (b === 0) return done(4);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14:                                 // MOD, sign of a; x % -1 is 0
            if (b === 0) return done(4);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15:                                 // DIVU, unsigned
            if (b === 0) return done(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16:                                 // MODU, unsigned
            if (b === 0) return done(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break;       // SHL, only low 5 bits count
          case 0x1d: r = a >> (b & 31); break;       // SHR, arithmetic
          case 0x1e: r = (a >>> (b & 31)) | 0; break; // SHRU, logical
          case 0x20: r = a === b ? 1 : 0; break;     // EQ
          case 0x21: r = a < b ? 1 : 0; break;       // LT, signed
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // 0x22 LTU, unsigned
        }
        sp -= 2;
        D[sp++] = r;
        break;
      }
    }
  }
}

// Answer every instance of the set in one run: /input/<id>/ -> /output/<id>/.
// A missing or unreadable instance file is an empty program/input, so one bad
// instance can never take the other 39 down with it.
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  let prog = new Uint8Array(0), inp = new Uint8Array(0);
  try { prog = new Uint8Array(readFileSync(join(I, id, 'program.bin'))); } catch { /* empty */ }
  try { inp = new Uint8Array(readFileSync(join(I, id, 'input.bin'))); } catch { /* empty */ }
  const r = run(prog, inp);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
