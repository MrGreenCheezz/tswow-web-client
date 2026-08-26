import assert from "node:assert/strict";
import test from "node:test";
import {
  ALPHA_SIZE,
  alphaNeedsEdgeFix,
  decodeAlpha,
  decompressAlpha,
  expandAlpha4Bit,
  fixAlphaEdges,
  mapChunkAlpha,
  mapChunkColours,
  mapChunkDetail,
  mapChunkGrid,
  readAlpha8Bit,
} from "../tools/adt-alpha.mjs";

// ADT chunk tags are stored reversed on disk.
function reversedTag(buffer, offset, tag) {
  for (let index = 0; index < 4; index++) buffer[offset + index] = tag.charCodeAt(3 - index);
}

// Minimal MCNK payload: 128 byte header, one MCLY sub-chunk, one MCAL sub-chunk.
function mapChunk({ flags = 0, layers = 2, headerAlphaSize, subChunkAlphaSize, payload = 8 }) {
  const layerOffset = 128 + 8;
  const alphaOffset = layerOffset + layers * 16 + 8;
  const buffer = Buffer.alloc(alphaOffset + payload);
  buffer.writeUInt32LE(flags, 0x00);
  buffer.writeUInt32LE(layers, 0x0c);
  buffer.writeUInt32LE(layerOffset, 0x1c);
  buffer.writeUInt32LE(alphaOffset, 0x24);
  buffer.writeUInt32LE(headerAlphaSize, 0x28);
  reversedTag(buffer, layerOffset - 8, "MCLY");
  buffer.writeUInt32LE(layers * 16, layerOffset - 4);
  reversedTag(buffer, alphaOffset - 8, "MCAL");
  buffer.writeUInt32LE(subChunkAlphaSize, alphaOffset - 4);
  return { buffer, alphaOffset };
}

test("MCAL size comes from the MCNK header, not the sub-chunk length", () => {
  // Every sampled Northrend tile writes zero into the MCAL sub-chunk length while the
  // MCNK header stays correct; trusting the sub-chunk drops the layer entirely.
  const northrend = mapChunk({ headerAlphaSize: 8 + 128, subChunkAlphaSize: 0, payload: 128 });
  assert.deepEqual(mapChunkAlpha(northrend.buffer, 0, northrend.buffer.length), {
    flags: 0,
    alphaOffset: northrend.alphaOffset,
    alphaSize: 128,
  });

  // Azeroth writes both, and they agree.
  const azeroth = mapChunk({ headerAlphaSize: 8 + 2048, subChunkAlphaSize: 2048, payload: 2048 });
  assert.equal(mapChunkAlpha(azeroth.buffer, 0, azeroth.buffer.length).alphaSize, 2048);
});

test("MCAL size falls back to the sub-chunk length and stays inside the chunk", () => {
  const missingHeader = mapChunk({ headerAlphaSize: 0, subChunkAlphaSize: 64, payload: 64 });
  assert.equal(mapChunkAlpha(missingHeader.buffer, 0, missingHeader.buffer.length).alphaSize, 64);

  const overrun = mapChunk({ headerAlphaSize: 8 + 4096, subChunkAlphaSize: 4096, payload: 32 });
  const clamped = mapChunkAlpha(overrun.buffer, 0, overrun.buffer.length);
  assert.equal(clamped.alphaSize, 32);

  const none = mapChunk({ headerAlphaSize: 8, subChunkAlphaSize: 0, payload: 0 });
  none.buffer.writeUInt32LE(0, 0x24);
  assert.deepEqual(mapChunkAlpha(none.buffer, 0, none.buffer.length), { flags: 0, alphaOffset: 0, alphaSize: 0 });
});

test("do_not_fix_alpha_map decides whether the 63x63 correction applies", () => {
  assert.equal(alphaNeedsEdgeFix(0x0001), true);
  assert.equal(alphaNeedsEdgeFix(0x8001), false);
  const northrend = mapChunk({ flags: 0x8040, headerAlphaSize: 8 + 128, subChunkAlphaSize: 0, payload: 128 });
  assert.equal(alphaNeedsEdgeFix(mapChunkAlpha(northrend.buffer, 0, northrend.buffer.length).flags), false);
});

