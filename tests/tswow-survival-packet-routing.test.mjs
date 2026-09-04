import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const install = resolve(process.env.TSWOW_INSTALL
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../tswow-install"));
let fixture;
try {
  const require = createRequire(resolve(install, "package.json"));
  const ts = require("typescript");
  const source = await readFile(resolve(install, "modules/survival/livescripts/survival.ts"), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
  }).outputText;
  const exports = {};
  runInNewContext(output, {
    exports, UTAG: () => 1, GetUnixTime: () => 1000,
    require(id) {
      if (id === "../shared/SurvivalMessages") return { OP_SURVIVAL_REQUEST: 60, SurvivalState: class {} };
      if (id === "./survival-db") return { SurvivalData: class {} };
      throw new Error(`Unexpected survival import: ${id}`);
    },
  });
  fixture = exports;
} catch (error) {
  if (error.code !== "ENOENT" && error.code !== "MODULE_NOT_FOUND") throw error;
}

test("survival leaves companion negotiation, summon IDs and workforce tokens intact", {
  skip: fixture ? false : "active TSWoW survival module is not installed",
}, () => {
  const globalListeners = [];
  const listeners = new Map();
  const noop = () => {};
  fixture.RegisterSurvival({
    GameObject: { OnGossipHello: noop }, Creature: { OnGenerateLoot: noop },
    Player: { OnLogin: noop, OnSave: noop }, Spell: { OnAfterCast: noop },
    CustomPacket: { OnReceive(opcode, callback) {
      if (typeof opcode === "function") globalListeners.push(opcode);
      else listeners.set(opcode, [...listeners.get(opcode) ?? [], callback]);
    } },
  });
  assert.equal(listeners.get(60)?.length, 1, "the survival request must still be registered");

  // TSServerBuffer::OnPacket dispatches global Lua listeners before opcode-specific ones.
  // The installed CustomPacketBase::Reset also sets m_size=0, so a global observer causes
  // subsequent ReadDouble calls to return their default even if it never reads the payload.
  // Exercise the real module's registrations at that native dispatch boundary.
  for (const [opcode, values] of [[64, [3]], [66, [101]], [95, [0, 0, 0, 0, 0, 1_000_000_001]]]) {
    let size = values.length * 8;
    let offset = 0;
    const packet = {
      Size: () => size,
      ReadDouble() { return offset * 8 + 8 <= size ? values[offset++] : 0; },
    };
    for (const callback of globalListeners) {
      callback(opcode, packet, { SendBroadcastMessage: noop });
      size = 0;
      offset = 0;
    }
    assert.deepEqual(values.map(() => packet.ReadDouble()), values,
      `OP${opcode}: survival must not erase another module's request payload`);
  }
  assert.equal(globalListeners.length, 0, "survival must only observe its own opcode");
});
