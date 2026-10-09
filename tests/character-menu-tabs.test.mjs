import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("character owns skills and collections as accessible fixed-size tabs", async () => {
  const [html, sheet, professions, windows] = await Promise.all([
    source("index.html"),
    source("src/browser/ui/CharacterSheet.ts"),
    source("src/browser/ui/Professions.ts"),
    source("src/browser/GameWindows.ts"),
  ]);

  assert.match(html, /id="character-window"[^>]*data-window-fixed-size="true"/);
  assert.match(html, /id="character-tabs"[^>]*role="tablist"/);
  for (const tab of ["sheet", "skills", "collections"]) {
    assert.match(html, new RegExp(`id="character-tab-${tab}"[^>]*role="tab"[^>]*aria-controls="character-${tab}-pane"`));
    assert.match(html, new RegExp(`id="character-${tab}-pane"[^>]*role="tabpanel"`));
  }
  assert.match(sheet, /ArrowLeft/);
  assert.match(sheet, /ArrowRight/);
  assert.match(sheet, /Home/);
  assert.match(sheet, /End/);
  assert.match(sheet, /SKILL_LINE_MOUNTS\s*=\s*777/);
  assert.match(sheet, /SKILL_LINE_COMPANIONS\s*=\s*778/);
  assert.match(sheet, /petSpells/);
  assert.doesNotMatch(sheet, /`Заклинание \$\{spellId\}`/, "collection cards must not expose raw spell ids");
  assert.doesNotMatch(sheet, /`Питомец \$\{pet\.petNumber\}`/, "pet cards must not expose server pet numbers");
  assert.match(professions, /characterSkillsPane/);
  const skillsTab = professions.slice(professions.indexOf("export function showProfessions"), professions.indexOf("function muted"));
  assert.ok(skillsTab.length > 0);
  assert.doesNotMatch(skillsTab, /new Panel\(/, "the skills overview stays inside the character tab");
  assert.match(professions, /id: `profession-window-\$\{skillId\}`/,
    "crafting has a separate window for each learned profession");
  assert.doesNotMatch(professions, /`(?:Категория \$\{category\}|Навык \$\{skill\.skillId\})`/,
    "the player-facing skills tab must not expose internal row ids");
  assert.match(windows, /windowFixedSize[\s\S]*?style\.resize\s*=\s*"none"/);
});

test("character/spellbook routes share gated original owners and keep native fallbacks", async () => {
  const [bindings, actions, windows, mount, entry] = await Promise.all([
    source("src/browser/input/Bindings.ts"),
    source("src/browser/input/Actions.ts"),
    source("src/browser/ui/Windows.ts"),
    source("src/browser/framexml/FrameXmlWorldMount.ts"),
    source("src/browser/app/EnterWorld.ts"),
  ]);

  assert.match(bindings, /toggleCharacter:\s*\["KeyC",\s*""\]/);
  assert.match(bindings, /toggleSpellbook:\s*\["KeyP",\s*""\]/);
  assert.match(bindings, /toggleTalents:\s*\["KeyN",\s*""\]/);
  assert.match(actions, /case "toggleCharacter":\s*openCharacterWindow\("sheet"\);/);
  assert.match(actions, /case "toggleSpellbook":\s*toggleGameWindow\(spellbookWindow\);/);
  assert.match(actions, /case "toggleTalents":\s*if \(!toggleFrameXmlTalent\(\)\) toggleTalentsWindow\(\);/);
  assert.doesNotMatch(actions, /toggleFrameXml(?:Character|SpellBook)\s*\(/,
    "C/P route through the same window entry points as mouse input");

  assert.match(windows, /characterToggle\.addEventListener\("click",\s*\(\) => \{\s*openCharacterWindow\("sheet"\);\s*\}\);/);
  assert.match(windows, /spellbookToggle\.addEventListener\("click",\s*\(\) => \{\s*toggleGameWindow\(spellbookWindow\);\s*\}\);/);
  assert.match(windows, /talentsToggle\.addEventListener\("click",\s*\(\) => \{\s*if \(!toggleFrameXmlTalent\(\)\) toggleTalentsWindow\(\);\s*\}\);/);
  assert.match(windows, /window === spellbookWindow && toggleFrameXmlSpellBook\(\)/);
  assert.match(windows, /tab === "sheet" && toggleFrameXmlCharacter\(\)/);

  const mountStart = mount.indexOf("export async function mountFrameXmlVertical");
  const mountEnd = mount.indexOf("export function unmountFrameXmlVertical", mountStart);
  assert.notEqual(mountStart, -1, "production mount entry point must remain discoverable");
  assert.notEqual(mountEnd, -1, "production mount teardown must remain discoverable");
  const productionMount = mount.slice(mountStart, mountEnd);

  assert.match(productionMount, /spellBookGate\s*\(/);
  assert.match(productionMount, /createLazyFrameXmlTalentOwner\s*\(/);
  assert.match(productionMount, /frameXmlCharacterModelGate\s*\(/);
  assert.match(productionMount, /publishFrameXmlSpellBook\s*\(/);
  assert.match(productionMount, /publishFrameXmlCharacter\s*\(/);
  assert.match(productionMount, /includeActiveTsAddons:\s*options\.includeActiveTsAddons\s*\?\?\s*true/,
    "direct mounts retain generated blocks from the winning FrameXML TOC by default");
  assert.match(entry, /new FrameXmlModeController\(tswowAddonsEnabled[\s\S]*?mountFrameXmlVertical\(\{[\s\S]*?includeActiveTsAddons:\s*tswowAddonsEnabled/,
    "world entry passes the addon preference, including the stock-only FrameXML diagnostic");
  assert.match(productionMount, /resources\.talentOwner\s*=\s*patchedTalentOwner\s*\?\?\s*createLazyFrameXmlTalentOwner/);
  assert.match(productionMount, /hideTalentsWindow\(\);\s*resources\.talentOwnerCleanup\s*=\s*publishFrameXmlTalent\(resources\.talentOwner\)/,
    "patched acquisition closes native before publishing the one N owner");
  assert.match(productionMount, /if \(resources\.characterOwner\)[\s\S]*?characterWindow\.hidden\s*=\s*true/);
  assert.match(productionMount, /if \(resources\.spellbookFrame\)[\s\S]*?spellbookWindow\.hidden\s*=\s*true/);
  assert.match(productionMount, /publishFrameXmlBags\s*\(/,
    "unrelated stock FrameXML capabilities must remain mounted");
  assert.match(productionMount, /publishFrameXmlQuest\s*\(/,
    "the production-owner change must not disable the quest vertical");
});

test("HUD has one centered game-menu button and diagnostics only lives inside that menu", async () => {
  const [html, windows, actions, menu, css] = await Promise.all([
    source("index.html"),
    source("src/browser/ui/Windows.ts"),
    source("src/browser/input/Actions.ts"),
    source("src/browser/ui/GameMenu.ts"),
    source("src/browser/style.css"),
  ]);

  // L7 4.10: Escape is written as aria-keyshortcuts by ui/HudKeys.ts (fixedChord), not fixed in the markup.
  assert.match(html, /id="game-menu-toggle"[^>]*aria-haspopup="dialog"[^>]*aria-controls="game-menu"/);
  assert.doesNotMatch(html, /id="professions-toggle"/);
  assert.doesNotMatch(html, /id="diagnostics-toggle"/);
  assert.match(windows, /gameMenuToggle\.addEventListener\("click",\s*toggleGameMenu\)/);
  assert.match(actions, /openCharacterWindow\("skills"\)/);
  assert.match(menu, /menuButton\("Диагностика"/);
  assert.match(menu, /aria-expanded/);
  assert.match(menu, /button:not\(:disabled\)/);
  assert.match(css, /\.game-menu\s*\{[\s\S]*?top:\s*50%[\s\S]*?left:\s*50%[\s\S]*?resize:\s*none[\s\S]*?transform:\s*translate\(-50%,\s*-50%\)/,
    "the Escape menu opens as one stable centered game menu, not another drifting tool panel");
  assert.match(css, /\.game-menu \.ui-panel-body\s*\{[\s\S]*?overflow-y:\s*auto/,
    "all menu entries remain reachable on short viewports");
});

test("combat history is a keyboard-accessible chat tab, not a separate world overlay", async () => {
  const [html, format, combat, dock] = await Promise.all([
    source("index.html"),
    source("src/browser/ui/ChatFormat.ts"),
    source("src/browser/ui/CombatLog.ts"),
    source("src/browser/ui/ChatDock.ts"),
  ]);

  assert.doesNotMatch(html, /id="combat-log"/);
  assert.match(format, /id:\s*"combat",\s*title:\s*"Бой",\s*combat:\s*true/);
  assert.doesNotMatch(combat, /combatLog\.append/);
  assert.match(combat, /recordCombatEntry/);
  assert.match(dock, /aria-controls/);
  assert.match(dock, /chatTabs\.addEventListener\("keydown"/);
  assert.match(dock, /ArrowLeft/);
  assert.match(dock, /ArrowRight/);
});

test("interface scale is persisted and published for HUD geometry", async () => {
  const [model, settings, css, windows] = await Promise.all([
    source("src/browser/ui/SettingsModel.ts"),
    source("src/browser/ui/Settings.ts"),
    source("src/browser/style.css"),
    source("src/browser/GameWindows.ts"),
  ]);

  assert.match(model, /id:\s*"uiScale"[\s\S]*?fallback:\s*100[\s\S]*?min:\s*75,\s*max:\s*125,\s*step:\s*5/);
  assert.match(settings, /setProperty\(\s*"--ui-scale"/);
  assert.match(settings, /dataset\["uiScale"\]/);
  assert.match(css, /--ui-scale-effective:\s*var\(--ui-scale\)/,
    "the published value needs one shared effective scale token");
  assert.match(css, /#bottom-hud[\s\S]*?scale:\s*var\(--ui-scale-effective\)/,
    "HUD controls must consume the setting instead of merely storing it");
  assert.match(css, /\.game-window[\s\S]*?scale:\s*var\(--ui-scale-effective\)/,
    "movable windows must consume the same setting");
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*--ui-scale-effective:\s*min\(var\(--ui-scale\),\s*1\)/,
    "phone layouts may shrink but must not be enlarged beyond the viewport");
  assert.match(windows, /available\s*\/\s*this\.#uiScale\(\)/,
    "window max-height must be expressed in pre-scale CSS pixels so its painted bounds still fit");
});
