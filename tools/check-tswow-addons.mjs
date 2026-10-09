/** Checks our generated TSWoW modules from the same archive chain used by the gateway. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { clientDirectory } from "./paths.mjs";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { frameXmlAddonModules, FRAMEXML_TOC_PATH, FRAMEXML_VERTICAL_TOC } from "../dist/code/browser/framexml/FrameXmlCorpus.js";
import { CannedWorldSeam } from "../dist/code/browser/framexml/CannedWorldSeam.js";
import { discoverFrameXmlAddonEntrypoints } from "../dist/code/browser/framexml/FrameXmlAddonEntrypoints.js";

/** An in-memory server boundary: no login, live purchase or game-state mutation. */
export class TswowAddonTestTransport {
  sent = [];
  handlers = new Map();
  sendRaw(opcode, body) { this.sent.push({ opcode, body: body.slice() }); }
  on(opcode, handler) {
    const handlers = this.handlers.get(opcode) ?? new Set();
    handlers.add(handler);
    this.handlers.set(opcode, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(opcode);
    };
  }
  receive(opcode, bytes) {
    assert.ok(this.handlers.has(opcode), `No TSWoW callback for opcode ${opcode}`);
    for (const handler of this.handlers.get(opcode)) handler(bytes.slice(), opcode);
  }
}

export function doublePacket(...values) {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return bytes;
}

function stringPacket(value) {
  const text = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(text.length);
  return Buffer.concat([length, text]);
}

function descendants(frame) {
  return [frame, ...frame.children.flatMap(descendants)];
}

/** The value of one Lua expression in the booted VM, for scenarios that read add-on state. */
export function luaProbe(boot, expression) {
  const chunk = boot.vm.compileFunction(`return ${expression}`, "@tswow-addon-scenario", []);
  assert.ok(chunk, `probe does not compile: ${expression}`);
  try {
    return boot.vm.call(chunk, [], 1)[0];
  } finally {
    boot.vm.release(chunk);
  }
}

