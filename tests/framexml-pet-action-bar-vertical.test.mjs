import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock PetActionBarFrame (PetActionBarFrame.xml/.lua in the vertical) over the
// canned wolf (FrameXmlPetActionBarCanned.ts): the bar slides up when the stand-in realm sends it,
// draws the core's default layout (tokens through _G, spells with their icons, the empty slot
// hidden), and its clicks, right clicks, pickups, tooltip and the /pet slash commands reach the
// stand-in realm through the seam's C API — with 0 new Lua errors throughout.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CANNED_PET_ACTION_BAR } = await import("../dist/code/browser/framexml/FrameXmlPetActionBarCanned.js");
const decoder = new TextDecoder("utf-8");

async function load() {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
    // The pet bar's spell slot asks for the spell's own tooltip; this stand-in names it by id.
    gameTooltipAdapter: {
      inventoryItem: () => undefined,
      containerItem: () => undefined,
      petActionSpell: (index) => seam.petActions.spellAt(index),
      spell: (id) => ({ title: `spell:${id}` }),
    },
  });
  await boot.load();
  return { boot, seam };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "pet-action-bar-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

const newErrors = (boot, from) => boot.errors.slice(from).map((e) => `${e.file}:${e.line} ${e.message}`);
const shown = (boot, name) => lua(boot, `return ${name}:IsShown() and 1 or 0`)[0] === 1;
/** Frames of OnUpdate: PETACTIONBAR_SLIDETIME is 0.09 s, so ten 20 ms frames finish a slide. */
const frames = (boot, count = 10) => { for (let index = 0; index < count; index += 1) boot.bridge.tick(0.02); };
/** The cursor fires its grid and CURSOR_UPDATE edges from a microtask, as the client's next frame. */
const flush = async () => { for (let index = 0; index < 3; index += 1) await Promise.resolve(); };

/** Per button: shown, icon path, checked, autocastable overlay shown. */
function buttons(boot) {
  // One string: forty return values would overflow the VM's C stack (LUA_MINSTACK is 20).
  const [joined] = lua(boot, `
    local out = {}
    for i = 1, NUM_PET_ACTION_SLOTS do
      local button = _G["PetActionButton"..i]
      out[#out + 1] = table.concat({
        button:IsShown() and 1 or 0,
        _G["PetActionButton"..i.."Icon"]:GetTexture() or "",
        button:GetChecked() and 1 or 0,
        _G["PetActionButton"..i.."AutoCastable"]:IsShown() and 1 or 0,
      }, "|")
    end
    return table.concat(out, ";")`);
  return String(joined).split(";").map((row) => {
    const [shown, icon, checked, autocast] = row.split("|");
    return { shown: Number(shown), icon: icon.toLowerCase(), checked: Number(checked), autocast: Number(autocast) };
  });
}

test("the stock bar comes up with the pet and draws the core's default layout", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const errors = boot.errorCount;
    assert.deepEqual(lua(boot, "return PetHasActionBar()"), [false]);
    assert.equal(shown(boot, "PetActionBarFrame"), false, "no bar until the realm sends one");
    seam.petActionWorld.summon();
    frames(boot);
    assert.equal(shown(boot, "PetActionBarFrame"), true, "PET_BAR_UPDATE + UnitIsVisible('pet'): ShowPetActionBar");
    assert.deepEqual(lua(boot, "return PetActionBarFrame.state, PetActionBarFrame.locked", 2), ["top", 1],
      "the slide finished at the top, and the bar is locked in place");
    const rows = buttons(boot);
    assert.deepEqual(rows.map((row) => row.icon), [
      "interface\\icons\\ability_ghoulfrenzy", "interface\\icons\\ability_tracking", "interface\\icons\\spell_nature_timestop",
      "interface\\icons\\ability_druid_ferociousbite", "interface\\icons\\ability_physical_taunt", "interface\\icons\\ability_hunter_pet_wolf",
      "",
      "interface\\icons\\ability_racial_bloodrage", "interface\\icons\\ability_defend", "interface\\icons\\ability_seal",
    ], "the PET_*_TEXTURE constants for the tokens, the spells' own icons, nothing in the empty slot");
    assert.deepEqual(rows.map((row) => row.shown), [1, 1, 1, 1, 1, 1, 0, 1, 1, 1], "the empty slot hides outside the grid");
    assert.deepEqual(rows.map((row) => row.checked), [0, 1, 0, 0, 0, 0, 0, 0, 1, 0], "follow and defensive are in force");
    assert.deepEqual(rows.map((row) => row.autocast), [0, 0, 0, 1, 1, 1, 0, 0, 0, 0], "the three spells can autocast");
    assert.deepEqual(lua(boot, "return PetActionButton2.tooltipName, PetActionButton4.tooltipName, PetActionButton4.tooltipSubtext", 3),
      ["Следовать", "Укус", "Уровень 1"], "a token's name is its GlobalStrings word");
    assert.deepEqual(newErrors(boot, errors), []);
  } finally {
    boot.close();
  }
});

