import assert from "node:assert/strict";
import test from "node:test";
import {
  FACTION_MASK_ALLIANCE, FACTION_MASK_HORDE, FACTION_MASK_PLAYER, REACTION_FRIENDLY,
  REACTION_HOSTILE, REACTION_NEUTRAL, isFriendlyTo, isHostileTo, reactionBetween,
} from "../dist/code/world/FactionRules.js";
import { loadFactionData } from "../dist/code/gateway/FactionMetadata.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

const template = (overrides = {}) => ({
  faction: 0, factionGroup: 0, friendGroup: 0, enemyGroup: 0, enemies: [], friends: [], ...overrides,
});

test("an explicit enemy outranks an explicit friend, and both outrank the group masks", () => {
  // The core's own order in FactionTemplateEntry::IsHostileTo. Reversing the two loops turns every
  // guard in a contested zone friendly, so the order is the test.
  const both = template({ enemies: [67], friends: [67], friendGroup: FACTION_MASK_HORDE });
  const horde = template({ faction: 67, factionGroup: FACTION_MASK_HORDE });
  assert.equal(isHostileTo(both, horde), true);
  assert.equal(isFriendlyTo(both, horde), false);

  const friend = template({ friends: [67], enemyGroup: FACTION_MASK_HORDE });
  assert.equal(isHostileTo(friend, horde), false, "a named friend is not made an enemy by its group");
  assert.equal(isFriendlyTo(friend, horde), true);
});

test("a unit with no faction of its own is judged by the group masks alone", () => {
  const guard = template({ enemies: [67], enemyGroup: FACTION_MASK_HORDE, friendGroup: FACTION_MASK_ALLIANCE });
  // Faction 0 means the template stands alone, so the two relation lists are not consulted at all.
  const beast = template({ faction: 0, factionGroup: FACTION_MASK_HORDE });
  assert.equal(isHostileTo(guard, beast), true);
  const ally = template({ faction: 0, factionGroup: FACTION_MASK_ALLIANCE });
  assert.equal(isHostileTo(guard, ally), false);
  assert.equal(isFriendlyTo(guard, ally), true);
});

test("friendliness is read from either side's masks, hostility only from one", () => {
  const mine = template({ factionGroup: FACTION_MASK_PLAYER });
  // FriendGroup on the other side is enough: IsFriendlyTo checks both directions, IsHostileTo does
  // not, which is why a neutral pair reads neutral rather than hostile.
  const theirs = template({ friendGroup: FACTION_MASK_PLAYER });
  assert.equal(isFriendlyTo(mine, theirs), true);
  assert.equal(isHostileTo(mine, theirs), false);
});

test("a template the client has never seen is neutral rather than a guess", () => {
  const data = { templates: { 1: template({ enemyGroup: FACTION_MASK_HORDE }), 2: template({ factionGroup: FACTION_MASK_HORDE }) } };
  assert.equal(reactionBetween(data, 1, 2), REACTION_HOSTILE);
  assert.equal(reactionBetween(data, 2, 1), REACTION_NEUTRAL);
  assert.equal(reactionBetween(data, 1, 999), REACTION_NEUTRAL, "an unknown faction is not made an enemy");
  assert.equal(reactionBetween(data, 999, 1), REACTION_NEUTRAL);
});

test("friendly, hostile and neutral are the three the interface asks for", () => {
  const data = {
    templates: {
      1: template({ faction: 1, factionGroup: FACTION_MASK_ALLIANCE, friendGroup: FACTION_MASK_ALLIANCE, enemyGroup: FACTION_MASK_HORDE }),
      2: template({ faction: 2, factionGroup: FACTION_MASK_ALLIANCE }),
      3: template({ faction: 3, factionGroup: FACTION_MASK_HORDE }),
      4: template({ faction: 4 }),
    },
  };
  assert.equal(reactionBetween(data, 1, 2), REACTION_FRIENDLY);
  assert.equal(reactionBetween(data, 1, 3), REACTION_HOSTILE);
  assert.equal(reactionBetween(data, 1, 4), REACTION_NEUTRAL, "a critter is neither");
});

test("the real table loads, and says what the game says about the two capitals", withDataset, async () => {
  const data = await loadFactionData(dbcDirectory);
  const count = Object.keys(data.templates).length;
  assert.ok(count > 500, `only ${count} faction templates read`);

  // 1 is Alliance generic and 2 is Horde generic in FactionTemplate.dbc, and 7 is the player
  // template Stormwind humans are created with. If these three ever stopped disagreeing, the whole
  // reaction rule would be reading the wrong columns.
  const alliance = data.templates[1];
  const horde = data.templates[2];
  assert.ok(alliance && horde);
  assert.equal(reactionBetween(data, 1, 2), REACTION_HOSTILE);
  assert.equal(reactionBetween(data, 2, 1), REACTION_HOSTILE);
  assert.equal(reactionBetween(data, 1, 1), REACTION_FRIENDLY);

  // Every relation slot that survived the load is a real faction: a zero left in would be compared
  // against every template that has no faction of its own.
  for (const entry of Object.values(data.templates)) {
    assert.ok(entry.enemies.every((id) => id > 0));
    assert.ok(entry.friends.every((id) => id > 0));
    assert.ok(entry.enemies.length <= 4 && entry.friends.length <= 4);
  }
});

test("factions arrive with their names, keyed the way the wire numbers them", withDataset, async () => {
  // The character sheet could only say «Фракция 21», because the reputation block of a character's
  // own fields is 128 slots and the number in one is a `ReputationIndex` — not a faction id, and
  // the names live in the other table entirely. On this dataset 105 of the slots are filled.
  const data = await loadFactionData(dbcDirectory);
  const names = data.names ?? {};
  const slots = Object.keys(names).map(Number);
  assert.ok(slots.length > 90, `only ${slots.length} named reputation slots`);
  // Keyed by the slot and not by the id: a `ReputationIndex` is 0 to 127, and a faction id runs
  // into the thousands. Getting this wrong names every faction after the wrong one.
  for (const slot of slots) assert.ok(slot >= 0 && slot < 128, `slot ${slot} is not a reputation index`);

  // The locale the client is running, not the first slot of the localised string, which is enUS.
  assert.equal(names[21], "Дарнас");
  assert.equal(names[69], "Нижний Город");
  // A row whose reputation index is −1 is one a player can never have standing with, and is not
  // in this table at all — otherwise it would collide with slot 0, which is a real faction.
  assert.equal(names[0], "Пираты Кровавого Паруса");
});
