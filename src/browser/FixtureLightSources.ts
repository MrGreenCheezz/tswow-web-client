/**
 * 06.10-render-fix: which environment placements may be a fixture point light (`LocalLighting.ts`).
 *
 * A building's own doodads never are. Their room light is baked — MODD colour on the indoor path,
 * MOCV on the walls — and an unshadowed point from a lamp on a façade would shine through the wall
 * onto the furniture behind it. Until 05.10 every WMO doodad was `interior: true`, which is the test
 * this pass used. The `visual-tile-v5` tile (05.10-A7b-1, 7.03 slice 1) marks a doodad only outdoor
 * groups own `interior: false`, so 57–94 Stormwind street lamps and lanterns per tile joined the
 * nearest-to-camera selection of four (eight cinematic) lights, whose membership reshuffles as the
 * camera moves: the light pools on nearby furniture, crates and benches switched on and off (owner,
 * 06.10: «мебель любит менять цвет»). A building's doodad is told by its id, which the tile
 * generator gives as -(placement · 1e6 + ordinal + 1); terrain placements carry their unsigned
 * uniqueId and keep lighting as before.
 */
export function fixtureLightSource<T extends {
  readonly id: number;
  readonly interior?: boolean | undefined;
  readonly localLight?: unknown;
}>(object: T, buildingLamps = false, openAir?: boolean | ((object: T) => boolean)): boolean {
  // 22.10 (7.36): `buildingLamps` (the cinematic profile) admits a building's outdoor doodads too.
  // The switching that excluded them is gone: `LocalLightSelection` fades a light out before the
  // nearest-N set drops it. Room-lit doodads (`localLight`) and interior ones stay out.
  if (object.localLight !== undefined) return false;
  // 23.10 (7.46): except, on that profile, a building's doodad that only open-air groups name
  // (`wmoDoodadOpenAir`, WmoOpenAirLamps.ts): a street lamp of a city whose streets are flagged indoor.
  // 23.10 (7.46 review): the answer itself, or a test to ask (the far glows ask while rebuilding).
  if (object.interior === true) {
    return buildingLamps && object.id < 0 && (typeof openAir === "function" ? openAir(object) : openAir === true);
  }
  return buildingLamps || object.id >= 0;
}