test("the edge correction copies the last row, column and corner", () => {
  const alpha = new Uint8Array(ALPHA_SIZE);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) alpha[y * 64 + x] = (x + y) & 0xff;
  for (let index = 0; index < 64; index++) {
    alpha[63 * 64 + index] = 200; // garbage last row
    alpha[index * 64 + 63] = 201; // garbage last column
  }

  fixAlphaEdges(alpha);

  for (let index = 0; index < 62; index++) {
    assert.equal(alpha[63 * 64 + index], alpha[62 * 64 + index], `row at ${index}`);
    assert.equal(alpha[index * 64 + 63], alpha[index * 64 + 62], `column at ${index}`);
  }
  assert.equal(alpha[63 * 64 + 63], alpha[62 * 64 + 62]);
  assert.equal(alpha[10 * 64 + 10], 20); // interior untouched
});

test("4 bit alpha expands low nibble first and scales by 17", () => {
  const raw = new Uint8Array(2048);
  raw[0] = 0xf0;
  raw[1] = 0x0f;
  const alpha = expandAlpha4Bit(raw);
  assert.equal(alpha.length, ALPHA_SIZE);
  assert.deepEqual([...alpha.subarray(0, 4)], [0, 255, 255, 0]);
});

test("8 bit alpha is copied verbatim and short buffers pad with zero", () => {
  const raw = new Uint8Array(ALPHA_SIZE).fill(7);
  assert.deepEqual([...readAlpha8Bit(raw).subarray(0, 3)], [7, 7, 7]);
  const short = readAlpha8Bit(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...short.subarray(0, 4)], [1, 2, 3, 0]);
});

test("compressed alpha decodes fill and copy runs and never overruns", () => {
  const raw = new Uint8Array([0x80 | 3, 9, 3, 1, 2, 3, 0x80 | 0x7f, 5]);
  const alpha = decompressAlpha(raw);
  assert.deepEqual([...alpha.subarray(0, 6)], [9, 9, 9, 1, 2, 3]);
  assert.equal(alpha[6], 5);
  assert.equal(alpha.length, ALPHA_SIZE);

  const truncated = decompressAlpha(new Uint8Array([0x80 | 4]));
  assert.equal(truncated.length, ALPHA_SIZE);
  assert.equal(truncated[0], 0);

  const overlong = decompressAlpha(new Uint8Array(6000).fill(0x80 | 0x7f));
  assert.equal(overlong.length, ALPHA_SIZE);
});

test("decodeAlpha selects the format and applies the correction on request", () => {
  const raw = new Uint8Array(ALPHA_SIZE);
  raw.fill(50);
  for (let index = 0; index < 64; index++) raw[63 * 64 + index] = 99;

  const kept = decodeAlpha(raw, { bigAlpha: true });
  assert.equal(kept[63 * 64 + 5], 99);

  const fixed = decodeAlpha(raw, { bigAlpha: true, fixEdges: true });
  assert.equal(fixed[63 * 64 + 5], 50);

  const nibbles = decodeAlpha(new Uint8Array(2048).fill(0xff), {});
  assert.equal(nibbles[0], 255);

  const compressed = decodeAlpha(new Uint8Array([0x80 | 0x7f, 11]), { compressed: true });
  assert.equal(compressed[0], 11);
});

test("a map chunk's row comes from IndexY and its column from IndexX", () => {
  // Measured on Azeroth_31_49: holding IndexY fixed and walking IndexX 0 -> 15 takes the chunk's
  // own stored position from y=533.3 to y=33.3 with x unchanged, so IndexX runs east; holding
  // IndexX fixed and walking IndexY takes x from -9066.7 to -9566.7, so IndexY runs south. The
  // terrain mesh's UVs are (east, 1 - south), so south is the image row. Reading them the other
  // way round transposed every tile about its own diagonal - scored against Blizzard's minimap
  // bake of that tile, the transposed layout correlates 0.088 against this one's 0.467 - which put
  // Elwynn's dirt where its roads are not while snow-on-snow Dun Morogh looked untouched.
  const buffer = Buffer.alloc(128);
  buffer.writeUInt32LE(3, 0x04);
  buffer.writeUInt32LE(11, 0x08);
  assert.deepEqual(mapChunkGrid(buffer, 0), { column: 3, row: 11 });
});

