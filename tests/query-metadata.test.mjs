import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { CreatureMetadataClient } from "../dist/code/browser/CreatureMetadata.js";
import { ItemMetadataClient } from "../dist/code/browser/ItemMetadata.js";
import { EventBus } from "../dist/code/world/EventBus.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

const GATEWAY = "ws://127.0.0.1:8090/auth";

/**
 * A world session that answers queries, modelled on `WorldClient` where it matters.
 *
 * `creatureTemplate` and `itemTemplate` there hand back what has already arrived, send one packet
 * for an entry they have not asked about, and never send a second — so a fake that recorded every
 * call would count the reads the answer itself provokes as requests. `sent` is what actually went
 * out; `answer` is the server replying.
 */
function session() {
  const events = new EventBus();
  const creatures = new Map();
  const items = new Map();
  const asked = new Set();
  const sent = [];
  const query = (kind, entry, held) => {
    const known = held.get(entry);
    if (known) return known;
    const key = `${kind}:${entry}`;
    if (!asked.has(key)) {
      asked.add(key);
      sent.push(key);
    }
    return undefined;
  };
  return {
    events,
    sent,
    creatureTemplate: (entry) => query("creature", entry, creatures),
    itemTemplate: (entry) => query("item", entry, items),
    answerCreature(template) {
      const full = { found: true, subName: "", cursorName: "", creatureType: 0, creatureFamily: 0, classification: 0, ...template };
      creatures.set(full.entry, full);
      events.emit("QUERY_CACHE_CHANGED", { kind: "creature", id: full.entry });
    },
    answerItem(template) {
      const full = {
        found: true, itemClass: 0, subClass: 0, soundOverrideSubclass: -1, displayInfoId: 0, quality: 0,
        inventoryType: 0, stackable: 1, material: 0, ...template,
      };
      items.set(full.entry, full);
      events.emit("QUERY_CACHE_CHANGED", { kind: "item", id: full.entry });
    },
    /** What `SMSG_CLIENTCACHE_VERSION` does when the realm's data has moved under the session. */
    clearCache() {
      creatures.clear();
      items.clear();
      asked.clear();
      events.emit("QUERY_CACHE_CHANGED", { kind: "cleared", id: 0 });
    },
  };
}

/** The gateway's dump, as the route answers it: whatever rows it has for the entries asked for. */
function dump(rows) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const asked = new URL(String(url)).searchParams.get("entries").split(",").map(Number);
    requests.push(asked);
    return { ok: true, status: 200, json: async () => asked.map((entry) => rows.get(entry)).filter(Boolean) };
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

test("a creature the dump has never heard of names itself from the wire", async () => {
  // The case the slice exists for. `npm run assets:creatures` dumped the database as it was, so a
  // creature written after that run is not in the file at all and the route hands back nothing for
  // it — measured against the gateway on this machine, `/data/creatures?entries=190011`, one past
  // the largest entry the dump holds, answers `[]`, and the object is drawn as
  // «unit · entry 190011». One `CMSG_CREATURE_QUERY` fixes that without regenerating anything.
  const world = session();
  const gateway = dump(new Map());
  try {
    const client = new CreatureMetadataClient(GATEWAY);
    let repaints = 0;
    client.attach(world, () => { repaints++; });

    await client.load([45000]);
    assert.deepEqual(world.sent, ["creature:45000"], "one query per entry, and it goes out with the fetch");
    assert.equal(client.get(45000), undefined, "nothing is known until the server answers");
    assert.equal(repaints, 0);

    world.answerCreature({ entry: 45000, name: "Хранитель модуля", subName: "смотритель", creatureType: 7, creatureFamily: 0, classification: 1 });
    assert.equal(client.get(45000)?.name, "Хранитель модуля");
    assert.equal(client.get(45000)?.subname, "смотритель");
    assert.equal(client.get(45000)?.type, 7, "an entry with no dumped row is built from the answer whole");
    assert.equal(client.get(45000)?.rank, 1);
    assert.equal(repaints, 1, "and the screen is told, or the name arrives where nobody is looking");

    // Asked once. The client's own `#requested` stops the second `load` reaching the wire at all,
    // and `WorldClient` would refuse it again behind that.
    await client.load([45000]);
    assert.deepEqual(world.sent, ["creature:45000"]);
  } finally {
    gateway.restore();
  }
});

test("a dumped creature keeps its icon and takes the server's name", async () => {
  const world = session();
  const gateway = dump(new Map([[299, { entry: 299, name: "Kobold Vermin", subname: "", type: 7, family: 0, rank: 0 }]]));
  try {
    const client = new CreatureMetadataClient(GATEWAY);
    client.attach(world, () => undefined);
    await client.load([299]);
    assert.equal(client.get(299)?.name, "Kobold Vermin", "the dump is the first, synchronous answer");

    world.answerCreature({ entry: 299, name: "Кобольд-вредитель", subName: "", creatureType: 0, creatureFamily: 0 });
    assert.equal(client.get(299)?.name, "Кобольд-вредитель", "and the wire is the correction");
    // The type and family decide which icon is drawn beside the name, and they come out of the
    // same table in both answers. Taking the wire's zeros here would blank the icon of every
    // creature the moment its query landed.
    assert.equal(client.get(299)?.type, 7);
  } finally {
    gateway.restore();
  }
});

