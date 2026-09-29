import assert from "node:assert/strict";
import test from "node:test";

// The lane's load and staging edges, without the MPQ: the corpus overlay two overlapping add-on loads
// share (FrameXmlInspectCorpus.ts); the barber owner that loads nothing while a gateway table is
// missing and asks again at the next chair (FrameXmlBarberOwner.ts); the mount that resumes only a chair
// still occupied (FrameXmlBarberMount.ts); one stack split at a time in a stock socket
// (FrameXmlSocketModel.ts).

const { withFrameXmlLaneCorpus } = await import("../dist/code/browser/framexml/FrameXmlInspectCorpus.js");
const { FrameXmlBarberModel } = await import("../dist/code/browser/framexml/FrameXmlBarber.js");
const { createLazyFrameXmlBarberOwner, FRAMEXML_BARBER_ADDON } = await import("../dist/code/browser/framexml/FrameXmlBarberOwner.js");
const { mountFrameXmlBarber } = await import("../dist/code/browser/framexml/FrameXmlBarberMount.js");
const { createCannedFrameXmlSocket } = await import("../dist/code/browser/framexml/FrameXmlSocketCanned.js");

const BARBER_XML = "Interface\\AddOns\\Blizzard_BarbershopUI\\Blizzard_BarbershopUI.xml";
const VIRTUAL_ARROW = '<Button name="$parentNext" virtual="true">';

class Corpus {
  async read(path) {
    return path === BARBER_XML ? `<Ui>${VIRTUAL_ARROW}</Button></Ui>` : undefined;
  }
}

const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