/** Add a scenario here when adding behavior to a module; unknown modules cannot silently pass. */
export const TSWOW_ADDON_SCENARIOS = {
  "baja-echoes": ({ command, visible, sent }) => {
    command("echoes");
    visible("BajaEchoCollection");
    sent(86, doublePacket(0));
    return "collection command opens its frame and sends OP86";
  },
  "base-building": ({ command, visible, sent }) => {
    command("base");
    visible("BaseBuildingFrame");
    sent(52, doublePacket(0));
    return "base command opens its frame and requests OP52 state";
  },
  "custom-companions": ({ command, visible, sent, boot, packets }) => {
    command("companions");
    const collection = visible("CustomCompanionsFrame");
    sent(64, doublePacket(3));
    // Two records catch the field shift produced by a legacy OP65 reply to a v3 client.
    // Opening an empty window alone misses broken names, model entries and summon actions.
    const companions = [[101, 123, "Лесной волк"], [202, 456, "Медведь"]];
    packets.receive(91, Buffer.concat([
      doublePacket(3, 0, companions.length),
      ...companions.flatMap(([id, entry, name]) => [
        doublePacket(id, entry), stringPacket(name),
        doublePacket(0.95, 0, 0, -1, 0, 0, 0, 1, 2, 0, 1, 0),
      ]),
    ]));
    const workforce = packets.sent.findLast((packet) => packet.opcode === 95);
    assert.ok(workforce, "Companions did not request base assignments");
    const token = new DataView(workforce.body.buffer, workforce.body.byteOffset,
      workforce.body.byteLength).getFloat64(40, true);
    assert.ok(token >= 1_000_000_000, "Companion workforce request must select OP99 replies");
    packets.receive(99, doublePacket(1, token, 0));
    const frames = descendants(collection);
    for (const [id, entry, name] of companions) {
      const title = frames.find((frame) => frame.text === name);
      assert.ok(title, `Companion name ${name} is missing or corrupted`);
      const card = title.parent;
      const action = descendants(card).find((frame) => frame.text === "Призвать");
      assert.ok(action?.parent?.enabled, `${name}: summon action is unavailable`);
      boot.bridge.Click(action.parent);
      sent(66, doublePacket(id));
      boot.bridge.fireScript(card, "OnMouseDown", "LeftButton");
      assert.equal(boot.bridge.getFrame("CompanionPreviewModel")?.model.creatureEntry,
        entry, `${name}: preview uses the wrong creature entry`);
    }
    return "OP91 preserves both names; OP99 enables summon, OP66 carries each ID, and previews select each creature";
  },
  "custom-stats": ({ boot, packets, command, sent }) => {
    sent(50, doublePacket(0));
    packets.receive(51, doublePacket(123, 234, 345, 1.2, 2.3, 3.4));
    const panel = boot.bridge.getFrame("CustomStatsCharacterPanel");
    assert.ok(panel, "CustomStatsCharacterPanel was not initialized");
    const text = descendants(panel).map((frame) => frame.text).join("\n");
    for (const value of [123, 234, 345]) assert.ok(text.includes(String(value)), `Stats UI did not receive ${value}`);
    command("mystats");
    return "OP51 updates all three stat rows; mystats command executes";
  },
  "gem-abilities": ({ command, visible, boot, sent }) => {
    // The default canned equipment has no chest item. Socketing must use an actual selected
    // fixture item, rather than opening an extraction action for an empty slot.
    boot.seam.setInventoryItem(5, { entry: 1234, name: "Socketed test chest", count: 1,
      texture: "Interface\\Icons\\INV_Chest_Cloth_17" });
    command("socket", "chest");
    const frame = visible("ItemSocketingFrame");
    const button = boot.bridge.getFrame("GemAbilitiesExtractButton");
    assert.ok(button, "Ability-gem extraction button is missing");
    assert.equal(boot.bridge.getFrame("ItemSocketingFrameItemName").text, "Socketed test chest");
    boot.bridge.Click(button);
    sent(85, doublePacket(0, 0, 5));
    assert.equal(boot.bridge.isVisible(frame), false, "Extraction did not close the item window");
    return "socket command selects the chest; the original extraction button sends OP85 and closes";
  },
  // Written before the module is built (9.07): it runs once minimap-hub is in the TOC, and from
  // then on a hub without it fails the check. Its consumers register from PLAYER_ENTERING_WORLD.
  "minimap-hub": ({ boot, command, visible }) => {
    if (luaProbe(boot, "#TswowMinimapHub.list()") === 0) boot.bridge.dispatchEvent("PLAYER_ENTERING_WORLD");
    const ids = String(luaProbe(boot, `(function() local t = {}
      for _, e in ipairs(TswowMinimapHub.list()) do t[#t + 1] = e.id end
      return table.concat(t, ",") end)()`)).split(",").filter(Boolean);
    for (const consumer of ["baja-echoes", "base-building", "custom-companions"]) {
      assert.ok(ids.some((id) => id.startsWith(`${consumer}.`)), `${consumer} did not register in the hub`);
    }
    visible("TswowMinimapHubButton");
    for (const legacy of ["BajaEchoCollectionMinimapButton", "BaseBuildingMinimapButton", "CustomCompanionsMinimapButton"]) {
      assert.ok(!boot.bridge.getFrame(legacy), `${legacy} exists next to the hub (stale publish?)`);
    }
    command("hub");
    visible("TswowMinimapHubPanel");
    return `hub holds ${ids.length} entries; /hub opens the panel; no legacy buttons`;
  },
  "retail-talents": ({ command, visible, sent }) => {
    command("utalent");
    visible("UniversalTalentFrame");
    sent(40, doublePacket(0));
    return "talent command opens the TSWoW window and requests OP40 state";
  },
  "simple-button-addon": ({ command, visible }) => {
    command("simplebutton");
    visible("SimpleTalentWindow");
    return "simplebutton command initializes and opens the preview";
  },
  "survival": ({ visible, packets, sent }) => {
    sent(60, doublePacket(0));
    packets.receive(61, doublePacket(72, 38));
    const bars = descendants(visible("SurvivalFrame")).filter((frame) => frame.type === "StatusBar");
    assert.deepEqual(bars.map((frame) => frame.statusBar.value), [72, 38]);
    packets.receive(61, doublePacket(20, 15));
    assert.deepEqual(bars.map((frame) => frame.statusBar.value), [20, 15]);
    return "OP60 request, OP61 updates both bars and crosses warning thresholds";
  },
  "tswow-store": ({ entrypoints, visible, packets, sent }) => {
    sent(0);
    sent(4);
    const button = entrypoints.menuButtons.find((entry) => entry.module === "tswow-store");
    assert.ok(button, "The TSWoW store has no browser menu entry");
    button.run();
    const shop = visible("ShopMainFrame");
    const points = new Uint8Array(4);
    new DataView(points.buffer).setUint32(0, 12345, true);
    packets.receive(3, points);
    assert.ok(descendants(shop).some((frame) => frame.text === "12345"), "Store points did not update");
    return "original menu action opens the shop; OP3 updates account points";
  },
};

