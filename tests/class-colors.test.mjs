import assert from "node:assert/strict";
import test from "node:test";

// 9.05: a class's colour comes from the dataset's own RAID_CLASS_COLORS (Constants.lua, generated
// into the ignored client-data/classIcons.ts), so HERO (class 13) draws #d9a340 as every Lua frame
// does instead of a derived hue; the stock ten keep exactly the compiled table's colours.

const { CLASS_COLOR_DATA, CLASS_ICON_DATA_AVAILABLE, CLASS_SORT_ORDER_DATA } = await import("../dist/code/generated/classIcons.js");
const {
  CLASS_COLORS, CLASS_FILE_NAMES, classColor, forgetCreationNames, generatedClassColor, learnCreationNames,
} = await import("../dist/code/browser/ui/UnitSnapshot.js");
const { parseClassColors } = await import("../tools/generate-class-icons.mjs");

const skip = CLASS_ICON_DATA_AVAILABLE ? false : "no local client data (npm run classicons:generate)";

test("the generator reads RAID_CLASS_COLORS in tswow's spacing and CLASS_SORT_ORDER", () => {
  const { colors, order } = parseClassColors(`
RAID_CLASS_COLORS = {
	["ARCHAEOLOGIST"] = { r = 0.67, g = 0.83, b = 0.45 },
	["HERO"] = { r = 0.85 , g = 0.64 , b = 0.25 },
	["WARRIOR"] = { r = 0.78, g = 0.61, b = 0.43 },
	["DEATHKNIGHT"] = { r = 0.77, g = 0.12 , b = 0.23 },
};
CLASS_SORT_ORDER = {
	"HERO",
	"WARRIOR",
};
MAX_CLASSES = #CLASS_SORT_ORDER;`);
  assert.deepEqual(Object.fromEntries(colors), {
    ARCHAEOLOGIST: "#abd473", HERO: "#d9a340", WARRIOR: "#c79c6e", DEATHKNIGHT: "#c41f3b",
  });
  assert.deepEqual(order, ["HERO", "WARRIOR"]);
  assert.deepEqual(parseClassColors("nothing here"), { colors: new Map(), order: [] });
});

test("the dataset colours reproduce the compiled table for the stock ten", { skip }, () => {
  for (const [id, token] of Object.entries(CLASS_FILE_NAMES)) {
    assert.equal(CLASS_COLOR_DATA[token], CLASS_COLORS[id], token);
  }
  // 13.08 (owner 08.10: the base dataset is the reference): the stock ten are always in the order;
  // a custom-class module adds its own after them (12 with the old HERO/ARCHAEOLOGIST install).
  const stock = Object.values(CLASS_FILE_NAMES);
  for (const token of stock) assert.ok(CLASS_SORT_ORDER_DATA.includes(token), `${token} in CLASS_SORT_ORDER`);
  assert.ok(CLASS_SORT_ORDER_DATA.length >= stock.length, "this dataset's MAX_CLASSES");
});

// HERO (class 13) is a custom-class module's; the base dataset has none.
const heroSkip = skip || (CLASS_COLOR_DATA.HERO === undefined
  ? "no HERO class in this dataset (custom-class module not installed)" : false);

test("classColor of a learned HERO is the dataset's #d9a340, not a derived hue", { skip: heroSkip }, () => {
  forgetCreationNames();
  try {
    assert.equal(classColor(13), generatedClassColor(13), "unlearned: no token, the derived hue");
    learnCreationNames([], [{ id: 13, name: "Герой", fileName: "HERO" }]);
    assert.equal(classColor(13), "#d9a340");
    assert.equal(classColor(11), "#ff7d0a", "a stock class still answers");
    assert.equal(classColor(0), undefined);
  } finally {
    forgetCreationNames();
  }
});