test("two overlapping add-on loads share the corpus overlay; the last to finish restores the read", async () => {
  const corpus = new Corpus();
  const boot = { corpus };
  let releaseInspect;
  const inspectHeld = new Promise((resolve) => { releaseInspect = resolve; });
  let releaseBarber;
  const barberHeld = new Promise((resolve) => { releaseBarber = resolve; });
  // The inspection starts first; the barber chair's load starts while it is still reading.
  const inspect = withFrameXmlLaneCorpus(boot, async () => { await inspectHeld; return "inspect"; });
  const barber = withFrameXmlLaneCorpus(boot, async () => { await barberHeld; return corpus.read(BARBER_XML); });
  releaseInspect();
  assert.equal(await inspect, "inspect");
  releaseBarber();
  const read = await barber;
  assert.equal(read.includes(VIRTUAL_ARROW), false, "the barber XML is still read through the overlay");
  assert.equal(read.includes('<Button name="$parentNext">'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(corpus, "read"), false, "no wrapper stays installed");
  assert.equal((await corpus.read(BARBER_XML)).includes(VIRTUAL_ARROW), true, "reads are the corpus's own again");
});

function barberChair() {
  const chair = { enabled: false, seated: false, cost: undefined };
  const model = new FrameXmlBarberModel({
    enabled: () => chair.enabled,
    seated: () => chair.seated,
    look: () => ({ hairStyle: 1, hairColor: 0, facialHair: 2, skin: 3 }),
    appearance: () => 1,
    styles: (type) => (type === 0 || type === 2 ? [{ id: 744, data: 1, name: "Бык" }] : []),
    hairColors: () => [0, 1, 2],
    hairCustomization: () => "HORNS",
    facialHairCustomization: () => "NORMAL",
    costBase: () => chair.cost,
    apply() {},
    standUp() {},
  });
  model.attach({ fire: () => 1 });
  const loads = [];
  const boot = {
    vm: {}, errorCount: 0, corpus: new Corpus(),
    bridge: { getFrame: () => undefined, Hide() {} },
    loadAddon: async (name) => { loads.push(name); return { ok: false, status: "missing", message: "offline" }; },
  };
  const renderer = { elementFor: () => undefined, addRoots() {}, sync() {} };
  return { chair, model, loads, boot, renderer };
}

test("the barber owner loads nothing while a gateway table is missing and asks again at the next chair", async () => {
  const { chair, model, loads, boot, renderer } = barberChair();
  const reasons = [];
  let prepared = 0;
  const native = [];
  const owner = createLazyFrameXmlBarberOwner({ barber: model }, boot, renderer,
    { hide: () => native.push("hide"), show: () => native.push("show") },
    async () => { prepared += 1; }, (reason) => reasons.push(reason));
  try {
    chair.enabled = true;
    chair.seated = true;
    model.opened();
    await owner.settled;
    await settle();
    assert.equal(prepared, 1);
    assert.deepEqual(loads, [], "no /dbc/barber-cost: Blizzard_BarbershopUI is not loaded");
    assert.equal(owner.failed, false, "not a failure for the session");
    assert.deepEqual(native, [], "the native window already holds this chair");
    assert.equal(reasons.length, 1);
    // The gateway restarted with the route: the next chair fetches again and loads.
    chair.cost = 111_173;
    model.opened();
    await owner.settled;
    await settle();
    assert.equal(prepared, 2);
    assert.deepEqual(loads, [FRAMEXML_BARBER_ADDON]);
  } finally {
    owner.dispose();
  }
});

test("the mount resumes a chair still occupied, not one left without a haircut", async () => {
  const { chair, model, loads, boot, renderer } = barberChair();
  chair.cost = 111_173;
  let prepared = 0;
  const seam = { barber: model, barberPrepare: async () => { prepared += 1; } };
  // WorldClient's barberShopOpen outlived a stand-up: enabled, but nobody in the chair.
  chair.enabled = true;
  const unmount = mountFrameXmlBarber(seam, boot, renderer);
  await settle();
  assert.equal(prepared, 0, "a /reload after leaving the chair fetches nothing");
  assert.deepEqual(loads, [], "and loads nothing");
  unmount();
  // A /reload in the chair.
  chair.seated = true;
  const again = mountFrameXmlBarber(seam, boot, renderer);
  await settle();
  assert.equal(prepared, 1);
  assert.deepEqual(loads, [FRAMEXML_BARBER_ADDON]);
  again();
});

test("a second stack waits while the first stack's split is still landing", () => {
  const { model, world } = createCannedFrameXmlSocket();
  const fired = [];
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  model.onOpenRequest = () => true;
  model.owned = true;
  assert.equal(model.request({ location: 0, bag: 0, slot: 1 }), true);
  world.cursor = 0x4000_0102n; // three amber
  model.clickSocket(3);
  assert.deepEqual(world.splits, [{ guid: 0x4000_0102n, bag: 255, slot: 25 }]);
  // Before the server answered, the same stack again, into the red socket.
  world.cursor = 0x4000_0102n;
  model.clickSocket(2);
  assert.equal(world.splits.length, 1, "no second CMSG_SPLIT_ITEM into the slot the first is landing in");
  assert.equal(world.cursor, 0x4000_0102n, "the stack stays on the cursor");
  assert.deepEqual(fired.at(-1), ["UI_ERROR_MESSAGE", "Этот объект занят."]);
  world.landSplit();
  model.tick();
  const separated = world.carried.get("255:25");
  assert.equal(model.staged(separated.guid), true, "the first split still lands in its socket");
  // Now the second split goes through, into the next free slot.
  model.clickSocket(2);
  assert.deepEqual(world.splits, [{ guid: 0x4000_0102n, bag: 255, slot: 28 }]);
});

test("staging, unstaging and closing repaint the bags' lock state; nothing staged repaints nothing", async () => {
  const { FrameXmlSocketModel } = await import("../dist/code/browser/framexml/FrameXmlSocketModel.js");
  let locks = 0;
  let cursor;
  const gems = new Map([[2n, { guid: 2n, entry: 40111, count: 1, bag: 255, slot: 23 }]]);
  const model = new FrameXmlSocketModel({
    item: () => ({ guid: 10n, entry: 900001, sockets: [2, 0, 0], enchantments: [0, 0, 0, 0, 0, 0, 0], flags: 0 }),
    carried: (guid) => gems.get(guid), carriedAt: () => undefined,
    cursor: () => (cursor === undefined ? undefined : gems.get(cursor)),
    clearCursor: () => { cursor = undefined; }, pickup: (guid) => { cursor = guid; },
    gem: () => ({ name: "Рельефный багровый рубин", color: 2, enchantmentId: 3518 }),
    enchantmentGem: () => undefined, itemLink: () => undefined, splitOne: () => undefined,
    socketGems: () => true, now: () => 0, locksChanged: () => { locks += 1; },
  });
  model.attach({ fire: () => 1 });
  model.onOpenRequest = () => true;
  model.owned = true;
  model.request({ location: 0, bag: 0, slot: 1 });
  assert.equal(locks, 0);
  cursor = 2n;
  model.clickSocket(1);
  assert.deepEqual([model.staged(2n), locks], [true, 1], "staged: locked");
  model.clickSocket(1);
  assert.deepEqual([model.staged(2n), cursor, locks], [false, 2n, 2], "back on the cursor: unlocked");
  model.clickSocket(1);
  model.close();
  assert.deepEqual([model.staged(2n), locks], [false, 4], "the closed session gives its gem back");
  model.request({ location: 0, bag: 0, slot: 1 });
  model.close();
  assert.equal(locks, 4);
});
