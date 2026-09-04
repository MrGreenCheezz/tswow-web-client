import assert from "node:assert/strict";
import test from "node:test";

const {
  FRAMEXML_FACTION_FLAGS,
  resolveFrameXmlReputationRows,
} = await import("../dist/code/browser/framexml/FrameXmlReputationResolver.js");

test("live reputation resolver exposes only named visible server factions and maps flags", () => {
  const f = FRAMEXML_FACTION_FLAGS;
  const world = {
    factions: new Map([
      [0, { listId: 0, flags: f.visible | f.atWar | f.inactive, standing: 4_500 }],
      [1, { listId: 1, flags: f.visible | f.peaceForced | f.atWar, standing: 100 }],
      [2, { listId: 2, flags: f.visible | f.peaceForced | f.rival, standing: -5_000 }],
      [3, { listId: 3, flags: f.visible | f.hidden, standing: 0 }],
      [4, { listId: 4, flags: f.visible | f.invisibleForced, standing: 0 }],
      [5, { listId: 5, flags: f.atWar, standing: 0 }],
      [6, { listId: 6, flags: f.visible, standing: 0 }],
    ]),
  };
  const metadata = {
    ready: true,
    name: (listId) => ({ 0: "Stormwind", 1: "Darnassus", 2: "Scryers" }[listId]),
  };

  assert.deepEqual(resolveFrameXmlReputationRows(world, metadata), [
    {
      listId: 0,
      name: "Stormwind",
      description: "",
      standingId: 5,
      barMin: 3_000,
      barMax: 9_000,
      barValue: 4_500,
      canToggleAtWar: true,
      isHeader: false,
      isChild: false,
      hasRep: true,
      atWarWith: true,
      isInactive: true,
    },
    {
      listId: 1,
      name: "Darnassus",
      description: "",
      standingId: 4,
      barMin: 0,
      barMax: 3_000,
      barValue: 100,
      canToggleAtWar: false,
      isHeader: false,
      isChild: false,
      hasRep: true,
      atWarWith: true,
      isInactive: false,
    },
    {
      listId: 2,
      name: "Scryers",
      description: "",
      standingId: 2,
      barMin: -6_000,
      barMax: -3_000,
      barValue: -5_000,
      canToggleAtWar: true,
      isHeader: false,
      isChild: false,
      hasRep: true,
      atWarWith: false,
      isInactive: false,
    },
  ]);
  assert.deepEqual(resolveFrameXmlReputationRows(world, { ...metadata, ready: false }), []);
});