export async function checkTswowAddons({ provider, locale = "ruRU", scenarios = TSWOW_ADDON_SCENARIOS } = {}) {
  let chain;
  if (!provider) {
    const { clientArchives } = await import("./mpq.mjs");
    chain = await clientArchives(clientDirectory());
    const decoder = new TextDecoder("utf-8", { fatal: true });
    provider = { async read(path) {
      const bytes = await chain.read(path);
      return bytes ? decoder.decode(bytes) : undefined;
    } };
  }
  const packets = new TswowAddonTestTransport();
  const boot = new FrameXmlBoot({
    provider, locale, subset: FRAMEXML_VERTICAL_TOC, includeActiveTsAddons: true,
    seam: new CannedWorldSeam(), clientNetwork: packets,
  });
  let entrypoints;
  try {
    const declared = frameXmlAddonModules(await provider.read(FRAMEXML_TOC_PATH) ?? "");
    assert.ok(declared.length, "No TSWoW modules in the active FrameXML.toc; check the selected client and build addon");
    const inventory = await boot.load();
    entrypoints = discoverFrameXmlAddonEntrypoints(boot);
    const results = [];
    for (const name of declared) {
      const module = name.toLowerCase();
      const load = boot.tsAddonResults.find((result) => result.module === module);
      const errorsBefore = boot.errorCount;
      let sentSince = 0;
      try {
        assert.ok(load?.ok, load?.errors.join("\n") || "Incomplete TSWoW TOC block");
        assert.ok(Object.hasOwn(scenarios, module), "No behavior scenario: add this module to TSWOW_ADDON_SCENARIOS");
        const message = await scenarios[module]({
          boot, packets, entrypoints,
          command(name, rest = "") {
            const entry = entrypoints.commands.find((entry) => entry.module === module && entry.name === name);
            assert.ok(entry, `/${name} is not registered by the generated ${module} Lua`);
            sentSince = packets.sent.length;
            entry.run(rest);
          },
          visible(name) {
            const frame = boot.bridge.getFrame(name);
            assert.ok(frame && boot.bridge.isVisible(frame), `${name} is absent or hidden`);
            return frame;
          },
          sent(opcode, body) {
            assert.ok(packets.sent.slice(sentSince).some((packet) => packet.opcode === opcode
              && (!body || Buffer.from(packet.body).equals(Buffer.from(body)))), `No expected OP${opcode} request`);
          },
        });
        assert.equal(boot.errorCount, errorsBefore, boot.errors.map((error) => `${error.file}: ${error.message}`).join("\n"));
        results.push({ module, ok: true, files: load.loaded.length, message });
      } catch (error) {
        results.push({ module, ok: false, files: load?.loaded.length ?? 0, message: error.message });
      }
    }
    return {
      ok: inventory.files.missing.length === 0 && boot.errorCount === 0 && results.every((result) => result.ok),
      locale, results, missing: inventory.files.missing, errors: boot.errors,
      scope: "Generated TSWoW Lua, browser entrypoint adapters and scripted packet/UI scenarios with an in-memory server. Live gameplay and visual rendering require a browser check.",
    };
  } finally {
    entrypoints?.close();
    boot.close();
    chain?.close();
    assert.equal(packets.handlers.size, 0, "TSWoW packet subscriptions survived teardown");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const json = process.argv.includes("--json");
  // StormLib reports initialization to console.log; keep JSON stdout machine-readable.
  if (json) console.log = console.info = console.error.bind(console);
  const report = await checkTswowAddons({ locale: process.env.CLIENT_LOCALE ?? "ruRU" });
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const result of report.results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.module}: ${result.message}`);
    for (const error of report.errors) console.error(`${error.file}:${error.line}: ${error.message}`);
    if (report.missing.length) console.error(`Missing files: ${report.missing.join(", ")}`);
    console.log(`${report.results.filter((result) => result.ok).length}/${report.results.length} TSWoW behavior scenarios passed (${report.locale}).`);
    console.log(report.scope);
  }
  process.exitCode = report.ok ? 0 : 1;
}