test("clicks, right clicks, pickups and the slash commands reach the stand-in realm", withClient, async () => {
  const { boot, seam } = await load();
  try {
    seam.petActionWorld.summon();
    frames(boot);
    const errors = boot.errorCount;
    const sent = () => seam.petActionWorld.sent;

    lua(boot, "PetActionButton3:Click('LeftButton')", 0);
    assert.deepEqual(sent().at(-1), ["action", 3, CANNED_PET_ACTION_BAR[2], undefined], "CastPetAction(3): the stay word");
    assert.deepEqual(buttons(boot).slice(0, 3).map((row) => row.checked), [0, 0, 1], "stay is checked, follow no longer");

    lua(boot, "PetActionButton1:Click('LeftButton')", 0);
    assert.deepEqual(lua(boot, "return PetActionButton1.flashing and 1 or 0, PetActionButton1:GetChecked() and 1 or 0", 2), [1, 1],
      "attack: the pet swings, the button flashes (PetActionButton_StartFlash)");

    lua(boot, "PetActionButton6:Click('RightButton')", 0);
    assert.deepEqual(sent().at(-1), ["autocast", 24604, true], "TogglePetAutocast(6): the howl's autocast on");
    // AUTOCAST_SHINES is local to UIParent.lua; AutoCastShine_AutoCastStart shows the shine's sparkles.
    assert.deepEqual(lua(boot, `return PetActionButton6Shine.sparkles[1]:IsShown() and 1 or 0,
      PetActionButton3Shine.sparkles[1]:IsShown() and 1 or 0`, 2), [1, 0],
    "AutoCastShine_AutoCastStart for the howl's shine; a command's never sparkles");
    lua(boot, "PetActionButton2:Click('RightButton')", 0);
    assert.deepEqual(sent().at(-1), ["autocast", 24604, true], "a command has no autocast to toggle");

    lua(boot, "PetActionButton5:Click('LeftButton')", 0);
    assert.deepEqual(sent().at(-1), ["action", 5, CANNED_PET_ACTION_BAR[4], undefined]);
    assert.equal(shown(boot, "PetActionButton5Cooldown"), true, "growl's 5 s category cooldown sweeps");
    assert.equal(shown(boot, "PetActionButton4Cooldown"), false);

    // A pickup raises the pet grid (the empty slot shows as a drop target); a drop swaps the two.
    lua(boot, "PickupPetAction(4)", 0);
    await flush();
    assert.deepEqual(lua(boot, "return PetActionBarFrame.showgrid, PetActionButton7:IsShown() and 1 or 0", 2), [1, 1]);
    lua(boot, "PickupPetAction(7)", 0);
    await flush();
    assert.deepEqual(sent().at(-1), ["swap", 4, 7]);
    assert.deepEqual(lua(boot, "return PetActionBarFrame.showgrid, PetActionButton4:IsShown() and 1 or 0, PetActionButton7Icon:GetTexture()", 3),
      [0, 0, "Interface\\Icons\\Ability_Druid_FerociousBite"], "grid down; bite now in slot 7, slot 4 empty and hidden");

    // The slash handlers' own calls (ChatFrame.lua:1337-1374); SecureCmdOptionParse, which gates
    // them, is the world mount's chat API (FrameXmlChatApi.ts) and not installed on this boot.
    lua(boot, "PetPassiveMode()", 0);
    assert.deepEqual(sent().at(-1), ["command", "passive", undefined], "/petpassive: PetPassiveMode()");
    assert.deepEqual(buttons(boot).slice(7).map((row) => row.checked), [0, 0, 1], "passive is in force");
    lua(boot, 'PetAttack("")', 0);
    assert.deepEqual(sent().at(-1), ["command", "attack", undefined], "/petattack with no target: the current one");
    assert.deepEqual(lua(boot, "return PetCanBeDismissed() and 1 or 0"), [0], "a hunter's pet is abandoned, not dismissed");

    assert.deepEqual(newErrors(boot, errors), []);
  } finally {
    boot.close();
  }
});

test("a spell slot's tooltip is the spell's; a token keeps its name line; the bar slides away with the pet", withClient, async () => {
  const { boot, seam } = await load();
  try {
    seam.petActionWorld.summon();
    frames(boot);
    const errors = boot.errorCount;
    lua(boot, 'SetCVar("UberTooltips", "1") PetActionButton_OnEnter(PetActionButton4)', 0);
    assert.deepEqual(lua(boot, "return GameTooltip:IsShown() and 1 or 0, GameTooltipTextLeft1:GetText()", 2), [1, "spell:17253"],
      "GameTooltip:SetPetAction(4) draws spell 17253 through the adapter");
    lua(boot, "PetActionButton_OnLeave(PetActionButton4) PetActionButton_OnEnter(PetActionButton2)", 0);
    const follow = lua(boot, "return GameTooltipTextLeft1:GetText()")[0];
    assert.ok(typeof follow === "string" && follow.startsWith("Следовать"), `the token's own line: ${follow}`);
    lua(boot, "PetActionButton_OnLeave(PetActionButton2)", 0);

    seam.petActionWorld.dismiss();
    frames(boot);
    assert.equal(shown(boot, "PetActionBarFrame"), false, "PetHasActionBar false: HidePetActionBar slides it down and hides it");
    assert.deepEqual(lua(boot, "return PetActionBarFrame.state"), ["bottom"]);
    assert.deepEqual(newErrors(boot, errors), []);
  } finally {
    boot.close();
  }
});

