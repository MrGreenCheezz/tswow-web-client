/**
 * 3.46 (15.11): what a rename does to the character's own WTF folder (Wow.exe 3.3.5a 12340, read-only Ghidra,
 * .runtime/re-2026-11-15/misc8): the answer to CMSG_CHAR_RENAME (0x4da090) renames the list row through 0x4e2870,
 * which first moves `WTF\Account\<account>\<realmName>\<old>` to `…\<new>` (0x461c70 → MoveFile; the formats at
 * 0x9f6270 and 0x9f625c, the realm from the CVar realmName, 0x6b0dc0) and the realm-less `WTF\Account\<account>\<old>`
 * the same way, then drops the old name's add-on state table (0x5f7840) and reads the new name's from its — moved —
 * AddOns.txt (0x5f91e0). So the per-character SavedVariables and add-on states follow the character to its new name.
 * A move onto a folder that already exists fails as MoveFile does, and then nothing moves.
 *
 * Here the folder is this browser's storage: the character's AddOns.txt (GlueAddons.ts, `webclient-addons-v1`) and its
 * per-character saved variables (framexml/FrameXmlSavedVariables.ts, `webclient-addon-v2`), keyed by the account in
 * ASCII upper case, the realm's name and the character's name. There is no realm-less folder in this client.
 */

export const GLUE_ADDONS_FILE_PREFIX = "webclient-addons-v1";
export const SAVED_VARIABLES_PREFIX = "webclient-addon-v2";

/** A storage that can be walked; one without `key`/`removeItem`/`length` moves nothing. */
export type GlueRenameStorage = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem" | "key" | "length">>;

function upperAscii(text: string): string {
  return text.replace(/[a-z]/g, (letter) => letter.toUpperCase());
}

/** The character a key of the folder belongs to, as [prefix, ACCOUNT, realm, character, …]; undefined for another key. */
function folderOf(key: string, account: string, realm: string): { readonly character: string; readonly parts: unknown[] } | undefined {
  if (!key.startsWith(`["${GLUE_ADDONS_FILE_PREFIX}"`) && !key.startsWith(`["${SAVED_VARIABLES_PREFIX}"`)) return undefined;
  let parts: unknown;
  try { parts = JSON.parse(key); } catch { return undefined; }
  if (!Array.isArray(parts) || parts[1] !== account || parts[2] !== realm || typeof parts[3] !== "string") return undefined;
  return { character: parts[3], parts };
}

/**
 * Move the character's folder from `oldName` to `newName` (0x4e2870): every key of the old folder under the new name,
 * the old ones removed. Nothing moves when the new folder already has a key (MoveFile onto an existing folder fails)
 * or the names are the same. Answers whether anything moved.
 */
export function moveGlueCharacterFolder(
  storage: GlueRenameStorage | null | undefined, account: string, realm: string, oldName: string, newName: string,
): boolean {
  if (!storage || oldName === newName) return false;
  const { key: keyAt, removeItem } = storage;
  if (!keyAt || !removeItem) return false;
  const upper = upperAscii(account);
  const moving: { readonly key: string; readonly parts: unknown[] }[] = [];
  try {
    const count = storage.length ?? 0;
    for (let index = 0; index < count; index++) {
      const key = keyAt.call(storage, index);
      const folder = key === null ? undefined : folderOf(key, upper, realm);
      if (!folder) continue;
      if (folder.character === newName) return false;
      if (folder.character === oldName) moving.push({ key: key!, parts: folder.parts });
    }
    for (const { key, parts } of moving) {
      const value = storage.getItem(key);
      if (value === null) continue;
      const moved = [...parts];
      moved[3] = newName;
      storage.setItem(JSON.stringify(moved), value);
      removeItem.call(storage, key);
    }
  } catch {
    return false; // site data blocked: nothing kept to move
  }
  return moving.length > 0;
}
