// 13.10 (7.11): the second texture coordinates and the blend factor a Composite (MOMT shader 6)
// material reads — published only under `visual-wmo-v26`, only for the groups that draw one.
//
// The client's programs (its shader archives; `.runtime/re-2026-10-13/7.11/`): the vertex program
// `MapObjUDiffuse_Comp` (the only Composite one; `mapobjdiffuse_comp.bls` is empty in every profile)
// passes `result.color.secondary = vertex.attrib[5]` and `result.texcoord[1] = vertex.attrib[7]`;
// the pixel program `MapObjComposite` (ps_3_0 #0) is
//   r2 = lrp(color1.w, tex0(texcoord0), tex1(texcoord1)); oC0.rgb = r2.rgb · color0 · 2; oC0.a = r2.a · color0.a
// so a Composite surface needs the group's second MOTV (attrib 7) and the alpha of its second MOCV
// (attrib 5) — the colour bytes of that MOCV are never read. Over the client's 1,985 roots shader 6
// is 52 records in 11 Icecrown roots (Icecrown Citadel and its exterior, the Frozen Halls); all 31
// groups that draw one carry MOGP 0x1000000 | 0x2000000 with exactly two MOTV and two MOCV of one
// entry per vertex (`composite.out.txt`); the second MOCV's alpha spans 0–255 in 29 of them.

export const WMO_SHADER_COMPOSITE = 6;

/** MOMT records (64 bytes each) whose shader is Composite. */
export function wmoCompositeRecords(momt) {
  const records = new Set();
  if (!momt || momt.length % 64 !== 0) return records;
  for (let offset = 0; offset < momt.length; offset += 64) {
    if (momt.readUInt32LE(offset + 4) === WMO_SHADER_COMPOSITE) records.add(offset / 64);
  }
  return records;
}

/** The data of the `occurrence`-th (0-based) sub-chunk `tag` of a MOGP body, or undefined. */
function nthChunk(data, tag, occurrence) {
  let seen = 0;
  for (let offset = 0; offset + 8 <= data.length;) {
    const name = String.fromCharCode(data[offset + 3], data[offset + 2], data[offset + 1], data[offset]);
    const size = data.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > data.length) return undefined;
    if (name === tag && seen++ === occurrence) return data.subarray(offset + 8, end);
    offset = end;
  }
  return undefined;
}

/**
 * A group's Composite streams — `uvs` (float2 per vertex, the second MOTV) and `blend` (u8 per
 * vertex, the second MOCV's alpha) — or undefined when no batch of it draws a Composite record or
 * either stream is missing or the wrong length (the run is then drawn as Diffuse, as before).
 */
export function wmoCompositeStreams(mogpBody, vertexCount, batches, compositeRecords) {
  if (!compositeRecords || compositeRecords.size === 0 || !batches) return undefined;
  let draws = false;
  for (let offset = 0; offset + 24 <= batches.length; offset += 24) {
    if (compositeRecords.has(batches[offset + 23])) { draws = true; break; }
  }
  if (!draws) return undefined;
  const uvData = nthChunk(mogpBody, "MOTV", 1);
  const colourData = nthChunk(mogpBody, "MOCV", 1);
  if (!uvData || !colourData || uvData.length !== vertexCount * 8 || colourData.length !== vertexCount * 4) return undefined;
  const uvs = new Float32Array(vertexCount * 2);
  for (let index = 0; index < uvs.length; index++) {
    const value = uvData.readFloatLE(index * 4);
    if (!Number.isFinite(value)) return undefined;
    uvs[index] = value;
  }
  const blend = new Uint8Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex++) blend[vertex] = colourData[vertex * 4 + 3];
  return { uvs, blend };
}
