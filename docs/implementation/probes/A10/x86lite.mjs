// A10 (read-only static analysis): a small 32-bit x86 decoder, enough to READ MSVC-built game code.
// Nothing here executes anything; it maps a PE file, finds references to a string and prints a
// linear-sweep listing. Mnemonics cover the common integer subset; anything else prints as `db`
// but still has the right LENGTH for the opcode map it knows, so the sweep stays in sync.

export function parsePe(buffer) {
  const peAt = buffer.readUInt32LE(0x3c);
  if (buffer.toString("latin1", peAt, peAt + 4) !== "PE\0\0") throw new Error("not a PE file");
  const sectionCount = buffer.readUInt16LE(peAt + 6);
  const optionalSize = buffer.readUInt16LE(peAt + 20);
  const optional = peAt + 24;
  const imageBase = buffer.readUInt32LE(optional + 28);
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const at = optional + optionalSize + index * 40;
    sections.push({
      name: buffer.toString("latin1", at, at + 8).replace(/\0.*$/, ""),
      virtualSize: buffer.readUInt32LE(at + 8), rva: buffer.readUInt32LE(at + 12),
      rawSize: buffer.readUInt32LE(at + 16), rawPointer: buffer.readUInt32LE(at + 20),
      flags: buffer.readUInt32LE(at + 36),
    });
  }
  const fileToVa = (offset) => {
    for (const s of sections) if (offset >= s.rawPointer && offset < s.rawPointer + s.rawSize) return imageBase + s.rva + (offset - s.rawPointer);
    return undefined;
  };
  const vaToFile = (va) => {
    const rva = va - imageBase;
    for (const s of sections) if (rva >= s.rva && rva < s.rva + Math.max(s.virtualSize, s.rawSize)) return s.rawPointer + (rva - s.rva);
    return undefined;
  };
  const sectionOfFile = (offset) => sections.find((s) => offset >= s.rawPointer && offset < s.rawPointer + s.rawSize);
  return { imageBase, sections, fileToVa, vaToFile, sectionOfFile };
}

const R32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
const R16 = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"];
const R8 = ["al", "cl", "dl", "bl", "ah", "ch", "dh", "bh"];
const ALU = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"];
const SHIFT = ["rol", "ror", "rcl", "rcr", "shl", "shr", "shl", "sar"];
const CC = ["o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g"];
const hexs = (v) => (v < 0 ? `-0x${(-v).toString(16)}` : `0x${v.toString(16)}`);