test("the pet's spellbook tab: its rows, casts, autocast, a passive, a cooldown and a drop on the bar", withClient, async () => {
  const { boot, seam } = await load();
  try {
    seam.petActionWorld.summon();
    frames(boot);
    const errors = boot.errorCount;
    const sent = () => seam.petActionWorld.sent;
    assert.deepEqual(lua(boot, "return HasPetSpells()", 2), [4, "PET"]);
    lua(boot, "ToggleSpellBook(BOOKTYPE_PET)", 0);
    assert.equal(shown(boot, "SpellBookFrame"), true, "ToggleSpellBook opens the pet book once HasPetSpells answers");
    assert.deepEqual(lua(boot, `return SpellBookFrame.bookType, SpellBookTitleText:GetText(),
      SpellBookFrameTabButton2:GetText(), SpellBookFrameTabButton2:IsShown() and 1 or 0`, 4),
    ["pet", "Питомец", "Питомец", 1], "the tab and the title are PET_TYPE_PET");
    // SpellButton1/3/5/7/9 carry the book's slots 1..5 (SpellBookFrame.xml's column-major ids).
    const rows = () => String(lua(boot, `
      local out = {}
      for _, n in ipairs({ 1, 3, 5, 7, 9 }) do
        local b = "SpellButton" .. n
        out[#out + 1] = tostring(_G[b .. "SpellName"]:IsShown() and _G[b .. "SpellName"]:GetText())
          .. "|" .. tostring(_G[b .. "IconTexture"]:IsShown() and _G[b .. "IconTexture"]:GetTexture())
          .. "|" .. (_G[b .. "AutoCastable"]:IsShown() and "a" or "-") .. (_G[b].shine and "s" or "-")
      end
      return table.concat(out, ";")`)[0]).split(";");
    assert.deepEqual(rows(), [
      "Укус|Interface\\Icons\\Ability_Druid_FerociousBite|as",
      "Рык|Interface\\Icons\\Ability_Physical_Taunt|as",
      "Неистовый вой|Interface\\Icons\\Ability_Hunter_Pet_Wolf|a-",
      "Рефлексы кобры|Interface\\Icons\\Spell_Nature_GuardianWard|--",
      "false|false|--",
    ], "names, icons, the autocastable frame and the shine of each row; the fifth slot is empty");
    assert.deepEqual(lua(boot, "local r = SpellButton1IconTexture:GetVertexColor() return r"), [1], "a ready pet spell is not dimmed");

    lua(boot, "SpellButton5:Click('RightButton')", 0);
    assert.deepEqual(sent().at(-1), ["autocast", 24604, true], "ToggleSpellAutocast(3, \"pet\")");
    assert.equal(rows()[2], "Неистовый вой|Interface\\Icons\\Ability_Hunter_Pet_Wolf|as", "PET_BAR_UPDATE redraws the shine");
    lua(boot, "SpellButton1:Click('LeftButton')", 0);
    assert.deepEqual(sent().at(-1), ["book", 17253], "CastSpell(1, \"pet\")");
    const before = sent().length;
    lua(boot, "SpellButton7:Click('LeftButton') SpellButton7:Click('RightButton')", 0);
    assert.equal(sent().length, before, "a passive neither casts nor toggles");
    lua(boot, "SpellButton3:Click('LeftButton')", 0);
    assert.equal(shown(boot, "SpellButton3Cooldown"), true, "growl's category cooldown sweeps in the book");

    // PickupSpell(2, "pet") raises the pet grid; a drop on the empty slot 7 places the growl there.
    lua(boot, 'PickupSpell(2, "pet")', 0);
    await flush();
    assert.deepEqual(lua(boot, "return PetActionBarFrame.showgrid, PetActionButton7:IsShown() and 1 or 0", 2), [1, 1]);
    assert.deepEqual(lua(boot, "local kind, slot, book = GetCursorInfo() return kind, slot, book", 3), ["spell", 2, "pet"]);
    lua(boot, "PickupPetAction(7)", 0);
    await flush();
    assert.deepEqual(sent().at(-1), ["place", 7, 2649]);
    assert.deepEqual(lua(boot, "return PetActionButton7Icon:GetTexture(), PetActionBarFrame.showgrid", 2),
      ["Interface\\Icons\\Ability_Physical_Taunt", 0]);
    assert.deepEqual(newErrors(boot, errors), []);
  } finally {
    boot.close();
  }
});
