import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { interfaceDirectory } from "../tools/paths.mjs";
import { doublePacket } from "../tools/check-tswow-addons.mjs";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { FRAMEXML_VERTICAL_TOC } from "../dist/code/browser/framexml/FrameXmlCorpus.js";
import { CannedWorldSeam } from "../dist/code/browser/framexml/CannedWorldSeam.js";
import { CustomPacketRegistry } from "../dist/code/world/CustomPacketRegistry.js";

// 9.03 review, lens A: the owner's real module add-ons, as the dataset ships them (FrameXML.toc with
// its tsaddon blocks, the generated Lua, the real RequireStub/ClientNetwork), unmodified. Module
// messages that arrive while the Lua is still loading are held by the world's real registry and
// reach each module's own OnCustomPacket exactly once, in arrival order, after `consumerReady`; a
// ReloadUI (the old VM closed, a fresh one loaded on the same world) replays none of them, and a
// live message after it reaches one subscriber, not two.

let corpus;
try {
  const root = dirname(interfaceDirectory());
  const toc = await readFile(join(root, "Interface/FrameXML/FrameXML.toc"), "utf8");
  if (/##\s*tsaddon-begin:/i.test(toc)) {
    corpus = { async read(path) {
      try { return await readFile(join(root, path), "utf8"); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    } };
  }
} catch { /* no dataset on this machine */ }

/** Server → client opcodes of the owner's modules (their `shared/*Messages.ts`). */
const STATE_OPCODES = Object.freeze({
  "retail-talents": 41, "custom-stats": 51, "base-building": 53, survival: 61, "custom-companions": 65, "baja-echoes": 87,
});

/** Records what reached each subscriber the Lua bridge made, in delivery order. */
class RecordingRegistry extends CustomPacketRegistry {
  delivered = [];
  on(opcode, handler) {
    if (typeof opcode !== "number") return super.on(opcode, handler);
    return super.on(opcode, (body, inner) => {
      this.delivered.push(`${inner}:${new DataView(body.buffer, body.byteOffset, body.byteLength).getFloat64(0, true)}`);
      return handler(body, inner);
    });
  }
}

function boot(registry) {
  return new FrameXmlBoot({
    provider: corpus, locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, includeActiveTsAddons: true,
    seam: new CannedWorldSeam(), clientNetwork: registry,
  });
}

test("real module add-ons: held messages arrive once, in order, after the Lua is ready; ReloadUI replays none", {
  skip: corpus ? false : "the dataset's FrameXML with TSWoW add-ons is not on this machine",
}, async () => {
  const unclaimed = [];
  const registry = new RecordingRegistry({
    send() {}, schedule: () => () => {}, onBacklogUnclaimed: (opcode) => unclaimed.push(opcode),
  });
  registry.beginBacklog({ expect: ["lua"] });
  // Interleaved across modules, two per module, plus one nobody listens to.
  const sent = [];
  for (const round of [1, 2]) {
    for (const opcode of Object.values(STATE_OPCODES)) {
      assert.equal(registry.offer(opcode, doublePacket(round)), "held");
      sent.push(`${opcode}:${round}`);
    }
  }
  assert.equal(registry.offer(9999, doublePacket(0)), "held");

  const first = boot(registry);
  let second;
  try {
    await first.load();
    const failed = first.tsAddonResults.filter((result) => !result.ok).map((result) => result.module);
    assert.deepEqual(failed, [], JSON.stringify(first.tsAddonResults.filter((result) => !result.ok)));
    const subscribed = new Set(first.clientNetworkOpcodes());
    const listened = sent.filter((entry) => subscribed.has(Number(entry.split(":")[0])));
    assert.ok(new Set(listened.map((entry) => entry.split(":")[0])).size >= 4,
      `the real modules subscribe to their state opcodes: ${[...subscribed].sort((a, b) => a - b)}`);
    assert.deepEqual(registry.delivered, [], "nothing reaches a module while its Lua loads");

    registry.consumerReady("lua");
    assert.deepEqual(registry.delivered, [], "released on a microtask, after the mount's own finally");
    await Promise.resolve();
    assert.deepEqual(registry.delivered, listened, "each held message once, in arrival order");
    assert.ok(unclaimed.includes(9999), "the unlistened one is recorded as unhandled");
    assert.deepEqual(registry.backlog.queued, 0);

    // ReloadUI: the old VM goes (its subscriptions with it), a fresh one loads on the same world.
    const before = registry.delivered.length;
    first.close();
    assert.equal(registry.listenerCount, 0);
    second = boot(registry);
    await second.load();
    await Promise.resolve();
    assert.equal(registry.delivered.length, before, "the reload replays nothing it was already given");
    const live = Object.values(STATE_OPCODES).find((opcode) => second.clientNetworkOpcodes().has(opcode));
    assert.ok(live !== undefined);
    assert.equal(registry.offer(live, doublePacket(3)), "delivered");
    assert.deepEqual(registry.delivered.slice(before), [`${live}:3`], "one subscriber after the reload, not two");
  } finally {
    first.close();
    second?.close();
  }
});
