/**
 * A 64-bit GUID out of its two 32-bit words, with one allocation (the bigint itself).
 *
 * The old `(BigInt(high) << 32n) | BigInt(low)` made four bigints per GUID and the packed reader
 * up to 32; GUIDs are read for every update block, movement relay and spell log. Through one shared
 * DataView this is ≈25 ns against ≈65–85 ns for the shift or the multiply on a creature GUID
 * (`.runtime/perf-step22/net-guid-words.mjs`, Node 22). The scratch is safe to share: nothing
 * between the writes and the read can yield.
 *
 * Both words are taken as u32 (`setUint32` wraps), which is all the wire can carry.
 */
const scratch = new DataView(new ArrayBuffer(8));

export function guidFromWords(low: number, high: number): bigint {
  scratch.setUint32(0, low, true);
  scratch.setUint32(4, high, true);
  return scratch.getBigUint64(0, true);
}

/**
 * The eight little-endian bytes of a u64 into `target`, without a bigint per byte.
 * The caller has range-checked `value`.
 */
export function guidBytes(value: bigint, target: Uint8Array): void {
  scratch.setBigUint64(0, value, true);
  for (let index = 0; index < 8; index++) target[index] = scratch.getUint8(index);
}