test("a missing row leaves the dump's answer alone", async () => {
  // `found=false` is the server saying it has no such entry — the top bit of the entry set, and
  // nothing after it. Everything in the template is then at its default, so writing it over a
  // dumped row would replace a name with an empty string.
  const world = session();
  const gateway = dump(new Map([[299, { entry: 299, name: "Kobold Vermin", subname: "", type: 7, family: 0, rank: 0 }]]));
  try {
    const client = new CreatureMetadataClient(GATEWAY);
    let repaints = 0;
    client.attach(world, () => { repaints++; });
    await client.load([299]);
    world.answerCreature({ entry: 299, found: false, name: "" });
    assert.equal(client.get(299)?.name, "Kobold Vermin");
    assert.equal(repaints, 0, "and nothing is redrawn for an answer that said nothing");
  } finally {
    gateway.restore();
  }
});

test("SMSG_CLIENTCACHE_VERSION lets every entry be asked about again", async () => {
  const world = session();
  const gateway = dump(new Map());
  try {
    const client = new CreatureMetadataClient(GATEWAY);
    client.attach(world, () => undefined);
    await client.load([45000]);
    world.answerCreature({ entry: 45000, name: "Первое имя" });
    assert.equal(client.get(45000)?.name, "Первое имя");

    await client.load([45000]);
    assert.deepEqual(world.sent, ["creature:45000"], "nothing is re-asked while the cache stands");

    // The realm's static data moved: that is the entire job of this packet, and a client holding
    // answers of its own over the top of the cache has to hear it too.
    world.clearCache();
    await client.load([45000]);
    assert.deepEqual(world.sent, ["creature:45000", "creature:45000"]);
    world.answerCreature({ entry: 45000, name: "Второе имя" });
    assert.equal(client.get(45000)?.name, "Второе имя");
  } finally {
    gateway.restore();
  }
});

test("an item the dump has never heard of names itself, and finds its icon by display id", async () => {
  // An item written after `npm run assets:items` last ran is not among the dump's 38,609 rows and
  // the route hands back nothing for it, the same as a creature's. The answer carries no
  // `SpellIcon` id — that objection is why this was left out of the second pass — but it carries
  // the display id, and 22,489 of the 38,609 dumped rows have `iconId` 0 and already resolve their
  // picture that way.
  const world = session();
  const gateway = dump(new Map());
  try {
    const client = new ItemMetadataClient(GATEWAY);
    let repaints = 0;
    client.attach(world, () => { repaints++; });

    await client.load([60000]);
    assert.deepEqual(world.sent, ["item:60000"]);

    world.answerItem({
      entry: 60000, name: "Клинок модуля", displayInfoId: 70000, quality: 4, inventoryType: 13,
      itemClass: 2, subClass: 7, soundOverrideSubclass: -1, material: 1, stackable: 1,
    });
    const item = client.get(60000);
    assert.equal(item.name, "Клинок модуля");
    assert.equal(item.quality, 4);
    assert.equal(item.inventoryType, 13);
    assert.equal(item.displayId, 70000);
    // The four Н1б needs and the dump does not carry.
    assert.equal(item.itemClass, 2);
    assert.equal(item.subClass, 7);
    assert.equal(item.soundOverrideSubclass, -1);
    assert.equal(item.material, 1);
    assert.equal(repaints, 1);
    assert.match(client.iconUrl(item), /\/item-icon\/70000$/, "no icon id in the answer, so the display id answers");

    await client.load([60000]);
    assert.deepEqual(world.sent, ["item:60000"], "and it is not asked for twice");
  } finally {
    gateway.restore();
  }
});

test("a dumped item keeps the icon the dump gave it", async () => {
  const world = session();
  const gateway = dump(new Map([[6948, {
    entry: 6948, name: "Hearthstone", displayId: 6418, quality: 1, inventoryType: 0, stackable: 1, iconId: 134414,
  }]]));
  try {
    const client = new ItemMetadataClient(GATEWAY);
    client.attach(world, () => undefined);
    await client.load([6948]);
    assert.match(client.iconUrl(client.get(6948)), /\/spell-icon\/134414$/);

    world.answerItem({ entry: 6948, name: "Камень возвращения", displayInfoId: 6418, quality: 1, stackable: 1 });
    assert.equal(client.get(6948)?.name, "Камень возвращения");
    assert.match(client.iconUrl(client.get(6948)), /\/spell-icon\/134414$/,
      "the answer has no icon id, so losing the dump's would cost every item its picture");
  } finally {
    gateway.restore();
  }
});

