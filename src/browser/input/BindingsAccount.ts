/**
 * The key bindings as account data (WORK_PLAN 4.12, М-A5-2): the envelope the owner's Unity client
 * already writes into the shared account slot 2 (`GLOBAL_BINDINGS_CACHE`), read and written here
 * by exactly its rules, so the two clients of one account can share the slot without either
 * erasing the other's keys.
 *
 * The rules are `D:\WowTest\Assets\WowClient\Runtime\Settings\ClientBindingAccount.cs` (`Parse`,
 * `Serialise`, `Merge`), restated:
 *  - the root has the properties `format`, `version`, `core`, `modules` and optionally
 *    `modifiedClicks` and nothing else; `format` is `"wowclient-bindings"`, `version` the integer 1;
 *  - `core` and `modules` are tables of at most 1024 rows, a name of 1–256 characters, a value of
 *    exactly two strings of at most 128 characters each (this table's `event.code` chords);
 *  - `modifiedClicks` is at most 64 rows of a 1–128 character name and one of SHIFT, CTRL, ALT, NONE;
 *  - anything else is not this envelope.
 *
 * 5.37 (15.11): the slot is Wow.exe's bindings cache text since (`BindingsSlotSync.ts`). The envelope is
 * only read, so the keys saved in it are not lost; the next change writes the slot in Wow.exe's text, and
 * the Unity client's own rows go with the envelope.
 *
 * DOM-free and world-free.
 */

export const BINDINGS_ENVELOPE_FORMAT = "wowclient-bindings";
export const BINDINGS_ENVELOPE_VERSION = 1;
/**
 * The largest text written: the core drops a slot whose decompressed size passes 0xFFFF without a
 * word (`MiscHandler.cpp:914`), so a table near that size would be lost silently; this leaves room.
 */
export const ACCOUNT_DATA_WRITE_LIMIT = 60_000;

export type BindingRow = readonly [string, string];

export interface BindingsEnvelope {
  readonly core: Readonly<Record<string, BindingRow>>;
  readonly modules: Readonly<Record<string, BindingRow>>;
  readonly modifiedClicks: Readonly<Record<string, string>>;
}

const ROOT_KEYS: ReadonlySet<string> = new Set(["format", "version", "core", "modules", "modifiedClicks"]);
const MODIFIED_CLICK_VALUES: ReadonlySet<string> = new Set(["SHIFT", "CTRL", "ALT", "NONE"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function table(value: unknown): Record<string, BindingRow> | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 1024) return undefined;
  const result: Record<string, BindingRow> = {};
  for (const [name, pair] of entries) {
    if (name.length === 0 || name.length > 256 || !Array.isArray(pair) || pair.length !== 2) return undefined;
    const [first, second] = pair as unknown[];
    if (typeof first !== "string" || typeof second !== "string" || first.length > 128 || second.length > 128) return undefined;
    result[name] = [first, second];
  }
  return result;
}

function modifiedClicks(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 64) return undefined;
  const result: Record<string, string> = {};
  for (const [name, modifier] of entries) {
    if (name.length === 0 || name.length > 128 || typeof modifier !== "string" || !MODIFIED_CLICK_VALUES.has(modifier)) return undefined;
    result[name] = modifier;
  }
  return result;
}

/** The envelope, or undefined for anything the Unity client's `Parse` would refuse. */
export function parseBindingsEnvelope(text: string): BindingsEnvelope | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(root)) return undefined;
  const keys = Object.keys(root);
  if ((keys.length !== 4 && keys.length !== 5) || !keys.every((key) => ROOT_KEYS.has(key))) return undefined;
  if (root["format"] !== BINDINGS_ENVELOPE_FORMAT) return undefined;
  if (root["version"] !== BINDINGS_ENVELOPE_VERSION) return undefined;
  const core = table(root["core"]);
  const modules = table(root["modules"]);
  if (!core || !modules) return undefined;
  const clicks = root["modifiedClicks"] === undefined ? {} : modifiedClicks(root["modifiedClicks"]);
  if (!clicks) return undefined;
  return { core, modules, modifiedClicks: clicks };
}

/** UTF-8 length of a text, which is what the core measures. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
