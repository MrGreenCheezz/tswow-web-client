/**
 * 22.10 ARC-2 S5: about how many bytes `postMessage` would put on the wire for a value — V8's ValueSerializer format
 * approximated (a tag byte per value, varint lengths and integers, 8-byte doubles, one-byte strings, raw typed-array
 * bytes). The page has no serializer to ask; the loopback bridge reports this per frame (RenderBridgeLoopback.ts).
 * Within a fifth of `v8.serialize` on frame messages (tests/frame-input-codec.test.mjs).
 */

function varintBytes(value: number): number {
  let bytes = 1;
  for (let rest = Math.floor(Math.abs(value) / 128); rest > 0; rest = Math.floor(rest / 128)) bytes++;
  return bytes;
}

function stringBytes(value: string): number {
  let wide = false;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0xff) {
      wide = true;
      break;
    }
  }
  const length = wide ? value.length * 2 : value.length;
  return 1 + varintBytes(length) + length;
}

/** The estimate; a value seen twice (a shared array) counts once, as the serializer back-references it. */
export function structuredSize(value: unknown, seen: Set<object> = new Set()): number {
  switch (typeof value) {
    case "undefined":
    case "boolean":
      return 1;
    case "number":
      return Number.isInteger(value) && Math.abs(value) < 0x40000000 ? 1 + varintBytes(value * 2) : 9;
    case "bigint": {
      let digits = 1;
      for (let rest = value < 0n ? -value : value; rest > 0xffffffffffffffffn; rest >>= 64n) digits++;
      return 2 + 8 * digits;
    }
    case "string":
      return stringBytes(value);
    case "object":
      break;
    default:
      return 1;
  }
  if (value === null) return 1;
  if (seen.has(value)) return 2;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return 6 + varintBytes(value.byteLength) + value.byteLength;
  if (value instanceof ArrayBuffer) return 1 + varintBytes(value.byteLength) + value.byteLength;
  let size = 2;
  if (value instanceof Map) {
    for (const [key, entry] of value) size += structuredSize(key, seen) + structuredSize(entry, seen);
    return size + varintBytes(value.size * 2);
  }
  if (value instanceof Set) {
    for (const entry of value) size += structuredSize(entry, seen);
    return size + varintBytes(value.size);
  }
  if (Array.isArray(value)) {
    for (const entry of value) size += structuredSize(entry, seen);
    return size + 2 * varintBytes(value.length);
  }
  let count = 0;
  for (const key in value) {
    size += stringBytes(key) + structuredSize((value as Record<string, unknown>)[key], seen);
    count++;
  }
  return size + varintBytes(count);
}
