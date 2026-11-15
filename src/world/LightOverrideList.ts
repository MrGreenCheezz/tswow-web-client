// SMSG_OVERRIDE_LIGHT as Wow.exe 3.3.5a (12340) keeps it: a list of scripted lights, each fading in or out over the
// packet's own duration. Read from Wow.exe (`.runtime/lane-2026-11-15/sky8-report.md`); our own words, nothing copied.
//
//   * The handler (opcode 0x412 in the world packet switch) reads area light, override light and milliseconds. It always
//     starts fading out the first entry for that area light (0x007f11a0), then, when the override light is not 0, appends
//     a new entry at weight 0 fading in (0x007f10a0). TrinityCore sends area = the map's default Light row (Icecrown
//     Citadel 2488, the Eye of Eternity 1773) through `Map::SetZoneOverrideLight`.
//   * Every frame the light build (0x007f1360) moves each entry's weight by elapsed / duration — up to 1 while it fades
//     in, down to 0 while it fades out — and drops an entry that has faded out. A duration of 0 is a jump.
//   * The list (`AreaLightOverride`, 0x00d3901c) is emptied when the world is torn down (0x007f1d30).
//
// What the weight lights is decided in `LightClient.ts` (`resolveLighting`): after the zone outlines and the volumes,
// each entry lays its override light over the frame at the area light's place and falloff.

/** One scripted light as the frame reads it. */
export interface LightOverride {
  /** The Light.dbc row whose place and falloff the override takes. */
  readonly areaLightId: number;
  /** The Light.dbc row whose sets are laid over the frame. */
  readonly overrideLightId: number;
  /** 0..1, how far the fade has come. */
  readonly weight: number;
}

interface Entry {
  areaLightId: number;
  overrideLightId: number;
  weight: number;
  /** 1 fading in, 2 fading out (the entry's word at +0xc). */
  state: 1 | 2;
  /** The clock of the last step, milliseconds. */
  stepped: number;
  duration: number;
}

/** The client's list of scripted lights (0x00d3901c). */
export class LightOverrideList {
  readonly #entries: Entry[] = [];

  /** The packet: `i32 area light, i32 override light, i32 milliseconds` (0x412 → 0x007f11a0, 0x007f10a0). */
  receive(areaLightId: number, overrideLightId: number, milliseconds: number, now: number): void {
    const duration = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
    // 0x007f11a0: only the first entry naming the area light, whatever its state; its weight is kept.
    const fading = this.#entries.find((entry) => entry.areaLightId === areaLightId);
    if (fading) {
      fading.state = 2;
      fading.stepped = now;
      fading.duration = duration;
    }
    // 0x007f10a0 also needs both rows in Light.dbc; `resolveLighting` skips an entry whose rows the map lacks.
    if (overrideLightId === 0 || areaLightId === 0) return;
    this.#entries.push({ areaLightId, overrideLightId, weight: 0, state: 1, stepped: now, duration });
  }

  /** One frame of 0x007f1360's tail: every weight moves, faded-out entries leave. Returns the live entries in order. */
  advance(now: number): readonly LightOverride[] {
    for (let index = 0; index < this.#entries.length; index++) {
      const entry = this.#entries[index]!;
      const elapsed = Math.max(0, now - entry.stepped);
      entry.stepped = now;
      // A zero duration divides to infinity (or 0/0): the weight lands on its end at once, as in Wow.exe.
      const step = entry.duration > 0 ? elapsed / entry.duration : Number.POSITIVE_INFINITY;
      entry.weight = entry.state === 1 ? Math.min(1, entry.weight + step) : Math.max(0, entry.weight - step);
      if (entry.state === 2 && entry.weight === 0) {
        // 0x007f1360 moves the list's last entry into the hole; the order of the rest is the list's.
        const last = this.#entries.pop()!;
        if (index < this.#entries.length) this.#entries[index] = last;
        index--;
      }
    }
    return this.#entries;
  }

  /** The world is gone (0x007f1d30), or the map changed under a server that sends no clear. */
  clear(): void {
    this.#entries.length = 0;
  }

  get size(): number {
    return this.#entries.length;
  }
}
