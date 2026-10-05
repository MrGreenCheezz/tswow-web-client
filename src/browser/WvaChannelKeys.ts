// 6.16г (05.10-A7a-F2): bone channels the file marks as stepped (interpolation 0) hold their value
// until the next key instead of sliding towards it.
//
// The artifact has carried each channel's interpolation byte since the first WVM (tools/wvm.mjs
// writes it at channel offset 3) and the decoder skipped it. The 05.10 census counted 7,643 stepped
// bone channels (no Hermite or Bézier at all), but nearly all are global-sequence tracks, which
// keyWindow already played as steps, or one-key channels; the F2 review found only 5 multi-key
// stepped clip tracks (humlcitizenmid.m2), so the visible effect is small. Here a stepped channel is
// decoded into keys that a *linear* track plays as a step: after each key, one more key with the
// same value just before the next key's time. The tracks stay linear, so `PoseEngine`'s fast path
// (which takes linear tracks only) keeps taking them, and nothing downstream needs to know.
//
// Needs no new artifact: the byte is in every WVM and WVA ever published, which is why this works
// against a gateway that has not been restarted.

/** `M2Track.interpolation` 0: no interpolation, the value holds. */
export const STEP_INTERPOLATION = 0;
/** Seconds before the next key at which the held value ends: 0.1 ms, far under a frame. */
export const STEP_EPSILON = 1e-4;

/** How many keys a channel decodes into. */
export function steppedKeyCount(interpolation: number, keys: number): number {
  return interpolation === STEP_INTERPOLATION && keys > 1 ? keys * 2 - 1 : keys;
}

/**
 * Reads one channel's keys as the clip encoding stores them — `keys` u32 times in milliseconds,
 * then the values (four int16 `M2CompQuat` components for a rotation, three floats otherwise) —
 * into `times` (seconds) and `values`, expanded by `steppedKeyCount`.
 */
export function readChannelKeys(
  view: DataView, at: number, keys: number, kind: number, interpolation: number,
  times: Float32Array, values: Float32Array,
): void {
  const rotation = kind === 1;
  const components = rotation ? 4 : 3;
  const valuesAt = at + keys * 4;
  const stepped = steppedKeyCount(interpolation, keys) !== keys;
  let out = 0;
  for (let key = 0; key < keys; key++) {
    const time = view.getUint32(at + key * 4, true) / 1000;
    if (stepped && key > 0) {
      // The held copy of the previous key, just before this one.
      const previous = times[out - 1]!;
      times[out] = Math.max(previous, time - Math.min(STEP_EPSILON, (time - previous) * 0.5));
      for (let part = 0; part < components; part++) {
        values[out * components + part] = values[(out - 1) * components + part]!;
      }
      out++;
    }
    times[out] = time;
    for (let part = 0; part < components; part++) {
      if (rotation) {
        // M2CompQuat: int16 per component, x y z w, mapped back onto [-1, 1].
        const raw = view.getInt16(valuesAt + (key * 4 + part) * 2, true);
        values[out * 4 + part] = (raw < 0 ? raw + 32768 : raw - 32767) / 32767;
      } else {
        values[out * 3 + part] = view.getFloat32(valuesAt + (key * 3 + part) * 4, true);
      }
    }
    out++;
  }
}