test("SMSG_CLIENTCACHE_VERSION lets an item be asked about again as well", async () => {
  // The plan takes this decision for both tables at once, so the packet has to reach both clients.
  // The creature twin above is not this test: the two hold their own `#requested`, and a `cleared`
  // branch on one of them says nothing about the other.
  const world = session();
  const gateway = dump(new Map());
  try {
    const client = new ItemMetadataClient(GATEWAY);
    client.attach(world, () => undefined);
    await client.load([60000]);
    world.answerItem({ entry: 60000, name: "Первое имя" });
    assert.equal(client.get(60000)?.name, "Первое имя");

    await client.load([60000]);
    assert.deepEqual(world.sent, ["item:60000"], "nothing is re-asked while the cache stands");

    world.clearCache();
    await client.load([60000]);
    assert.deepEqual(world.sent, ["item:60000", "item:60000"]);
    world.answerItem({ entry: 60000, name: "Второе имя" });
    assert.equal(client.get(60000)?.name, "Второе имя");
  } finally {
    gateway.restore();
  }
});

test("the clear also lets go of the cooldown a failed item fetch armed", async () => {
  // The item client holds a second thing the creature client does not: `#retryAfter`, the five
  // seconds a failed fetch is not retried for, which exists because a player's visible equipment is
  // asked for once a frame. An entry sitting in that cooldown when the realm says its data moved
  // would go on being skipped by `load` — the world query is behind the same filter — so the clear
  // has to drop both maps and not only `#requested`.
  const world = session();
  const original = globalThis.fetch;
  try {
    const client = new ItemMetadataClient(GATEWAY);
    client.attach(world, () => undefined);
    globalThis.fetch = async () => { throw new Error("gateway down"); };
    await assert.rejects(client.load([60000]));
    assert.deepEqual(world.sent, ["item:60000"], "the query still went out; it is the fetch that failed");

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
    assert.equal(await client.load([60000]), false, "and the cooldown holds while the cache stands");

    world.clearCache();
    await client.load([60000]);
    assert.deepEqual(world.sent, ["item:60000", "item:60000"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("an answer that arrives before the dump is not overwritten by it", async () => {
  // The query goes out before the fetch, so on a fast realm and a slow gateway the two land in
  // that order. Whichever way round they arrive, the wire is the newer of the two.
  const world = session();
  const original = globalThis.fetch;
  try {
    const client = new CreatureMetadataClient(GATEWAY);
    client.attach(world, () => undefined);
    globalThis.fetch = async () => {
      world.answerCreature({ entry: 299, name: "Кобольд-вредитель", subName: "" });
      return { ok: true, status: 200, json: async () => [{ entry: 299, name: "Kobold Vermin", subname: "", type: 7, family: 0, rank: 0 }] };
    };
    await client.load([299]);
    assert.equal(client.get(299)?.name, "Кобольд-вредитель");
    assert.equal(client.get(299)?.type, 7, "and the dump's row is still underneath it");
  } finally {
    globalThis.fetch = original;
  }
});

/** A connection that can be fed a packet after `loginCharacter` has returned. */
function fakeConnection(packets) {
  const queue = [...packets];
  let pending;
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) {
      this.sent.push({ opcode, payload });
    },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { pending = resolve; });
    },
    feed(packet) {
      if (!pending) {
        queue.push(packet);
        return;
      }
      const resolve = pending;
      pending = undefined;
      resolve(packet);
    },
    close() {},
  };
}

test("the world says so when it drops the query cache, not only to itself", async () => {
  // The other end of the test above: the fake session there emits `cleared` because the real one
  // does. `SMSG_CLIENTCACHE_VERSION` exists to say "the realm's static data moved, ask again", and
  // the answers no longer live only in this client — the two metadata clients hold them over the
  // top of the gateway's dumps. A clear nobody is told about leaves those two holding entries this
  // packet has just invalidated, and never asking for them again.
  const connection = fakeConnection([
    { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(4).toUint8Array() },
  ]);
  const client = new WorldClient(connection);
  await client.loginCharacter(1n);
  await new Promise((settle) => setImmediate(settle));

  const heard = [];
  client.events.on("QUERY_CACHE_CHANGED", (change) => heard.push(change));
  client.creatureTemplate(45000);
  const asked = connection.sent.filter((packet) => packet.opcode === OPCODES.CMSG_CREATURE_QUERY).length;
  assert.equal(asked, 1);

  connection.feed({ opcode: OPCODES.SMSG_CLIENTCACHE_VERSION, payload: new PacketWriter().u32(7).toUint8Array() });
  await new Promise((settle) => setImmediate(settle));
  assert.deepEqual(heard, [{ kind: "cleared", id: 0 }]);

  // And the clear is real: the entry may be asked about again.
  client.creatureTemplate(45000);
  assert.equal(connection.sent.filter((packet) => packet.opcode === OPCODES.CMSG_CREATURE_QUERY).length, 2);
});

test("without a world attached the dump is still the whole answer", async () => {
  // The clients are built before the session is; a panel that reads one between worlds, or a
  // gateway-only page, must not fall over because there is nothing to ask.
  const gateway = dump(new Map([[299, { entry: 299, name: "Kobold Vermin", subname: "", type: 7, family: 0, rank: 0 }]]));
  try {
    const client = new CreatureMetadataClient(GATEWAY);
    await client.load([299]);
    assert.equal(client.get(299)?.name, "Kobold Vermin");
  } finally {
    gateway.restore();
  }
});
