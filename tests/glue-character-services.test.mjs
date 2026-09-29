import assert from "node:assert/strict";
import test from "node:test";
import {
  CHARACTER_FLAG_RENAME, RESPONSE_SUCCESS, WorldAuthError, buildRenameCharacter, characterNeedsRename,
  parseRenameResult,
} from "../dist/code/world/CharacterProtocol.js";

/**
 * The paid-service and forced-name packets of the character screen, byte for byte against the core:
 * CMSG_CHAR_RENAME is read as `ObjectGuid >> Name` (CharacterHandler.cpp:1137-1142) — a full u64,
 * not a packed guid — and SMSG_CHAR_RENAME is `u8 result`, then, on RESPONSE_SUCCESS only, the guid
 * and the name the core normalised (SendCharRename, CharacterHandler.cpp:2206-2216).
 */

const utf8 = (text) => [...new TextEncoder().encode(text)];

test("CMSG_CHAR_RENAME is a full u64 guid and a zero-terminated name", () => {
  assert.deepEqual([...buildRenameCharacter(0x1234n, "Новое")],
    [0x34, 0x12, 0, 0, 0, 0, 0, 0, ...utf8("Новое"), 0]);
  // The high half of the guid is on the wire too: a player guid is not a u32.
  assert.deepEqual([...buildRenameCharacter(0x0102030405060708n, "A")],
    [8, 7, 6, 5, 4, 3, 2, 1, 0x41, 0]);
});

test("SMSG_CHAR_RENAME is the result alone on a refusal, and the new name on success", () => {
  assert.deepEqual({ ...parseRenameResult(Uint8Array.of(89)) }, { result: 89 });
  assert.equal(RESPONSE_SUCCESS, 0);
  const success = parseRenameResult(Uint8Array.of(0, 0x34, 0x12, 0, 0, 0, 0, 0, 0, ...utf8("Ана"), 0));
  assert.equal(success.result, RESPONSE_SUCCESS);
  assert.equal(success.guid, 0x1234n);
  assert.equal(success.name, "Ана");
  // Anything past what the core writes is a packet this client misread.
  assert.throws(() => parseRenameResult(Uint8Array.of(89, 0)));
  assert.throws(() => parseRenameResult(Uint8Array.of(0, 0x34, 0x12, 0, 0, 0, 0, 0, 0, ...utf8("Ана"), 0, 7)));
});

test("a character the core has marked for a new name carries CHARACTER_FLAG_RENAME in the list", () => {
  // Player.cpp:161 and :1545-1546: AT_LOGIN_RENAME becomes this bit of SMSG_CHAR_ENUM's flags.
  assert.equal(CHARACTER_FLAG_RENAME, 0x4000);
  assert.equal(characterNeedsRename({ flags: 0x4000 }), true);
  assert.equal(characterNeedsRename({ flags: 0x2000 | 0x4000 | 0x400 }), true);
  assert.equal(characterNeedsRename({ flags: 0x2000 | 0x400 }), false, "ghost and hidden helm are not a rename");
});

test("a refused world session is a WorldAuthError that keeps the core's code", () => {
  const error = new WorldAuthError(14);
  assert.ok(error instanceof Error);
  assert.equal(error.code, 14);
  assert.equal(error.name, "WorldAuthError");
  assert.equal(new WorldAuthError(undefined).code, undefined, "an empty SMSG_AUTH_RESPONSE has no code");
});
