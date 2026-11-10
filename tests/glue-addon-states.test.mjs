import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GlueAddonStateList, formatGlueAddonsText, parseGlueAddonsText,
} from "../dist/code/browser/glue/GlueAddonStates.js";
import { setGlueWorldAddonStates } from "../dist/code/browser/glue/GlueAddons.js";
import {
  frameXmlCharacterAddonEnabled, frameXmlCharacterAddonVersionCheck, frameXmlCharacterAddons,
} from "../dist/code/browser/framexml/FrameXmlClientAddons.js";
import { clientAddonDefaultState, listClientAddons } from "../dist/code/gateway/ClientAddons.js";

/**
 * 3.46 (11.11): the per-character add-on states of the glue as Wow.exe keeps them (.runtime/re-2026-11-11/glue):
 * AddOns.txt read (0x5f91e0) and written (0x5f76a0), the account's file for a character without one, the TOC's
 * DefaultState (0x005f86a0), and the hand-over to the world's load list.
 */

function memoryFiles(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, read: (character) => data.get(character), write: (character, text) => { data.set(character, text); } };
}

test("AddOns.txt: 'disabled' in any case is off, any other value on; the written form is CRLF lines", () => {
  const states = parseGlueAddonsText("A: disabled\r\nB: DISABLED\nC: enabled\nD: whatever\nE:\nnot a line\n");
  assert.deepEqual([...states].map(([key, entry]) => [key, entry.enabled]), [["a", false], ["b", false], ["c", true], ["d", true]]);
  assert.equal(formatGlueAddonsText([{ name: "A", enabled: false }, { name: "C", enabled: true }]), "A: disabled\r\nC: enabled\r\n");
});

test("a character without its own file starts from the account's, and OK writes its own", () => {
  const files = memoryFiles({ Own: "Alpha: enabled\r\n" });
  const list = new GlueAddonStateList(files, () => new Map([["alpha", false]]));
  list.setAddons([{ name: "Alpha", defaultState: true }, { name: "Beta", defaultState: true }]);
  list.setCharacters(["Own", "New"]);
  assert.equal(list.state("Alpha", "Own"), 2);
  assert.equal(list.state("Alpha", "New"), 0, "the account's line");
  assert.equal(list.state("Alpha"), 1);
  list.save();
  assert.equal(files.data.get("New"), "Alpha: disabled\r\n", "the account's copy became the character's");
  assert.equal(files.data.has("Own") && files.data.get("Own"), "Alpha: enabled\r\n", "an unchanged file is not rewritten");
  assert.equal(list.state("Gamma"), 0, "not installed");
  assert.equal(list.state("Beta", "Nobody"), 2, "no character considered: DefaultState");
});

test("no characters: DefaultState decides; a disagreement among the others falls back to it", () => {
  const list = new GlueAddonStateList(memoryFiles({ A: "Quiet: enabled\r\n", B: "Quiet: disabled\r\n" }), () => undefined);
  list.setAddons([{ name: "Quiet", defaultState: false }, { name: "Loud", defaultState: true }]);
  assert.equal(list.state("Quiet"), 0);
  assert.equal(list.state("Loud"), 2);
  list.setCharacters(["A", "B", "C"]);
  assert.equal(list.state("Quiet", "C"), 0, "mixed elsewhere: DefaultState (off)");
  list.set("Quiet", "B", true);
  assert.equal(list.state("Quiet", "C"), 2, "all others on: on");
  list.reset();
  assert.equal(list.state("Quiet", "B"), 0, "Reset reads the files again");
});

test("the TOC's DefaultState as the TOC reader takes it", () => {
  assert.equal(clientAddonDefaultState("## Interface: 30300\n## DefaultState: disabled\n"), false);
  assert.equal(clientAddonDefaultState("##DefaultState:Enabled\n"), true);
  assert.equal(clientAddonDefaultState("## defaultstate:   DISABLED"), false);
  assert.equal(clientAddonDefaultState("## DefaultState: disabled\r\n"), false, "0x76f1e0 splits at CR and LF (0x9f15f0)");
  assert.equal(clientAddonDefaultState("## DefaultState: disabled now\n"), undefined, "the value compares whole");
  assert.equal(clientAddonDefaultState("## DefaultState : disabled\n"), undefined, "the key is 'DefaultState:'");
  assert.equal(clientAddonDefaultState("## Interface: 30300\n"), undefined);
});

test("the gateway lists the profile's own line and the TOC's DefaultState", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-glue-addon-states-"));
  try {
    for (const [name, toc] of [["Alpha", "## DefaultState: disabled\n"], ["Beta", "Beta.lua\n"], ["Gamma", "Gamma.lua\n"]]) {
      await mkdir(join(root, "Interface", "AddOns", name), { recursive: true });
      await writeFile(join(root, "Interface", "AddOns", name, `${name}.toc`), toc);
    }
    await mkdir(join(root, "WTF", "Account", "A", "R", "C"), { recursive: true });
    await writeFile(join(root, "WTF", "Account", "A", "R", "C", "AddOns.txt"), "Alpha: enabled\nBeta: disabled\n");
    assert.deepEqual(await listClientAddons(root), [
      { name: "Alpha", loadOnDemand: false, enabled: true, profileState: true, defaultState: false },
      { name: "Beta", loadOnDemand: false, enabled: false, profileState: false },
      { name: "Gamma", loadOnDemand: false, enabled: true },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the world loads what the glue handed over for the character, else the profile's list", () => {
  const list = {
    addons: [{ name: "Alpha", loadOnDemand: false }],
    installed: [
      { name: "Alpha", loadOnDemand: false, enabled: true },
      { name: "Beta", loadOnDemand: true, enabled: false },
    ],
    checkAddonVersion: true,
  };
  assert.deepEqual(frameXmlCharacterAddons(list), list.addons);
  assert.equal(frameXmlCharacterAddonVersionCheck(list), true);
  setGlueWorldAddonStates({ character: "C", enabled: new Map([["alpha", false], ["beta", true]]), checkAddonVersion: false });
  try {
    assert.deepEqual(frameXmlCharacterAddons(list), [{ name: "Beta", loadOnDemand: true }]);
    assert.equal(frameXmlCharacterAddonEnabled(list.installed[0]), false);
    assert.equal(frameXmlCharacterAddonVersionCheck(list), false);
  } finally {
    setGlueWorldAddonStates(undefined);
  }
});