test("MCCV is found from the chunk's data, not from its tag, and neutral where absent", () => {
  // The offset at header 0x74 counts from the MCNK payload rather than from the chunk header, so
  // the tag sits eight bytes before it. Checked against the client: read that way, `MCCV` is found
  // on 256 of Northrend_28_21's 256 chunks, and the other way on none of them.
  const header = 128;
  const payload = 580;
  const buffer = Buffer.alloc(header + 8 + payload);
  buffer.writeUInt32LE(header + 8, 0x74);
  reversedTag(buffer, header, "MCCV");
  // Stored B, G, R, A. The first vertex is a warm dim one; the alpha is 255 on every entry there
  // has ever been.
  buffer[header + 8] = 100;
  buffer[header + 9] = 110;
  buffer[header + 10] = 120;
  buffer[header + 11] = 255;

  const colours = mapChunkColours(buffer, 0, buffer.length - 8);
  assert.equal(colours?.length, payload);
  assert.deepEqual([...colours.subarray(0, 4)], [100, 110, 120, 255]);

  // A chunk that names no colours, and one whose offset points past the end of the file.
  assert.equal(mapChunkColours(Buffer.alloc(header + 8), 0, header), undefined);
  const broken = Buffer.alloc(header + 8 + payload);
  broken.writeUInt32LE(0x7fffff00, 0x74);
  assert.equal(mapChunkColours(broken, 0, broken.length - 8), undefined);
  // And one whose offset lands on some other sub-chunk.
  const mislabelled = Buffer.alloc(header + 8 + payload);
  mislabelled.writeUInt32LE(header + 8, 0x74);
  reversedTag(mislabelled, header, "MCLY");
  assert.equal(mapChunkColours(mislabelled, 0, mislabelled.length - 8), undefined);
});

test("the two ground-cover header maps are read at 0x40 and 0x50, low bit first", () => {
  // Nothing in this tree read either of them until ground cover, which is why the ground was
  // bare. `0x40` is eight uint16 — two bits per detail cell, naming which of the chunk's four
  // layers grows there — and `0x50` is eight bytes, one bit per cell, set where nothing does.
  // Both readings are measured on Azeroth_31_49: the winner map read straight agrees with the
  // layer the alpha maps make dominant on 86.8% of 16,384 cells and its transpose on 51.1%, and
  // the mask read with bit `column` puts 642 of the tile's 1,119 masked cells on the cobblestone
  // road against 5 of its 15,265 unmasked ones — reversed it is 313 against 334.
  const buffer = Buffer.alloc(128);
  for (let row = 0; row < 8; row++) {
    // Column c gets layer (row + c) % 4, which is a different word on every row.
    let word = 0;
    for (let column = 0; column < 8; column++) word |= ((row + column) % 4) << (column * 2);
    buffer.writeUInt16LE(word, 0x40 + row * 2);
    buffer.writeUInt8(row === 3 ? 0b0000_0101 : 0, 0x50 + row);
  }

  const { winner, noDoodad } = mapChunkDetail(buffer, 0);
  assert.equal(winner.length, 8);
  assert.equal(noDoodad.length, 8);
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      assert.equal((winner[row] >> (column * 2)) & 3, (row + column) % 4, `winner ${row}/${column}`);
    }
  }
  // Byte 3, bits 0 and 2: cells (3,0) and (3,2) and no others.
  assert.deepEqual(noDoodad, [0, 0, 0, 0b101, 0, 0, 0, 0]);

  // A chunk too short to hold them says so rather than reading whatever follows it in the file.
  assert.throws(() => mapChunkDetail(buffer.subarray(0, 0x50), 0), /truncated/);

  // The whole ADT may continue past a corrupt MCNK. The detail reader must still stop at this
  // MCNK's declared end rather than borrowing the next chunk's header bytes.
  const following = Buffer.alloc(0x100);
  following.set(buffer, 0);
  assert.throws(() => mapChunkDetail(following, 0, 0x50), /truncated/);
});
