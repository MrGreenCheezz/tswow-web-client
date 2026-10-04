import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  noteGatewayCacheGeneration, resetGatewayGeneration, trustedGatewayIconUrl,
} from "../dist/code/browser/GatewayGeneration.js";
import { ItemMetadataClient } from "../dist/code/browser/ItemMetadata.js";
import { creatureFamilyIconUrl, spellIconUrl } from "../dist/code/browser/ui/IconImage.js";

// 10.12 review (02.10): the icon routes are `tile` routes too (Gateway.ts `/spell-icon`,
// `/creature-icon`), and an icon URL that carries `g` must still be accepted where FrameXML is handed
// a gateway URL as a texture name (FrameXmlWorldMount.ts `textureUrl`).

const GATEWAY = "http://127.0.0.1:8090";
const G = "a1b2c3d4e5f6000ff00ba12";

test("spell and creature-family icon URLs carry the gateway's generation once it is published", () => {
  resetGatewayGeneration();
  assert.equal(spellIconUrl(136, GATEWAY), `${GATEWAY}/spell-icon/136`, "no generation yet: unchanged");
  assert.equal(creatureFamilyIconUrl(1, GATEWAY), `${GATEWAY}/creature-icon/1`);
  noteGatewayCacheGeneration(GATEWAY, G);
  assert.equal(spellIconUrl(136, GATEWAY), `${GATEWAY}/spell-icon/136?g=${G}`);
  assert.equal(creatureFamilyIconUrl(1, GATEWAY), `${GATEWAY}/creature-icon/1?g=${G}`);
  assert.equal(spellIconUrl(136, undefined), "/icons/136.png", "the page's own copy is not a gateway URL");
  assert.equal(creatureFamilyIconUrl(1, undefined), "/creature-icons/1.png");
  resetGatewayGeneration();
});

test("an item or spell icon URL of this gateway is a trusted texture name with or without g", () => {
  resetGatewayGeneration();
  assert.equal(trustedGatewayIconUrl(`${GATEWAY}/item-icon/5`, GATEWAY), `${GATEWAY}/item-icon/5`);
  assert.equal(trustedGatewayIconUrl(`${GATEWAY}/spell-icon/136`, GATEWAY), `${GATEWAY}/spell-icon/136`);
  assert.equal(trustedGatewayIconUrl(`${GATEWAY}/item-icon/5?g=${G}`, GATEWAY), `${GATEWAY}/item-icon/5?g=${G}`);
  assert.equal(trustedGatewayIconUrl(`${GATEWAY}/spell-icon/136?g=r1x2`, GATEWAY), `${GATEWAY}/spell-icon/136?g=r1x2`);
  for (const rejected of [
    `${GATEWAY}/item-icon/5?x=1`,
    `${GATEWAY}/item-icon/5?g=${G}&x=1`,
    `${GATEWAY}/item-icon/5?g=`,
    `${GATEWAY}/item-icon/5?g=a/b`,
    `${GATEWAY}/item-icon/5#g`,
    "http://user:pw@127.0.0.1:8090/item-icon/5",
    "http://127.0.0.1:8091/item-icon/5",
    `${GATEWAY}/texture?path=x`,
    `${GATEWAY}/item-icon/x`,
    "Interface\\Icons\\INV_Misc_QuestionMark",
    "",
  ]) {
    assert.equal(trustedGatewayIconUrl(rejected, GATEWAY), undefined, rejected);
  }
});

test("the URL ItemMetadata builds after a generation is published is still trusted", () => {
  resetGatewayGeneration();
  const items = new ItemMetadataClient("ws://127.0.0.1:8090/world");
  noteGatewayCacheGeneration(GATEWAY, G);
  const display = items.displayIconUrl(1234);
  assert.match(display, /\?g=/);
  assert.equal(trustedGatewayIconUrl(display, GATEWAY), display);
  const spell = items.iconUrl({ iconId: 136, displayId: 1234 });
  assert.equal(trustedGatewayIconUrl(spell, GATEWAY), spell);
  resetGatewayGeneration();
});

test("FrameXML's texture resolver uses the shared check instead of demanding an empty query", () => {
  const source = readFileSync(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  assert.match(source, /trustedGatewayIconUrl\(path, origin\)/);
  assert.doesNotMatch(source, /absolute\.search === ""/);
});
