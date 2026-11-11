/**
 * 3.46 (11.11): the client's per-character add-on states, as Wow.exe 3.3.5a 12340 keeps them on the glue screens
 * (read-only Ghidra, .runtime/re-2026-11-11/glue c4.c, c5.c; .runtime/re-2026-10-11/glue-1110/1013-q1.txt):
 *
 * - One state table per character of the realm («ADDONSTATELIST» at DAT_00ad17b0): add-on name → enabled, with a
 *   dirty mark. A character gets its table as it joins the character list (0x4e3ca0 → 0x5f91e0(name)): its own
 *   `WTF/Account/<A>/<realm>/<char>/AddOns.txt`, else the account's `WTF/Account/<A>/AddOns.txt` — and then the table
 *   is dirty, so the next save writes the character's own file. A line is "name: value"; the add-on is disabled when
 *   the value is "disabled" (any case), enabled for any other value.
 * - `EnableAddOn`/`DisableAddOn(character, index)` and the `All` pair (0x4dc8a0, 0x4dc9b0, 0x4dc960, 0x4dca70) set
 *   the add-on in that character's table, or in every table for nil (0x5f90b0), marking the tables they change.
 * - `SaveAddOns` (0x5f76a0) writes each dirty table as "name: enabled|disabled\r\n" lines; `ResetAddOns` (0x5f91e0(0))
 *   reloads every table from the files, dropping what was not saved.
 * - The state of an add-on (0x5f7d70(addon, character, 1)), over the named character or every one: a table's own
 *   line, else — the character has none — the add-on's state over all tables that have a line (0x5f7570): enabled
 *   when all of them enable it, disabled when none does, and the TOC's DefaultState when they disagree or no table
 *   has a line. The answer is 2 when every character considered has it on, 1 when some do, 0 when none; with no
 *   character at all, DefaultState's 2 or 0.
 *
 * DefaultState without a TOC line is taken as enabled: an add-on no AddOns.txt names loads in Wow.exe (the TOC
 * reader sets the byte only for an "enabled"/"disabled" value, 0x005f86a0).
 *
 * Here a character's file is kept in this browser (`GlueAddonFiles`), as the add-ons' SavedVariables are, under the
 * account, the realm's name and the character; the account's file is the gateway's profile (`/client/addons`'
 * `profileState`), which Wow.exe would read from the same WTF folder.
 */

export interface GlueAddonStateInfo {
  readonly name: string;
  /** The TOC's DefaultState; true when it has none. */
  readonly defaultState: boolean;
}

/** Where a character's AddOns.txt text is read and written; undefined — no file. */
export interface GlueAddonFiles {
  read(character: string): string | undefined;
  write(character: string, text: string): void;
}

interface CharacterTable {
  readonly name: string;
  /** Lower-case add-on name → the name as written and its state. */
  readonly states: Map<string, { readonly name: string; enabled: boolean }>;
  dirty: boolean;
}

/** An AddOns.txt's lines as 0x5f91e0 reads them, by lower-case name (a later line wins). */
export function parseGlueAddonsText(text: string): Map<string, { readonly name: string; enabled: boolean }> {
  const states = new Map<string, { readonly name: string; enabled: boolean }>();
  for (const raw of text.replace(/^﻿/, "").split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ +/, "");
    if (value === "") continue;
    states.set(name.toLowerCase(), { name, enabled: value.toLowerCase() !== "disabled" });
  }
  return states;
}

/** 0x5f76a0's text of one table. */
export function formatGlueAddonsText(states: Iterable<{ readonly name: string; readonly enabled: boolean }>): string {
  let text = "";
  for (const entry of states) text += `${entry.name}: ${entry.enabled ? "enabled" : "disabled"}\r\n`;
  return text;
}

export class GlueAddonStateList {
  readonly #files: GlueAddonFiles;
  /** The account's AddOns.txt, by lower-case name; undefined — there is none. */
  readonly #account: () => ReadonlyMap<string, boolean> | undefined;
  #addons: ReadonlyMap<string, GlueAddonStateInfo> = new Map();
  #tables: CharacterTable[] = [];

  constructor(files: GlueAddonFiles, account: () => ReadonlyMap<string, boolean> | undefined) {
    this.#files = files;
    this.#account = account;
  }

  setAddons(addons: readonly GlueAddonStateInfo[]): void {
    this.#addons = new Map(addons.map((addon) => [addon.name.toLowerCase(), addon]));
  }