export function decode(buffer, at, pe) {
  const start = at;
  let opsize = false; let prefix = "";
  for (;;) {
    const b = buffer[at];
    if (b === 0x66) { opsize = true; at++; } else if (b === 0xf2 || b === 0xf3) { prefix = b === 0xf3 ? "rep " : "repne "; at++; }
    else if ([0x2e, 0x36, 0x3e, 0x26, 0x64, 0x65, 0xf0, 0x67].includes(b)) { prefix += `seg${b.toString(16)} `; at++; }
    else break;
  }
  const reg = (n, size) => (size === 1 ? R8[n] : size === 2 ? R16[n] : R32[n]);
  const width = () => (opsize ? 2 : 4);
  const imm8 = () => buffer.readInt8(at++);
  const imm32 = () => { const v = buffer.readInt32LE(at); at += 4; return v; };
  const imm16 = () => { const v = buffer.readInt16LE(at); at += 2; return v; };
  const immz = () => (opsize ? imm16() : imm32());
  // ModRM: returns { r: reg field, e: operand text, isReg, rm }
  const modrm = (size) => {
    const m = buffer[at++];
    const mod = m >> 6; const r = (m >> 3) & 7; const rm = m & 7;
    if (mod === 3) return { r, e: reg(rm, size), isReg: true, rm };
    let base = null; let index = null; let scale = 1; let disp = 0; let text;
    if (rm === 4) {
      const s = buffer[at++];
      scale = 1 << (s >> 6); const idx = (s >> 3) & 7; const bs = s & 7;
      if (idx !== 4) index = R32[idx];
      if (bs === 5 && mod === 0) { disp = imm32(); base = null; } else base = R32[bs];
    } else if (rm === 5 && mod === 0) { disp = imm32(); base = null; text = `[${hexs(disp >>> 0)}]`; }
    else base = R32[rm];
    if (mod === 1) disp = imm8(); else if (mod === 2) disp = imm32();
    if (text === undefined) {
      const parts = [];
      if (base) parts.push(base);
      if (index) parts.push(scale === 1 ? index : `${index}*${scale}`);
      let inner = parts.join("+");
      if (disp !== 0 || parts.length === 0) inner += (disp < 0 ? "-" : parts.length ? "+" : "") + (disp < 0 ? `0x${(-disp).toString(16)}` : `0x${(disp >>> 0).toString(16)}`);
      text = `[${inner}]`;
    }
    const sz = size === 1 ? "byte " : size === 2 ? "word " : "dword ";
    return { r, e: `${sz}ptr ${text}`, isReg: false, rm, disp, base };
  };
  const b = buffer[at++];
  let text;
  const rel = (delta) => `0x${(pe?.fileToVa(at + delta - 0) ?? at + delta).toString(16)}`;
  if (b < 0x40 && (b & 7) < 6) {
    const op = ALU[b >> 3]; const kind = b & 7;
    if (kind === 4) text = `${op} al, ${hexs(imm8())}`;
    else if (kind === 5) text = `${op} ${opsize ? "ax" : "eax"}, ${hexs(immz())}`;
    else {
      const size = kind & 1 ? width() : 1; const m = modrm(size);
      text = kind < 2 ? `${op} ${m.e}, ${reg(m.r, size)}` : `${op} ${reg(m.r, size)}, ${m.e}`;
    }
  } else if (b === 0x0f) {
    const c = buffer[at++];
    if (c >= 0x80 && c <= 0x8f) { const d = imm32(); text = `j${CC[c & 15]} ${rel(d)}`; }
    else if (c >= 0x90 && c <= 0x9f) { const m = modrm(1); text = `set${CC[c & 15]} ${m.e}`; }
    else if (c >= 0x40 && c <= 0x4f) { const m = modrm(width()); text = `cmov${CC[c & 15]} ${reg(m.r, width())}, ${m.e}`; }
    else if (c === 0xb6 || c === 0xb7 || c === 0xbe || c === 0xbf) {
      const m = modrm(c & 1 ? 2 : 1); text = `${c >= 0xbe ? "movsx" : "movzx"} ${reg(m.r, 4)}, ${m.e}`;
    } else if (c === 0xaf) { const m = modrm(width()); text = `imul ${reg(m.r, width())}, ${m.e}`; }
    else if (c === 0x1f) { modrm(4); text = "nop"; }
    else if (c === 0xa2) text = "cpuid";
    else if (c >= 0xc8 && c <= 0xcf) text = `bswap ${R32[c & 7]}`;
    else if (c === 0xba) { const m = modrm(4); text = `bt* ${m.e}, ${imm8()}`; }
    else if ([0xa3, 0xab, 0xb3, 0xbb, 0xbc, 0xbd, 0xb0, 0xb1, 0xc0, 0xc1].includes(c)) { const m = modrm(width()); text = `op0f${c.toString(16)} ${reg(m.r, width())}, ${m.e}`; }
    else if (c === 0xa4 || c === 0xac) { const m = modrm(4); text = `shxd ${m.e}, ${reg(m.r, 4)}, ${imm8()}`; }
    else if (c === 0xa5 || c === 0xad) { const m = modrm(4); text = `shxd ${m.e}, ${reg(m.r, 4)}, cl`; }
    else if (c === 0xc6) { const m = modrm(4); text = `shufps ${m.e}, ${imm8()}`; }
    else if (c === 0x70 || c === 0x71 || c === 0x72 || c === 0x73) { const m = modrm(4); text = `sse0f${c.toString(16)} ${m.e}, ${imm8()}`; }
    else if (c >= 0x10 && c <= 0x7f || c >= 0xd0) { const m = modrm(4); text = `sse0f${c.toString(16)} ${m.isReg ? "x" + m.r : "x" + m.r + ", " + m.e}`; }
    else text = `db 0x0f, 0x${c.toString(16)}`;
  } else if (b >= 0x40 && b <= 0x47) text = `inc ${reg(b & 7, width())}`;
  else if (b >= 0x48 && b <= 0x4f) text = `dec ${reg(b & 7, width())}`;
  else if (b >= 0x50 && b <= 0x57) text = `push ${R32[b & 7]}`;
  else if (b >= 0x58 && b <= 0x5f) text = `pop ${R32[b & 7]}`;
  else if (b === 0x60) text = "pushad"; else if (b === 0x61) text = "popad";
  else if (b === 0x68) text = `push ${hexs(immz() >>> 0)}`;
  else if (b === 0x6a) text = `push ${hexs(imm8())}`;
  else if (b === 0x69 || b === 0x6b) { const m = modrm(width()); text = `imul ${reg(m.r, width())}, ${m.e}, ${hexs(b === 0x69 ? immz() : imm8())}`; }
  else if (b >= 0x70 && b <= 0x7f) { const d = imm8(); text = `j${CC[b & 15]} ${rel(d)}`; }
  else if (b === 0x80 || b === 0x81 || b === 0x83) {
    const size = b === 0x80 ? 1 : width(); const m = modrm(size);
    const v = b === 0x81 ? immz() : imm8(); text = `${ALU[m.r]} ${m.e}, ${hexs(v)}`;
  } else if (b === 0x84 || b === 0x85) { const size = b & 1 ? width() : 1; const m = modrm(size); text = `test ${m.e}, ${reg(m.r, size)}`; }
  else if (b === 0x86 || b === 0x87) { const size = b & 1 ? width() : 1; const m = modrm(size); text = `xchg ${m.e}, ${reg(m.r, size)}`; }
  else if (b >= 0x88 && b <= 0x8b) {
    const size = b & 1 ? width() : 1; const m = modrm(size);
    text = b < 0x8a ? `mov ${m.e}, ${reg(m.r, size)}` : `mov ${reg(m.r, size)}, ${m.e}`;
  } else if (b === 0x8d) { const m = modrm(4); text = `lea ${reg(m.r, 4)}, ${m.e.replace(/^dword ptr /, "")}`; }
  else if (b === 0x8f) { const m = modrm(4); text = `pop ${m.e}`; }
  else if (b === 0x90) text = "nop"; else if (b > 0x90 && b <= 0x97) text = `xchg eax, ${R32[b & 7]}`;
  else if (b === 0x98) text = "cwde"; else if (b === 0x99) text = "cdq";
  else if (b === 0x9b) text = "wait"; else if (b === 0x9c) text = "pushfd"; else if (b === 0x9d) text = "popfd";
  else if (b === 0x9e) text = "sahf"; else if (b === 0x9f) text = "lahf";
  else if (b >= 0xa0 && b <= 0xa3) { const a = imm32() >>> 0; text = b < 0xa2 ? `mov ${b & 1 ? "eax" : "al"}, [${hexs(a)}]` : `mov [${hexs(a)}], ${b & 1 ? "eax" : "al"}`; }
  else if (b === 0xa4 || b === 0xa5) text = `${prefix}movs${b & 1 ? "d" : "b"}`;
  else if (b === 0xa6 || b === 0xa7) text = `${prefix}cmps${b & 1 ? "d" : "b"}`;
  else if (b === 0xa8) text = `test al, ${hexs(imm8())}`; else if (b === 0xa9) text = `test eax, ${hexs(immz())}`;
  else if (b === 0xaa || b === 0xab) text = `${prefix}stos${b & 1 ? "d" : "b"}`;
  else if (b === 0xac || b === 0xad) text = `lods${b & 1 ? "d" : "b"}`;
  else if (b === 0xae || b === 0xaf) text = `${prefix}scas${b & 1 ? "d" : "b"}`;
  else if (b >= 0xb0 && b <= 0xb7) text = `mov ${R8[b & 7]}, ${hexs(imm8())}`;
  else if (b >= 0xb8 && b <= 0xbf) text = `mov ${reg(b & 7, width())}, ${hexs(immz() >>> 0)}`;
  else if (b === 0xc0 || b === 0xc1) { const size = b & 1 ? width() : 1; const m = modrm(size); text = `${SHIFT[m.r]} ${m.e}, ${imm8()}`; }
  else if (b === 0xc2) text = `ret ${imm16()}`; else if (b === 0xc3) text = "ret";
  else if (b === 0xc6 || b === 0xc7) { const size = b & 1 ? width() : 1; const m = modrm(size); text = `mov ${m.e}, ${hexs(size === 1 ? imm8() : immz() >>> 0)}`; }
  else if (b === 0xc9) text = "leave"; else if (b === 0xcc) text = "int3"; else if (b === 0xcd) text = `int ${hexs(buffer[at++])}`;
  else if (b >= 0xd0 && b <= 0xd3) { const size = b & 1 ? width() : 1; const m = modrm(size); text = `${SHIFT[m.r]} ${m.e}, ${b < 0xd2 ? "1" : "cl"}`; }
  else if (b >= 0xd8 && b <= 0xdf) { const m = modrm(4); text = `fpu${b.toString(16)}/${m.r} ${m.isReg ? "st" + m.rm : m.e}`; }
  else if (b === 0xe8) { const d = imm32(); text = `call ${rel(d)}`; }
  else if (b === 0xe9) { const d = imm32(); text = `jmp ${rel(d)}`; }
  else if (b === 0xeb) { const d = imm8(); text = `jmp ${rel(d)}`; }
  else if (b === 0xf4) text = "hlt";
  else if (b === 0xf6 || b === 0xf7) {
    const size = b & 1 ? width() : 1; const m = modrm(size);
    const names = ["test", "test", "not", "neg", "mul", "imul", "div", "idiv"];
    text = m.r < 2 ? `test ${m.e}, ${hexs(size === 1 ? imm8() : immz())}` : `${names[m.r]} ${m.e}`;
  } else if (b === 0xfe || b === 0xff) {
    const size = b & 1 ? width() : 1; const m = modrm(size);
    const names = ["inc", "dec", "call", "call far", "jmp", "jmp far", "push", ""];
    text = `${names[m.r]} ${m.e}`;
  } else if (b >= 0xf8 && b <= 0xfd) text = ["clc", "stc", "cli", "sti", "cld", "std"][b - 0xf8];
  else text = `db 0x${b.toString(16)}`;
  return { length: at - start, text: `${prefix.startsWith("rep") && !/^(movs|cmps|stos|scas)/.test(text) ? prefix : ""}${text}` };
}

/** Prints `count` instructions from a file offset, with virtual addresses. */
export function listing(buffer, offset, count, pe, marks = new Set()) {
  const lines = [];
  let at = offset;
  for (let index = 0; index < count && at < buffer.length; index++) {
    let instruction;
    try { instruction = decode(buffer, at, pe); } catch { instruction = { length: 1, text: "db ?" }; }
    const bytes = [...buffer.subarray(at, at + instruction.length)].map((v) => v.toString(16).padStart(2, "0")).join(" ");
    const va = pe.fileToVa(at);
    lines.push(`${marks.has(at) ? ">" : " "}${va?.toString(16).padStart(8, "0") ?? "????????"}  ${bytes.padEnd(22)} ${instruction.text}`);
    at += instruction.length;
  }
  return lines.join("\n");
}
