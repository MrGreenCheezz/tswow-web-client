import assert from "node:assert/strict";
import test from "node:test";
import { GlueGatewayNames } from "../dist/code/browser/glue/GlueNames.js";
import { className, forgetCreationNames } from "../dist/code/browser/ui/UnitSnapshot.js";
import { formatNpcText } from "../dist/code/browser/ui/NpcText.js";

test("Glue ChrClasses names reach world quest text for custom class 13", async () => {
  const previousFetch = globalThis.fetch;
  forgetCreationNames();
  globalThis.fetch = async (url) => {
    if (String(url).includes("/dbc/character-creation")) {
      return {
        ok: true,
        json: async () => ({
          races: [{ id: 4, name: "Ночной эльф" }],
          classes: [{ id: 13, name: "Герой", fileName: "HERO" }],
        }),
      };
    }
    return { ok: false, status: 404 };
  };
  try {
    assert.equal(className(13), "Класс 13");
    const names = new GlueGatewayNames("http://127.0.0.1:8090");
    await names.load();
    assert.equal(names.className(13), "Герой");
    assert.equal(className(13), "Герой");
    assert.equal(formatNpcText("Юный $c", {
      name: "Алан", className: className(13), raceName: "Ночной эльф", gender: 0,
    }), "Юный Герой");
  } finally {
    globalThis.fetch = previousFetch;
    forgetCreationNames();
  }
});
