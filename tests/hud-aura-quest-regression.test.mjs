import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("unresolved auras explain their state without exposing a raw spell id", async () => {
  const auras = await source("src/browser/ui/Auras.ts");

  assert.match(auras, /function unresolvedAuraTooltip\(/,
    "the aura strip needs an explicit metadata-missing presentation");
  assert.match(auras, /metadata \? spellTooltip\(aura\.spellId\) : unresolvedAuraTooltip\(aura\)/,
    "the unresolved branch must not enter the generic spell tooltip that prints the id");
  assert.doesNotMatch(auras, /unknownLabel\(["']заклинание["'],\s*aura\.spellId\)/,
    "the visible aura label must not be Заклинание <id>");
  assert.match(auras, /dataset\["metadataState"\]\s*=\s*"unresolved"/,
    "CSS and assistive technology need an honest unresolved-state hook");
});

test("quest item rewards are inventory-like slots with metadata icons and item tooltips", async () => {
  const quest = await source("src/browser/ui/QuestLog.ts");

  assert.doesNotMatch(quest, /`\$\{reward\.itemId\}/,
    "a quest reward must not render the database id as its visible name");
  assert.match(quest, /className\s*=\s*"ui-slot quest-reward-item"/,
    "reward items use the same semantic slot surface as carried items");
  assert.match(quest, /attachTooltip\([^,]+,\s*\(\)\s*=>\s*questRewardItemTooltip\(/s,
    "hovering or focusing a reward must open its item description");
  assert.match(quest, /itemMetadata\.load\(itemIds\)/,
    "reward names and icons must be requested even when the item is not in the bags");
  assert.match(quest, /setIconSource\(/,
    "the reward icon must use the gateway-safe icon loader");
  assert.doesNotMatch(quest, /textLine\(["']Заклинание["'],\s*String\(template\.rewardDisplaySpell\)\)/,
    "a spell reward must not expose its numeric id either");
});

test("the permanent backpack button uses the original client BLP instead of emoji", async () => {
  const [bags, skin] = await Promise.all([
    source("src/browser/ui/Bags.ts"),
    source("src/browser/ui/NativeUiSkin.ts"),
  ]);

  assert.doesNotMatch(bags, /barButton\(["']🎒["']/,
    "the normal bag bar must not substitute an emoji for shipped client art");
  assert.match(skin, /BACKPACK_BUTTON_TEXTURE_PATH\s*=\s*["']Interface\\\\Buttons\\\\Button-Backpack-Up\.blp["']/,
    "the canonical archive path is owned in one place");
  assert.match(bags, /nativeUiTextureUrl\(game\.gatewayOrigin,\s*BACKPACK_BUTTON_TEXTURE_PATH\)/,
    "the bag bar must reach the original BLP through the gateway texture route");
});

test("action buttons have a dedicated full-slot client-art token", async () => {
  const [skin, css] = await Promise.all([
    source("src/browser/ui/NativeUiSkin.ts"),
    source("src/browser/style.css"),
  ]);
  assert.match(skin, /["']--wow-action-slot["']:\s*["']Interface\\\\Buttons\\\\UI-Quickslot2\.blp["']/,
    "action buttons must not reuse the padded equipment-slot background");
  assert.match(css, /body\.native-wow-ui \.ui-action-button\s*\{[^}]*var\(--wow-action-slot/s,
    "the dedicated action art must actually own each action button background");
  assert.match(css, /body\.native-wow-ui \.ui-icon-button > img\s*\{[^}]*width:\s*100%[^}]*height:\s*100%[^}]*margin:\s*0/s,
    "spell art must fill the usable slot instead of retaining an extra inset");
});

test("quest rewards and unresolved auras have readable visual states", async () => {
  const css = await source("src/browser/style.css");
  assert.match(css, /\.ui-slots\.quest-reward-slots\s*\{[^}]*--ui-slot-size:\s*44px/s,
    "quest rewards need inventory-sized icons rather than text rows");
  assert.match(css, /\.quest-reward-item\[data-metadata-state="unresolved"\][\s\S]*content:\s*"…"/,
    "metadata loading keeps an honest placeholder without exposing ids");
  assert.match(css, /\.aura-icon\[data-metadata-state="unresolved"\][\s\S]*content:\s*"\?"/,
    "an unknown aura remains visible and distinguishable while metadata loads");
});
