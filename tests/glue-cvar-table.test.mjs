import assert from "node:assert/strict";
import test from "node:test";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";

/**
 * 5.37 (15.11, lane misc8): the login screens answer from the same CVar table as the world (GlueCVarTable.ts over
 * framexml/WowCVarRegistry.ts): registered defaults for GetCVar and GetCVarDefault, any case of a name, and GetGamma /
 * GetTerrainMip as Wow.exe's 0x0054ea60 / 0x0054eb10 (1 − gamma, 1 − shadowLevel's integer).
 */

async function boot(locale = "ruRU") {
  const runtime = new GlueRuntime({
    provider: createFixtureProvider({ "Interface/GlueXML/GlueXML.toc": "## Interface: 30300\n" }),
    api: { locale },
  });
  await runtime.load();
  const evaluate = (expression) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${expression} end)()`, "@glue-cvar-table-probe");
    assert.equal(outcome.ok, true, `${expression}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  return { runtime, evaluate };
}

test("GetGamma is 1 minus gamma (registered \"1.0\": 0) and GetTerrainMip 1 minus shadowLevel's integer", async () => {
  const { runtime, evaluate } = await boot();
  try {
    assert.equal(evaluate("return GetGamma()"), 0);
    assert.equal(evaluate("return GetTerrainMip()"), 0, "shadowLevel \"1\"");
    evaluate("SetCVar('gamma', '0.75'); SetCVar('shadowLevel', '0'); return 1");
    assert.equal(evaluate("return GetGamma()"), 0.25);
    assert.equal(evaluate("return GetTerrainMip()"), 1);
  } finally {
    runtime.close();
  }
});

test("registered defaults answer GetCVar and GetCVarDefault, as in the world", async () => {
  const { runtime, evaluate } = await boot();
  try {
    // The glue's old table said 60, "1", "1024x768" and "System Default"; Wow.exe registers these.
    assert.equal(evaluate("return GetCVar('gxRefresh')"), "75");
    assert.equal(evaluate("return GetCVarDefault('gxRefresh')"), "75");
    assert.equal(evaluate("return GetCVar('Sound_MasterVolume')"), "1.0");
    assert.equal(evaluate("return GetCVar('Sound_OutputDriverName')"), "Primary Sound Driver");
    assert.equal(evaluate("return GetCVar('gxResolution')"), "1920x1080", "the computed default on a typical machine");
    assert.equal(evaluate("return GetCVarDefault('gamma')"), "1.0");
    assert.equal(evaluate("return GetCVar('readTOS')"), "0");
    assert.equal(runtime.api.cvar("checkAddonVersion"), "1");
    // A stored value moves GetCVar, not GetCVarDefault.
    evaluate("SetCVar('gxRefresh', '144'); return 1");
    assert.equal(evaluate("return GetCVar('gxRefresh')"), "144");
    assert.equal(evaluate("return GetCVarDefault('gxRefresh')"), "75");
    // A name nothing registers is nil, for GetCVar, GetCVarBool and GetCVarDefault alike.
    assert.equal(evaluate("return GetCVar('noSuchCVarHere')"), undefined);
    assert.equal(evaluate("return GetCVarBool('noSuchCVarHere')"), undefined);
    assert.equal(evaluate("return GetCVarDefault('noSuchCVarHere')"), undefined);
  } finally {
    runtime.close();
  }
});

test("a CVar name is found in any case, and RegisterCVar keeps a registered default", async () => {
  const { runtime, evaluate } = await boot();
  try {
    evaluate("SetCVar('ACCOUNTNAME', 'TESTER'); return 1");
    assert.equal(evaluate("return GetCVar('accountName')"), "TESTER");
    assert.equal(evaluate("return GetSavedAccountName()"), "TESTER");
    evaluate("RegisterCVar('readEULA', '1'); RegisterCVar('myAddonFlag', 'on'); return 1");
    assert.equal(evaluate("return GetCVar('readEULA')"), "0");
    assert.equal(evaluate("return GetCVar('myaddonflag')"), "on");
    assert.equal(evaluate("return GetCVarDefault('myAddonFlag')"), "on");
  } finally {
    runtime.close();
  }
});

test("computed defaults follow the locale, as the world's do", async () => {
  const { runtime, evaluate } = await boot("koKR");
  try {
    assert.equal(evaluate("return GetCVar('violenceLevel')"), "1");
    assert.equal(evaluate("return GetCVar('autoInteract')"), "1");
  } finally {
    runtime.close();
  }
});
