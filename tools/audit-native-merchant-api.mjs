/**
 * Audit the selected WoW 3.3.5a merchant Lua registration table against the
 * current FrameXML world seam. The PE is read only; no executable bytes are emitted.
 *
 * Run with Node >=22.15 and the source hook, so the comparison uses current TS:
 *   node --import ./tools/register-test-sources.mjs tools/audit-native-merchant-api.mjs F:\Circle\Wow.exe
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_WOW_SHA256 = '203b4b111ddc2d71612054d7aaf627fa6a7c929ed4f57e81b3c58df8284854a4';
export const MERCHANT_TABLE_START = 0x6ccd00;
export const MERCHANT_TABLE_END = 0x6ccda8;

function requireRange(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`${label} falls outside the PE file`);
  }
}

/** Parse only the PE32 fields needed to map 32-bit virtual addresses to file bytes. */
export function parsePe32Sections(bytes) {
  requireRange(bytes, 0, 0x40, 'DOS header');
  if (bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Expected an MZ header');
  const peOffset = bytes.readUInt32LE(0x3c);
  requireRange(bytes, peOffset, 24, 'PE header');
  if (bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('Expected a PE signature');
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  requireRange(bytes, optionalOffset, optionalSize, 'optional header');
  if (machine !== 0x14c || bytes.readUInt16LE(optionalOffset) !== 0x10b) {
    throw new Error('Expected a PE32 x86 executable');
  }
  if (optionalSize < 32 || sectionCount === 0 || sectionCount > 96) {
    throw new Error('Invalid PE section or optional-header size');
  }
  const imageBase = bytes.readUInt32LE(optionalOffset + 28);
  const sectionOffset = optionalOffset + optionalSize;
  requireRange(bytes, sectionOffset, sectionCount * 40, 'section table');
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const offset = sectionOffset + index * 40;
    const name = bytes.toString('ascii', offset, offset + 8).split('\0')[0];
    const virtualSize = bytes.readUInt32LE(offset + 8);
    const virtualAddress = bytes.readUInt32LE(offset + 12);
    const rawSize = bytes.readUInt32LE(offset + 16);
    const rawOffset = bytes.readUInt32LE(offset + 20);
    requireRange(bytes, rawOffset, rawSize, `section ${name}`);
    sections.push({ name, virtualSize, virtualAddress, rawSize, rawOffset });
  }
  return { imageBase, sections };
}

/** Return the file-backed byte and section for a PE32 VA, or undefined. */
export function fileLocationForVa(pe, va) {
  const rva = va - pe.imageBase;
  if (!Number.isSafeInteger(rva) || rva < 0) return undefined;
  for (const section of pe.sections) {
    const delta = rva - section.virtualAddress;
    if (delta >= 0 && delta < section.rawSize &&
        delta < Math.max(section.virtualSize, section.rawSize)) {
      return { offset: section.rawOffset + delta, section: section.name };
    }
  }
  return undefined;
}

function nameAtVa(bytes, pe, va) {
  const location = fileLocationForVa(pe, va);
  if (!location || !['.rdata', '.data'].includes(location.section)) {
    throw new Error(`Merchant name VA 0x${va.toString(16)} is outside PE data`);
  }
  const section = pe.sections.find((entry) =>
    entry.name === location.section &&
    location.offset >= entry.rawOffset && location.offset < entry.rawOffset + entry.rawSize);
  let end = location.offset;
  const limit = Math.min(section.rawOffset + section.rawSize, location.offset + 96);
  while (end < limit && bytes[end] !== 0) end++;
  if (end === limit) throw new Error(`Unterminated merchant API name at VA 0x${va.toString(16)}`);
  for (let offset = location.offset; offset < end; offset++) {
    if (bytes[offset] > 0x7f) throw new Error(`Non-ASCII merchant API name at VA 0x${va.toString(16)}`);
  }
  const name = bytes.toString('ascii', location.offset, end);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid merchant API name at VA 0x${va.toString(16)}`);
  }
  return name;
}

/** This range is specific to the verified 3.3.5.12340 executable. */
export function merchantRegistrations(bytes, start = MERCHANT_TABLE_START, end = MERCHANT_TABLE_END) {
  if (start >= end || (end - start) % 8 !== 0) throw new Error('Invalid merchant table bounds');
  requireRange(bytes, start, end - start, 'merchant table');
  const pe = parsePe32Sections(bytes);
  const names = [];
  const seen = new Set();
  for (let offset = start; offset < end; offset += 8) {
    const nameVa = bytes.readUInt32LE(offset);
    const functionVa = bytes.readUInt32LE(offset + 4);
    const functionLocation = fileLocationForVa(pe, functionVa);
    if (functionLocation?.section !== '.text') {
      throw new Error(`Merchant function VA 0x${functionVa.toString(16)} is outside .text`);
    }
    const name = nameAtVa(bytes, pe, nameVa);
    if (seen.has(name)) throw new Error(`Duplicate merchant API name: ${name}`);
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function assertExpectedWowHash(bytes) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== EXPECTED_WOW_SHA256) {
    throw new Error(`Unsupported Wow.exe SHA-256 ${actual}; expected ${EXPECTED_WOW_SHA256}`);
  }
  return actual;
}

export function compareMerchantSeam(nativeNames, seamNames) {
  const registeredNames = new Set(seamNames);
  return {
    registered: nativeNames.filter((name) => registeredNames.has(name)),
    missing: nativeNames.filter((name) => !registeredNames.has(name)),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
    const stream = args.length === 1 ? process.stdout : process.stderr;
    stream.write('Usage: node --import ./tools/register-test-sources.mjs tools/audit-native-merchant-api.mjs <Wow.exe>\n');
    if (args.length === 1) return;
    process.exitCode = 2;
    return;
  }
  const bytes = await readFile(resolve(args[0]));
  const sha256 = assertExpectedWowHash(bytes);
  const nativeNames = merchantRegistrations(bytes);
  // The source hook resolves this dist URL to the current TypeScript source.
  const { FRAMEXML_SEAM_NAMES } = await import('../dist/code/browser/framexml/FrameXmlWorldSeam.js');
  const { registered, missing } = compareMerchantSeam(nativeNames, FRAMEXML_SEAM_NAMES);
  process.stdout.write(JSON.stringify({
    sha256,
    tableFileRange: '0x6ccd00..0x6ccda7',
    nativeCount: nativeNames.length,
    seamRegisteredCount: registered.length,
    seamMissingCount: missing.length,
    registered,
    missing,
  }, null, 2) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`Merchant API audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
