import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 5.28 ratchet: public `WorldClient` state that is written and read nowhere — not by the browser,
 * not by WorldClient itself. A field read nowhere is a parse whose result is dropped; it may stay
 * only on this list, with the plan item or the reason that keeps it. The test fails when a new
 * unread field appears and when a listed field gains a reader (strike it off).
 *
 * "Read" is textual: `.name` not followed by an assignment or by `.set/.add/.delete/.clear/.push(`.
 * A field whose only consumer is an event emitted beside it is listed with that event.
 */
const ALLOWED_UNREAD = new Map([
  ["spiritHealerConfirm", "mirror of SPIRIT_HEALER_CONFIRM, which FrameXmlPopups consumes"],
  ["realGroup", "no plan item: SMSG_REAL_GROUP_UPDATE has no consumer yet"],
  ["lfgDisabled", "mirror of LFG_STATE_CHANGED { kind: \"disabled\" }"],
  ["projectiles", "6.12: projectile flight (SpellVisuals*, after 0.6)"],
  ["battlegroundPlayers", "5.28: the only stock consumer is the join/leave chat line, and chat is out of the plan"],
  ["lastHonorKill", "mirror of HONOR_AWARDED"],
  ["honorThisSession", "no plan item: the session honor total of the PvP frame"],
  ["accountDataTimes", "no plan item: account data is answered per blob, the time table is unused"],
  ["realmSplit", "no plan item: realm split state has no consumer yet"],
  ["addonInfo", "no plan item: the server's verdict on declared addons has no consumer yet"],
  ["wardenPackets", "diagnostic counter; Warden is off on this realm"],
  ["characterService", "mirror of CHARACTER_SERVICE"],
  ["openPageObject", "mirror of ITEM_TEXT_OPENED { kind: \"object\" }"],
  ["corpseMapPosition", "5.25: requestCorpseMapPosition has no caller yet"],
  ["petComboPoints", "no plan item: a charmed pet's combo points"],
  ["petMessage", "no plan item: the pet's last feedback line has no reader"],
  ["pvpMessage", "no plan item: the last PvP message has no reader"],
]);

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

async function sources(directory = sourceDir, out = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "generated") await sources(path, out);
    } else if (entry.name.endsWith(".ts") && entry.name !== "WorldClient.ts") {
      out.push(await readFile(path, "utf8"));
    }
  }
  return out;
}

async function unreadFields() {
  const client = await readFile(join(sourceDir, "world", "WorldClient.ts"), "utf8");
  const body = client.slice(client.indexOf("export class WorldClient"));
  const fields = new Set();
  for (const match of body.matchAll(/^ {2}(?:readonly )?([a-z][A-Za-z0-9]*)\??(?:: [^=;\n(]+)?(?: = [^\n]*)?;$/gm)) fields.add(match[1]);
  for (const match of body.matchAll(/^ {2}(?:readonly )?([a-z][A-Za-z0-9]*)\??: [^\n(]*$/gm)) fields.add(match[1]);
  const all = [...await sources(), body].join("\n");
  const read = (name) => new RegExp(`\\.${name}\\b(?!\\s*=[^=]|\\s*(?:\\+\\+|--|\\+=|-=)|\\.(?:set|add|delete|clear|push)\\()`).test(all);
  return { fields, unread: [...fields].filter((name) => !/^on[A-Z]/.test(name) && !read(name)) };
}

test("5.28 the scan sees WorldClient's public state", async () => {
  const { fields } = await unreadFields();
  // A broken pattern would find nothing and pass everything below.
  for (const name of ["attacking", "lootOwners", "itemTexts", "taxiNodeStatus", "instanceDifficulty", "tutorialFlags"]) {
    assert.ok(fields.has(name), `the field scan lost ${name}`);
  }
  assert.ok(fields.size > 150, `only ${fields.size} fields found`);
});

test("5.28 no WorldClient state is written and read nowhere, outside the list", async () => {
  const { unread } = await unreadFields();
  assert.deepEqual(unread.filter((name) => !ALLOWED_UNREAD.has(name)), [],
    "give these a reader (an event, an accessor someone calls) or list them with a plan item");
});

test("5.28 the list holds only fields that are still unread, each with its reason", async () => {
  const { fields, unread } = await unreadFields();
  const stillUnread = new Set(unread);
  for (const [name, reason] of ALLOWED_UNREAD) {
    assert.ok(fields.has(name), `${name} is no longer a WorldClient field: strike it off`);
    assert.ok(stillUnread.has(name), `${name} has a reader now: strike it off the list`);
    assert.ok(reason.length > 10, `${name} needs its reason`);
  }
});
