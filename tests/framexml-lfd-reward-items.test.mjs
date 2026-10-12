import assert from "node:assert/strict";
import test from "node:test";

// 3.55: the random dungeon's reward items. Wow.exe's GetLFGDungeonRewardInfo (0x00557be0) takes the
// picture from the reward's own display id (ItemDisplayInfo's icon, 0x0070a910) and the name from
// the item cache — empty until the item is there — and asks the cache with a callback (0x00552950)
// that raises LFG_UPDATE_RANDOM_INFO (event 0x202) when it arrives. The model took both from the
// cache, so an item the cache had not seen yet came out as an empty slot with no name.
const { FrameXmlLfdModel, FRAMEXML_LFD_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlLfd.js");
const {
  FRAMEXML_CANNED_LFD_CATALOG, FRAMEXML_CANNED_LFD_PLAYER_GUID, FrameXmlCannedLfdWorld,
} = await import("../dist/code/browser/framexml/FrameXmlLfdCanned.js");

const RANDOM = 6 << 24;

test("a reward item shows its display picture at once and its name once the cache has it", () => {
  const world = new FrameXmlCannedLfdWorld();
  world.lfgPlayerInfo = {
    dungeons: [{ entry: 259 | RANDOM, reward: { done: false, money: 1234, experience: 5000,
      items: [{ itemId: 49426, displayId: 64062, count: 2 }] } }],
    locks: [],
  };
  const cache = new Map();
  const prefetched = [];
  let arrived;
  const model = new FrameXmlLfdModel({
    world: () => world, catalog: () => FRAMEXML_CANNED_LFD_CATALOG, playerLevel: () => 60, playerClassId: () => 4,
    playerName: () => "Игрок", playerGuid: () => FRAMEXML_CANNED_LFD_PLAYER_GUID, playerFaction: () => "Alliance",
    partyMemberCount: () => 0, raidMemberCount: () => 0, isPartyLeader: () => false, inDungeonInstance: () => false,
    item: (entry) => cache.get(entry),
    displayIcon: (displayId) => `icon:${displayId}`,
    prefetchItems: (ids, onChanged) => { prefetched.push([...ids]); arrived = onChanged; },
  });
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; }, now: () => 0 });
  const call = (name, ...args) => FRAMEXML_LFD_BINDINGS[name]({ lfd: model }, args);

  world.emit({ kind: "playerInfo" });
  assert.deepEqual(prefetched, [[49426]], "the player-info edge asks the cache for the reward item");
  assert.deepEqual(call("GetLFGDungeonRewards", 259), [false, 1234, 0, 5000, 0, 1]);
  assert.deepEqual(call("GetLFGDungeonRewardInfo", 259, 1), ["", "icon:64062", 2],
    "the display id's picture, an empty name while the cache is cold");

  fired.length = 0;
  cache.set(49426, { name: "Эмблема льда", texture: "cached-icon", quality: 4 });
  arrived();
  assert.deepEqual(fired.map(([event]) => event), ["LFG_UPDATE_RANDOM_INFO"], "the item's arrival repaints the reward");
  assert.deepEqual(call("GetLFGDungeonRewardInfo", 259, 1), ["Эмблема льда", "icon:64062", 2]);

  prefetched.length = 0;
  world.emit({ kind: "playerInfo" });
  assert.deepEqual(prefetched, [], "a cached item is not asked for again");
});