  /** The realm's characters, in list order: a new one gets its table from its files, a gone one loses it. */
  setCharacters(names: readonly string[]): void {
    const kept: CharacterTable[] = [];
    for (const name of names) {
      const lower = name.toLowerCase();
      if (kept.some((table) => table.name.toLowerCase() === lower)) continue;
      kept.push(this.#tables.find((table) => table.name.toLowerCase() === lower) ?? this.#load(name));
    }
    this.#tables = kept;
  }

  get characters(): readonly string[] {
    return this.#tables.map((table) => table.name);
  }

  /** 0x5f91e0(name): the character's own file, else the account's — dirty then. */
  #load(name: string): CharacterTable {
    const own = this.#files.read(name);
    if (own !== undefined) return { name, states: parseGlueAddonsText(own), dirty: false };
    const account = this.#account();
    if (account === undefined) return { name, states: new Map(), dirty: false };
    const states = new Map<string, { readonly name: string; enabled: boolean }>();
    for (const [lower, enabled] of account) states.set(lower, { name: this.#addons.get(lower)?.name ?? lower, enabled });
    return { name, states, dirty: true };
  }

  #matching(character: string | undefined): CharacterTable[] {
    if (character === undefined) return this.#tables;
    const lower = character.toLowerCase();
    const table = this.#tables.find((entry) => entry.name.toLowerCase() === lower);
    return table ? [table] : [];
  }

  #defaultState(lower: string): boolean {
    return this.#addons.get(lower)?.defaultState ?? true;
  }

  /** 0x5f7570: the add-on over the tables that name it — 2 all on, 0 none, 1 mixed; none names it, DefaultState. */
  #overall(lower: string): 0 | 1 | 2 {
    let named = 0;
    let enabled = 0;
    for (const table of this.#tables) {
      const entry = table.states.get(lower);
      if (!entry) continue;
      named++;
      if (entry.enabled) enabled++;
    }
    if (named === 0) return this.#defaultState(lower) ? 2 : 0;
    if (enabled === 0) return 0;
    return enabled < named ? 1 : 2;
  }

  /** 0x5f7d70(addon, character, 1): 2 on for every character considered, 1 for some, 0 for none. */
  state(addon: string, character?: string): 0 | 1 | 2 {
    const lower = addon.toLowerCase();
    if (!this.#addons.has(lower)) return 0;
    const tables = this.#matching(character);
    let considered = 0;
    let enabled = 0;
    for (const table of tables) {
      considered++;
      const entry = table.states.get(lower);
      let on: boolean;
      if (entry) on = entry.enabled;
      else {
        const overall = this.#overall(lower);
        on = overall === 2 || (overall === 1 && this.#defaultState(lower));
      }
      if (on) enabled++;
    }
    // No character considered (none on the realm, or the name is not one): DefaultState's answer.
    if (considered === 0) return this.#defaultState(lower) ? 2 : 0;
    if (enabled === 0) return 0;
    return enabled < considered ? 1 : 2;
  }

  /** 0x5f90b0: the add-on on or off for the named character, or for every one. */
  set(addon: string, character: string | undefined, enabled: boolean): void {
    const lower = addon.toLowerCase();
    for (const table of this.#matching(character)) {
      const entry = table.states.get(lower);
      if (!entry) {
        table.states.set(lower, { name: this.#addons.get(lower)?.name ?? addon, enabled });
        table.dirty = true;
      } else if (entry.enabled !== enabled) {
        entry.enabled = enabled;
        table.dirty = true;
      }
    }
  }

  /** 0x5f76a0: every changed table to its character's file. */
  save(): void {
    for (const table of this.#tables) {
      if (!table.dirty) continue;
      table.dirty = false;
      this.#files.write(table.name, formatGlueAddonsText(table.states.values()));
    }
  }

  /** 0x5f91e0(0): every table again from the files. */
  reset(): void {
    this.#tables = this.#tables.map((table) => this.#load(table.name));
  }

  /** 3.46 (11.11): 0x5f91e0(name) — the named character's table again from its files (the world's ResetDisabledAddOns). */
  resetCharacter(name: string): void {
    const lower = name.toLowerCase();
    this.#tables = this.#tables.map((table) => (table.name.toLowerCase() === lower ? this.#load(table.name) : table));
  }
}
