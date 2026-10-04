// 4.08: the native charter window offers the charter to the selected player (stock PetitionFrame's
// request button, OfferPetition → CMSG_OFFER_PETITION), from the owner's side only.
import assert from "node:assert/strict";
import test from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";

function node(tag = "div") {
  const listeners = new Map();
  const n = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, className: "", textContent: "", listeners, style: {},
    hidden: false, disabled: false, value: "", id: "",
    append(...children) { n.children.push(...children); }, replaceChildren(...children) { n.children = children; },
    addEventListener(name, handler) { listeners.set(name, handler); }, setAttribute() {}, focus() {},
  };
  return n;
}

test("«Предложить цели» sends one offer to a selected player and nothing without one", async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: node };
  try {
    const notices = [];
    const panels = [];
    class Panel { constructor() { this.body = node(); this.root = node(); this.visible = false; panels.push(this); } show() { this.visible = true; } hide() { this.visible = false; } }
    const offers = [];
    const objects = new Map([[1n, { guid: 1n, typeId: 4 }], [7n, { guid: 7n, typeId: 4 }], [9n, { guid: 9n, typeId: 3 }]]);
    const world = {
      state: { selfGuid: 1n, objects }, targetGuid: undefined,
      petition: { name: "Стражи", ownerGuid: 1n, minSignatures: 9, arena: false },
      petitionSignatures: { petitionGuid: 0x55n, ownerGuid: 1n, signers: [] },
      events: { on: () => () => {} },
      displayName: (guid) => (guid === 7n ? "Лиара" : "?"),
      offerPetition: (petition, player) => offers.push([petition, player]),
    };
    const ui = await isolatedUi("Petition", {
      "../game/Context.js": { game: { world } },
      "./Widgets.js": { Panel, setTip() {}, confirmPanel() {} },
      "./Notices.js": { notice: (text) => notices.push(text) },
      "./Format.js": { formatMoney: String },
      "../framexml/FrameXmlPetitionController.js": { frameXmlCharterPublished: () => false },
    });
    ui.showPetition();
    const offer = panels[0].body.children.find((child) => child.id === "petition-offer");
    assert.ok(offer);
    assert.equal(offer.hidden, false, "the owner sees it");
    offer.listeners.get("click")();
    assert.deepEqual(offers, [], "no target: nothing is sent");
    world.targetGuid = 9n;
    offer.listeners.get("click")();
    assert.deepEqual(offers, [], "a creature is not a signer");
    world.targetGuid = 1n;
    offer.listeners.get("click")();
    assert.deepEqual(offers, [], "nor is the owner");
    world.targetGuid = 7n;
    offer.listeners.get("click")();
    assert.deepEqual(offers, [[0x55n, 7n]]);
    assert.equal(notices.at(-1), "Предложение отправлено: Лиара");
    world.petitionSignatures = { petitionGuid: 0x55n, ownerGuid: 2n, signers: [] };
    world.petition = { ...world.petition, ownerGuid: 2n };
    ui.showPetition();
    assert.equal(offer.hidden, true, "a signer, not the owner, does not offer");
  } finally {
    globalThis.document = previous;
  }
});
