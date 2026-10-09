import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INBOUND_OPCODES, OUTBOUND_OPCODES } from "../dist/code/generated/opcodeCoverage.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { OPCODE_BACKLOG } from "../dist/code/world/OpcodeBacklog.js";

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Opcodes this client names in its own code. `WorldClient` dispatches through a chain of
 * `packet.opcode === OPCODES.X` comparisons rather than a table, so until that chain becomes a
 * registry, naming an opcode is the closest thing to declaring a handler for it. A name reached
 * only through a dead branch would pass this
 * check; the acceptance run catches those by leaving the packet in
 * `webclientUnhandledOpcodes()`.
 */
async function namedOpcodes(directory = sourceDir, names = new Set()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "generated") await namedOpcodes(path, names);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    for (const match of (await readFile(path, "utf8")).matchAll(/OPCODES\.([A-Z][A-Z0-9_]+)/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

const live = () => [...INBOUND_OPCODES].filter(([, reach]) => reach === "live").map(([name]) => name);

test("every opcode this core sends is either handled or owned by a plan slice", async () => {
  const named = await namedOpcodes();
  const orphans = live().filter((name) => !named.has(name) && !OPCODE_BACKLOG.has(name));

  assert.deepEqual(
    orphans,
    [],
    "these arrive from the server and nothing claims them: handle them, or list them in src/world/OpcodeBacklog.ts",
  );
});

test("the backlog holds only opcodes that are still missing", async () => {
  const named = await namedOpcodes();
  const done = [...OPCODE_BACKLOG.keys()].filter((name) => named.has(name));

  assert.deepEqual(done, [], "strike these off src/world/OpcodeBacklog.ts: the client handles them now");
});

test("the backlog names only opcodes this core actually sends", () => {
  const stale = [...OPCODE_BACKLOG.keys()].filter((name) => INBOUND_OPCODES.get(name) !== "live");

  assert.deepEqual(stale, [], "the core no longer sends these, so they are not work: drop them from the backlog");
});

test("the client sends nothing the server refuses", async () => {
  const named = await namedOpcodes();
  // CMSG_ only: that family is client-to-server by definition, so naming one can only mean sending
  // it. MSG_ goes both ways — MSG_CHANNEL_START is sent by the server and refused from a client —
  // and naming one says nothing about which direction this client uses it in.
  const refused = [...named].filter((name) => name.startsWith("CMSG_") && !OUTBOUND_OPCODES.has(name));

  assert.deepEqual(refused, [], "the core answers these with no handler at all");
});

test("the custom-packet transport names both tswow opcodes, and the core still agrees on them", async () => {
  // tswow's two numbers (`CustomPacketDefines.h:27-31`) are borrowed from the CMSG_ family, which
  // is why nothing else in this file would notice them: the classifier calls both outbound, so the
  // ratchet's inbound walk never asks for a 0x102 handler even though the server sends it. This is
  // the check that says the transport is still wired to the opcodes it thinks it is.
  const named = await namedOpcodes();

  assert.ok(named.has("CMSG_EMOTE"), "nothing in src/ names the opcode tswow sends custom packets on");
  assert.ok(named.has("CMSG_CUSTOM"), "nothing in src/ names the opcode tswow expects them back on");
  assert.equal(OPCODES.CMSG_EMOTE, 0x102);
  assert.equal(OPCODES.CMSG_CUSTOM, 0x51f);
  assert.equal(OUTBOUND_OPCODES.has("CMSG_EMOTE"), true);
  assert.equal(OUTBOUND_OPCODES.has("CMSG_CUSTOM"), true);
  assert.equal(INBOUND_OPCODES.has("CMSG_EMOTE"), false, "if the core starts declaring 0x102 inbound, the branch needs revisiting");
});

test("coverage is measured against a whole protocol, not a fragment", () => {
  // A silently truncated scan would make every check above pass by having nothing to check.
  assert.ok(INBOUND_OPCODES.size > 600, `only ${INBOUND_OPCODES.size} inbound opcodes classified`);
  assert.ok(OUTBOUND_OPCODES.size > 400, `only ${OUTBOUND_OPCODES.size} outbound opcodes classified`);
  assert.ok(live().length > 450, `only ${live().length} inbound opcodes are live`);
});

// ---- 5.29: opcodes accepted on purpose without an effect (src/world/IgnoredOpcodes.ts) ----------

const { IGNORED_OPCODES } = await import("../dist/code/world/IgnoredOpcodes.js");
const worldClientPath = join(sourceDir, "world", "WorldClient.ts");
const backlogPath = join(sourceDir, "world", "OpcodeBacklog.ts");
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** Every `if (packet.opcode === OPCODES.A || … ) { … }` branch of WorldClient with its body. */
async function worldClientBranches() {
  const source = await readFile(worldClientPath, "utf8");
  const opener = /if \(packet\.opcode === OPCODES\.([A-Z0-9_]+)((?:\s*\|\|\s*packet\.opcode === OPCODES\.[A-Z0-9_]+)*)\)\s*\{/g;
  const branches = [];
  let match;
  while ((match = opener.exec(source)) !== null) {
    const names = [match[1], ...[...match[2].matchAll(/OPCODES\.([A-Z0-9_]+)/g)].map((entry) => entry[1])];
    let depth = 1;
    let index = opener.lastIndex;
    while (depth > 0 && index < source.length) {
      const ch = source[index++];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    branches.push({ names, body: stripComments(source.slice(opener.lastIndex, index - 1)).replace(/\s+/g, " ").trim() });
  }
  return branches;
}

/** The four movement relays sit in an `else if` chain of `#dispatch`, not in an `if` of their own. */
const DISPATCH_CHAIN_IGNORED = ["MSG_MOVE_ROOT", "MSG_MOVE_UNROOT", "MSG_MOVE_SET_COLLISION_HGT",
  "MSG_MOVE_UPDATE_CAN_TRANSITION_BETWEEN_SWIM_AND_FLY", "MSG_MOVE_TIME_SKIPPED"];

test("5.29 every ignored opcode is an inbound opcode with a reason, and a plan item when planned", async () => {
  const plan = await readFile(join(sourceDir, "..", "docs", "WORK_PLAN.ru.md"), "utf8");
  for (const [name, entry] of IGNORED_OPCODES) {
    const reach = INBOUND_OPCODES.get(name);
    assert.ok(reach !== undefined, `${name} is not an inbound opcode`);
    if (entry.kind !== "by-design") assert.equal(reach, "live", `${name}: only a live opcode can be a gap or planned work`);
    assert.ok(entry.reason.trim().length > 10, `${name} needs a reason`);
    assert.ok(["by-design", "planned", "unplanned"].includes(entry.kind), `${name}: kind ${entry.kind}`);
    if (entry.kind === "planned") {
      assert.match(entry.plan ?? "", /^\d+\.\d{2}$/, `${name}: a planned entry names its WORK_PLAN item`);
      assert.ok(plan.includes(`**${entry.plan}**`), `${name}: WORK_PLAN has no item ${entry.plan}`);
    } else {
      assert.equal(entry.plan, undefined, `${name}: only a planned entry carries a plan item`);
    }
    assert.equal(OPCODE_BACKLOG.has(name), false, `${name} cannot be both missing and ignored`);
  }
});

test("5.29 no WorldClient branch drops a packet silently: every effect-free branch goes through #ignore", async () => {
  const bare = (await worldClientBranches())
    // A body that only parses, with or without `return true`, or nothing at all: the `else if`
    // chain of #dispatch needs no return, so a parse-only branch there drops the packet too.
    .filter(({ body }) => /^(?:(?:const [a-zA-Z]+ = )?(?:void )?parse[A-Za-z]+\([^;]*\);?)? ?(?:return(?: true)?;?)?$/.test(body))
    .map(({ names }) => names.join(","));
  assert.deepEqual(bare, [], "answer these with `return this.#ignore(packet)` and list them in IGNORED_OPCODES, or give them an effect");
});

test("5.29 the registry and the #ignore branches name the same opcodes", async () => {
  const branches = await worldClientBranches();
  const ignoring = new Set(DISPATCH_CHAIN_IGNORED);
  for (const { names, body } of branches) {
    if (/^(?:(?:const [a-zA-Z]+ = )?parse[A-Za-z]+\([^;]*\); )?return this\.#ignore\(packet\);?$/.test(body)) {
      for (const name of names) ignoring.add(name);
    }
  }
  const source = await readFile(worldClientPath, "utf8");
  assert.match(source, /MSG_MOVE_UPDATE_CAN_TRANSITION_BETWEEN_SWIM_AND_FLY\) \{[\s\S]{0,900}?this\.#ignore\(packet\);\s*return;/,
    "the four never-built movement relays are counted too");
  assert.match(source, /OPCODES\.MSG_MOVE_TIME_SKIPPED\) \{[\s\S]{0,400}?parseMovementTimeSkipped\(packet\.payload\);\s*this\.#ignore\(packet\);/,
    "the time-skip relay is counted too");
  assert.deepEqual([...ignoring].filter((name) => !IGNORED_OPCODES.has(name)), [], "ignored without a registry entry");
  assert.deepEqual([...IGNORED_OPCODES.keys()].filter((name) => !ignoring.has(name)), [],
    "registry entries whose branch no longer ignores them: strike them off (the effect landed)");
});

test("5.29 the registry only shrinks, and the accounting in OpcodeBacklog.ts is the measured one", async () => {
  // Ratchet: lower this when an entry is struck off; never raise it to make room. 37 → 38 on
  // 2026-10-01 was a correction of the measurement (MSG_MOVE_TIME_SKIPPED parsed and dropped in the
  // #dispatch chain, invisible to the bare-branch pattern), not room for a new gap.
  // 38 → 36 on 2026-10-02: SMSG_SPELLLOGEXECUTE and SMSG_ENCHANTMENTLOG feed the combat log (3.01).
  // 36 → 31 on 2026-10-02: five 5.22 handlers got their Wow.exe reaction (SERVER_FIRST_ACHIEVEMENT
  // stays, reclassified by design: its only effect is a chat line).
  // 05.10-A7a-H: 31 → 30 — SMSG_MIRRORIMAGE_DATA struck off, it now dresses the unit (6.11б).
  assert.ok(IGNORED_OPCODES.size <= 30, `${IGNORED_OPCODES.size} ignored opcodes, more than the 30 recorded on 2026-10-05`);
  const liveNames = live();
  const ignoredLive = [...IGNORED_OPCODES].filter(([name]) => INBOUND_OPCODES.get(name) === "live");
  const byKind = (kind) => ignoredLive.filter(([, entry]) => entry.kind === kind).length;
  const measured = {
    live: liveNames.length,
    effect: liveNames.length - ignoredLive.length,
    byDesign: byKind("by-design"),
    planned: byKind("planned"),
    unplanned: byKind("unplanned"),
  };
  const header = await readFile(backlogPath, "utf8");
  const claim = header.match(/(\d+) live inbound opcodes: (\d+) with an effect, (\d+) without one by design, (\d+) planned, (\d+) without a plan item/);
  assert.ok(claim, "OpcodeBacklog.ts states the accounting in the measured form");
  assert.deepEqual({
    live: Number(claim[1]), effect: Number(claim[2]), byDesign: Number(claim[3]), planned: Number(claim[4]), unplanned: Number(claim[5]),
  }, measured, "update the numbers in the OpcodeBacklog.ts header (and docs/CLIENT_PARITY_PLAN.ru.md §2)");
});
