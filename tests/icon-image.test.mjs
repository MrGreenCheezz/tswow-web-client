import assert from "node:assert/strict";
import test from "node:test";
import { creatureFamilyIconUrl, needsFetch, spellIconUrl } from "../dist/code/browser/ui/IconImage.js";
import { creatureIconSource } from "../dist/code/browser/CreatureMetadata.js";

test("an icon from the gateway is fetched, one from beside the page is not", () => {
  const page = "http://localhost:5173";

  // Served beside the page: spell icons, creature icons, everything under public/.
  assert.equal(needsFetch("/icons/2273.png", page), false);
  assert.equal(needsFetch("/creature-icons/1.png", page), false);
  assert.equal(needsFetch(`${page}/icons/2273.png`, page), false);

  // The gateway. An `<img>` pointed here is a silent 403: the gateway refuses a request with no
  // `Origin` header and a browser sends none for an image load, so these have to be fetched.
  assert.equal(needsFetch("http://localhost:3000/item-icon/20094", page), true);
  assert.equal(needsFetch("https://gateway.example/item-icon/20094", page), true);

  // A URL that already carries its own bytes is not a request at all.
  assert.equal(needsFetch("blob:http://localhost:5173/abc", page), false);
  assert.equal(needsFetch("data:image/png;base64,iVBORw0K", page), false);

  // A prefix is not an origin: another host that merely starts the same must still be fetched.
  assert.equal(needsFetch("http://localhost:51730/item-icon/1", page), true);
});

test("an icon id becomes a gateway route, and the answer is fetched rather than assigned", () => {
  const gateway = "http://localhost:8090";
  const page = "http://localhost:5173";

  // The whole point of the slice: the seven places that draw a spell icon ask the gateway for it,
  // so a `SpellIcon` row a module added is extracted on demand instead of showing nothing until
  // somebody reruns `build-assets.bat`.
  assert.equal(spellIconUrl(136, gateway), `${gateway}/spell-icon/136`);
  assert.equal(creatureFamilyIconUrl(1, gateway), `${gateway}/creature-icon/1`);
  assert.equal(needsFetch(spellIconUrl(136, gateway), page), true,
    "a gateway route in an <img> is a silent 403, so it has to go through the fetch path");

  // Before login there is no gateway to ask. The directory beside the page is what `build-assets`
  // filled and what these URLs meant until this slice, so that is the answer, and it is assigned
  // straight into the element rather than fetched.
  assert.equal(spellIconUrl(136, undefined), "/icons/136.png");
  assert.equal(creatureFamilyIconUrl(1, undefined), "/creature-icons/1.png");
  assert.equal(needsFetch(spellIconUrl(136, undefined), page), false);

  // Zero is how both a spell row and a pet bar slot spell "no picture", and the callers draw a
  // letter instead. A URL for icon 0 would be a guaranteed 404 on every one of them.
  assert.equal(spellIconUrl(0, gateway), undefined);
  assert.equal(spellIconUrl(-1, gateway), undefined);
  assert.equal(creatureFamilyIconUrl(0, gateway), undefined);
});

test("a creature with no pet family falls back to a spell icon, not to a file beside the page", () => {
  const gateway = "http://localhost:8090";
  const beast = { entry: 1, name: "", subname: "", type: 1, family: 3, rank: 0 };
  assert.equal(creatureIconSource(beast, gateway), `${gateway}/creature-icon/3`);

  // Type 1 is a beast, and 1,573 is the paw print in `SpellIcon` — an icon id, so it goes to the
  // spell route. Before this it was written as `/icons/1573.png` in a second place, which is how
  // the two halves of one decision drift apart.
  assert.equal(creatureIconSource({ ...beast, family: 0 }, gateway), `${gateway}/spell-icon/1573`);
  // Nothing known at all still draws the question mark rather than an empty square.
  assert.equal(creatureIconSource(undefined, gateway), `${gateway}/spell-icon/2273`);
});
