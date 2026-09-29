import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertExpectedWowHash,
  compareMerchantSeam,
  fileLocationForVa,
  merchantRegistrations,
  parsePe32Sections,
} from '../tools/audit-native-merchant-api.mjs';

function peFixture() {
  const bytes = Buffer.alloc(0x500);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(0x14c, 0x84);
  bytes.writeUInt16LE(3, 0x86);
  bytes.writeUInt16LE(0xe0, 0x94);
  bytes.writeUInt16LE(0x10b, 0x98);
  bytes.writeUInt32LE(0x400000, 0x98 + 28);
  const sectionTable = 0x80 + 24 + 0xe0;
  function section(index, name, rva, rawOffset) {
    const offset = sectionTable + index * 40;
    bytes.write(name, offset, 'ascii');
    bytes.writeUInt32LE(0x80, offset + 8); // virtual size
    bytes.writeUInt32LE(rva, offset + 12);
    bytes.writeUInt32LE(0x100, offset + 16); // file-backed size
    bytes.writeUInt32LE(rawOffset, offset + 20);
  }
  section(0, '.text', 0x1000, 0x200);
  section(1, '.rdata', 0x2000, 0x300);
  section(2, '.data', 0x3000, 0x400);
  bytes.write('CanMerchantRepair\0', 0x320, 'ascii');
  bytes.write('GetRepairAllCost\0', 0x340, 'ascii');
  bytes.writeUInt32LE(0x402020, 0x400);
  bytes.writeUInt32LE(0x401020, 0x404);
  bytes.writeUInt32LE(0x402040, 0x408);
  bytes.writeUInt32LE(0x401030, 0x40c);
  return bytes;
}

test('PE32 VA mapping reads the named Lua table rather than treating a VA as a file offset', () => {
  const bytes = peFixture();
  const pe = parsePe32Sections(bytes);
  assert.equal(pe.imageBase, 0x400000);
  assert.deepEqual(fileLocationForVa(pe, 0x402020), { offset: 0x320, section: '.rdata' });
  assert.deepEqual(fileLocationForVa(pe, 0x401030), { offset: 0x230, section: '.text' });
  assert.equal(fileLocationForVa(pe, 0x404000), undefined);
  assert.deepEqual(merchantRegistrations(bytes, 0x400, 0x410), [
    'CanMerchantRepair', 'GetRepairAllCost',
  ]);
});

test('merchant table rejects an unmapped function and the wrong binary fingerprint', () => {
  const bytes = peFixture();
  bytes.writeUInt32LE(0x404000, 0x404);
  assert.throws(() => merchantRegistrations(bytes, 0x400, 0x410), /outside \.text/);
  assert.throws(() => assertExpectedWowHash(bytes), /Unsupported Wow\.exe SHA-256/);
});

test('comparison labels only explicit seam names; absence is not an implementation verdict', () => {
  assert.deepEqual(
    compareMerchantSeam(['CanMerchantRepair', 'RepairAllItems'], ['CanMerchantRepair']),
    { registered: ['CanMerchantRepair'], missing: ['RepairAllItems'] },
  );
});
