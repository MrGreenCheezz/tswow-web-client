import { lua, to_luastring, type LuaState } from "fengari";
import type { GlueLuaVm } from "../glue/GlueLua.js";
import { glueCallingAddon } from "../glue/GlueAddonIdentity.js";

export interface FrameXmlSavedVariablesScope {
  readonly account: string;
  /**
   * The realm's name only (9.06): the real client keeps `WTF/Account/<account>/<realm>/<character>`
   * with no server address in it, so a gateway reached by another address finds the same data.
   */
  readonly realm: string;
  readonly character: string;
  /**
   * The realm part of the v1 key (`JSON.stringify([gatewayOrigin, realmName])`), read once to migrate
   * data saved before 9.06; the v1 entry is removed after the first successful v2 write.
   */
  readonly legacyRealm?: string | undefined;
}

export interface FrameXmlSavedVariablesOptions {
  readonly scope: FrameXmlSavedVariablesScope;
  readonly storage: Pick<Storage, "getItem" | "setItem"> & {
    readonly removeItem?: ((key: string) => void) | undefined;
    /** `Storage` enumeration, for v1 data saved through another gateway address (9.06 migration). */
    readonly length?: number | undefined;
    readonly key?: ((index: number) => string | null) | undefined;
  };
  /** Called once per variable and operation when saving or restoring fails (shown to the player). */
  readonly onProblem?: ((diagnostic: FrameXmlSavedVariableDiagnostic) => void) | undefined;
  /** The clock {@link FrameXmlSavedVariables.checkpoint} budgets by; `performance.now` unless a test replaces it. */
  readonly now?: (() => number) | undefined;
}

export interface FrameXmlSavedVariableDiagnostic {
  readonly module: string;
  readonly variable: string;
  readonly operation: "register" | "restore" | "save";
  readonly message: string;
}

type Scalar = null | boolean | number | string;
type SavedValue = Scalar | { readonly entries: readonly (readonly [Scalar, SavedValue])[] };
interface Registration {
  readonly module: string;
  readonly name: string;
  readonly character: boolean;
  restored: boolean;
  /** The v1 key this variable was restored from, removed after its first v2 write. */
  migratedFrom?: string | undefined;
  /** When this variable's last save started and what it cost, aborted walks included (checkpoints). */
  lastSavedAt?: number | undefined;
  lastCostMs?: number | undefined;
}

/**
 * The periodic checkpoint's bounds (9.06 review). A save walks the whole variable at once — ≈0.33 µs a
 * node in fengari (Node, P-core: 2,000 nodes 1.2 ms, 20,000 nodes 6.7 ms, 49,000 nodes 16 ms) — and
 * cannot be sliced over frames: Lua runs between them, so a sliced walk would save a torn value, and
 * `lua_next` over a table that gained keys mid-walk is undefined. So one tick spends at most about
 * `budgetMs` (whole variables, at least one, round robin), and a variable whose last save cost more
 * than `heavyMs` waits `heavyIntervalMs` between checkpoints. The real client saves only at logout and
 * reload; `flush()` — pagehide, a hidden tab, beforeunload, close — still saves everything.
 */
export const SAVED_VARIABLE_CHECKPOINT = Object.freeze({ budgetMs: 4, heavyMs: 4, heavyIntervalMs: 300_000 });
/**
 * What one saved variable may hold. Raised from 1 MiB / 10,000 nodes (9.06) — starting numbers, not
 * the measured final ones: re-check against the sizes enabled add-ons actually write (WCollections'
 * cache, 9.07) and the flush time in fengari before trusting them.
 */
export const SAVED_VARIABLE_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, nodes: 50_000, depth: 32 });
const MAX_BYTES = SAVED_VARIABLE_LIMITS.bytes;
const MAX_NODES = SAVED_VARIABLE_LIMITS.nodes;
const MAX_DEPTH = SAVED_VARIABLE_LIMITS.depth;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readValue(L: LuaState, index: number, ancestors: Set<unknown>, budget: { nodes: number }, depth = 0): SavedValue {
  if (++budget.nodes > MAX_NODES) throw new Error(`saved value exceeds table limits: more than ${MAX_NODES} nodes`);
  if (depth > MAX_DEPTH) throw new Error(`saved value exceeds table limits: deeper than ${MAX_DEPTH}`);
  if (!lua.lua_checkstack(L, 4)) throw new Error("not enough Lua stack to save value");
  const type = lua.lua_type(L, index);
  if (type === lua.LUA_TNIL) return null;
  if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index);
  if (type === lua.LUA_TSTRING) {
    const value = lua.lua_tojsstring(L, index);
    if (value.length > MAX_BYTES) throw new Error(`saved string exceeds size limit: ${value.length} bytes, limit ${MAX_BYTES}`);
    return value;
  }
  if (type === lua.LUA_TNUMBER) {
    const value = lua.lua_tonumber(L, index);
    if (!Number.isFinite(value)) throw new Error("non-finite number cannot be saved");
    return value;
  }
  if (type !== lua.LUA_TTABLE) throw new Error("only nil, booleans, finite numbers, strings and plain tables can be saved");
  const absolute = lua.lua_absindex(L, index);
  // A metatable is ignored, not refused (9.06): the walk below is raw (`lua_next`), so `__index`,
  // `__pairs` and the like never run, and what is saved is exactly what the table holds — the way
  // the real client writes it. AceDB puts `__index` defaults on its tables and only takes them off
  // in its own PLAYER_LOGOUT handler; refusing them made such a variable unsavable between logouts.
  const pointer = lua.lua_topointer(L, absolute);
  if (ancestors.has(pointer)) throw new Error("cyclic tables cannot be saved");
  ancestors.add(pointer);
  const entries: Array<readonly [Scalar, SavedValue]> = [];
  lua.lua_pushnil(L);
  while (lua.lua_next(L, absolute)) {
    const key = readValue(L, -2, ancestors, budget, depth + 1);
    if (key === null || typeof key === "object") throw new Error("table keys must be strings, numbers or booleans");
    entries.push([key, readValue(L, -1, ancestors, budget, depth + 1)]);
    lua.lua_pop(L, 1);
  }
  ancestors.delete(pointer);
  return { entries };
}

function validateValue(value: unknown, budget: { nodes: number }, depth = 0): asserts value is SavedValue {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("saved value exceeds table limits");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries)) {
    throw new Error("invalid saved value");
  }
  for (const pair of value.entries) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === null || typeof pair[0] === "object") {
      throw new Error("invalid saved table entry");
    }
    validateValue(pair[0], budget, depth + 1);
    validateValue(pair[1], budget, depth + 1);
  }
}

function pushValue(L: LuaState, value: SavedValue): void {
  if (!lua.lua_checkstack(L, 4)) throw new Error("not enough Lua stack to restore saved value");
  if (value === null) lua.lua_pushnil(L);
  else if (typeof value === "boolean") lua.lua_pushboolean(L, value);
  else if (typeof value === "number") lua.lua_pushnumber(L, value);
  else if (typeof value === "string") lua.lua_pushstring(L, to_luastring(value));
  else {
    lua.lua_createtable(L, 0, value.entries.length);
    for (const [key, item] of value.entries) {
      pushValue(L, key);
      pushValue(L, item);
      lua.lua_rawset(L, -3);
    }
  }
}

/** JSON is data only. Raw Lua traversal never executes a saved chunk or table metamethod. */
export class FrameXmlSavedVariables {
  readonly #registrations = new Map<string, Registration>();
  readonly #conflicts = new Set<string>();
  readonly #ready = new Set<string>();
  readonly #diagnostics = new Map<string, FrameXmlSavedVariableDiagnostic>();
  readonly #reported = new Set<string>();
  constructor(readonly vm: GlueLuaVm, readonly options?: FrameXmlSavedVariablesOptions) {}

  get diagnostics(): readonly FrameXmlSavedVariableDiagnostic[] { return [...this.#diagnostics.values()]; }

  installBindings(): void {
    for (const [binding, character] of [["RegisterForSave", false], ["RegisterForSavePerCharacter", true]] as const) {
      this.vm.registerGlobal(binding, (args) => {
        const module = glueCallingAddon(this.vm.callingSources()) ?? "blizzard_framexml";
        for (const name of args) if (typeof name === "string") this.register(module, name, character);
        return [];
      });
    }
  }

  registerToc(source: string, defaultModule = "blizzard_framexml"): void {
    let module = defaultModule.toLowerCase();
    for (const line of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const marker = line.match(/^\s*##\s*tsaddon-(begin|end):\s*([^\s]+)/i);
      if (marker) { module = marker[1]!.toLowerCase() === "begin" ? marker[2]!.toLowerCase() : defaultModule.toLowerCase(); continue; }
      const declaration = line.match(/^\s*##\s*(SavedVariables|SavedVariablesPerCharacter)\s*:\s*(.*)$/i);
      if (!declaration) continue;
      for (const name of declaration[2]!.split(/[,;\s]+/).filter(Boolean)) {
        this.register(module, name, declaration[1]!.toLowerCase() === "savedvariablespercharacter");
      }
    }
  }

  private register(module: string, name: string, character: boolean): void {
    const registration: Registration = { module: module.toLowerCase(), name, character, restored: false };
    if (!VARIABLE.test(name) || name === "_G") {
      this.note(registration, "register", "invalid saved variable name");
      return;
    }
    if (this.#conflicts.has(name)) {
      this.note(registration, "register", "saved global has conflicting module or scope declarations");
      return;
    }
    const prior = this.#registrations.get(name);
    if (prior) {
      if (prior.module !== registration.module || prior.character !== character) {
        this.#conflicts.add(name);
        this.#registrations.delete(name);
        this.note(prior, "register", "saved global has conflicting module or scope declarations");
        this.note(registration, "register", "saved global has conflicting module or scope declarations");
      }
      return;
    }
    this.#registrations.set(name, registration);
    if (this.#ready.has(registration.module)) this.restore(registration);
  }

  finishModule(module: string): void {
    this.#ready.add(module.toLowerCase());
    for (const entry of this.#registrations.values()) if (entry.module === module.toLowerCase()) this.restore(entry);
  }

  finishBaseModules(modules: readonly string[]): void {
    this.finishModule("blizzard_framexml");
    for (const module of modules) this.finishModule(module);
  }

  /** Saves every restored variable now, whatever it costs (pagehide, a hidden tab, close). */
  flush(): void {
    if (!this.options) return;
    for (const entry of this.#registrations.values()) if (entry.restored) this.#save(entry);
  }

  /**
   * The periodic save: whole variables in round robin until {@link SAVED_VARIABLE_CHECKPOINT}'s budget
   * is spent, heavy ones only once their own interval has passed.
   */
  checkpoint(): void {
    if (!this.options) return;
    const entries = [...this.#registrations.values()].filter((entry) => entry.restored);
    if (entries.length === 0) return;
    const { budgetMs, heavyMs, heavyIntervalMs } = SAVED_VARIABLE_CHECKPOINT;
    const started = this.#now();
    const first = this.#cursor % entries.length;
    for (let step = 0; step < entries.length; step += 1) {
      const index = (first + step) % entries.length;
      const entry = entries[index]!;
      if ((entry.lastCostMs ?? 0) > heavyMs && entry.lastSavedAt !== undefined
        && started - entry.lastSavedAt < heavyIntervalMs) continue;
      this.#save(entry);
      if (this.#now() - started >= budgetMs) {
        this.#cursor = index + 1;
        return;
      }
    }
  }

  #cursor = 0;

  #now(): number {
    return this.options?.now?.() ?? performance.now();
  }

  #save(entry: Registration): void {
    const options = this.options;
    if (!options) return;
    const L = this.vm.state;
    const started = this.#now();
    const top = lua.lua_gettop(L);
    try {
      lua.lua_pushglobaltable(L);
      lua.lua_pushstring(L, to_luastring(entry.name));
      lua.lua_rawget(L, -2);
      const value = readValue(L, -1, new Set(), { nodes: 0 });
      const serialized = JSON.stringify({ version: 1, value });
      if (serialized.length > MAX_BYTES) {
        throw new Error(`saved value exceeds size limit: ${serialized.length} bytes, limit ${MAX_BYTES}`);
      }
      const key = this.key(entry);
      if (options.storage.getItem(key) !== serialized) options.storage.setItem(key, serialized);
      if (entry.migratedFrom !== undefined) {
        // The v2 copy is written (or already equal): the v1 one under the old address goes.
        options.storage.removeItem?.(entry.migratedFrom);
        entry.migratedFrom = undefined;
      }
    } catch (error) {
      this.note(entry, "save", String(error));
    } finally { lua.lua_settop(L, top); }
    entry.lastSavedAt = started;
    entry.lastCostMs = this.#now() - started;
  }

  private restore(entry: Registration): void {
    if (entry.restored) return;
    entry.restored = true;
    if (!this.options) return;
    const L = this.vm.state;
    const top = lua.lua_gettop(L);
    try {
      let serialized = this.options.storage.getItem(this.key(entry));
      // Data saved before 9.06 sits under this gateway's address: read it when there is no v2 copy
      // yet, and drop it after the next v2 write either way (v2 wins once it exists).
      const legacy = this.legacyKey(entry);
      if (legacy !== undefined) entry.migratedFrom = legacy;
      if (serialized === null && legacy !== undefined) serialized = this.options.storage.getItem(legacy);
      if (serialized === null) {
        // Saved through another address of the same gateway (localhost, then 127.0.0.1, or the public
        // host): the same account, realm name, character, module and variable — not lost because the
        // address it was keyed by is not the one used now.
        const elsewhere = this.otherLegacyKey(entry);
        if (elsewhere !== undefined) {
          serialized = this.options.storage.getItem(elsewhere);
          if (serialized !== null) entry.migratedFrom = elsewhere;
        }
      }
      if (serialized === null) return;
      if (serialized.length > MAX_BYTES) throw new Error("saved value exceeds size limit");
      const parsed: unknown = JSON.parse(serialized);
      if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1 || !("value" in parsed)) {
        throw new Error("invalid saved variable envelope");
      }
      validateValue(parsed.value, { nodes: 0 });
      lua.lua_pushglobaltable(L);
      lua.lua_pushstring(L, to_luastring(entry.name));
      pushValue(L, parsed.value);
      lua.lua_rawset(L, -3);
    } catch (error) {
      this.note(entry, "restore", String(error));
    } finally { lua.lua_settop(L, top); }
  }

  private key(entry: Registration): string {
    const scope = this.options!.scope;
    if (!scope.account || !scope.realm || !scope.character) throw new Error("saved variable identity is incomplete");
    return JSON.stringify(["webclient-addon-v2", upperAscii(scope.account), scope.realm,
      entry.character ? scope.character : null, entry.module, entry.name]);
  }

  /** The pre-9.06 key, whose realm part carried the gateway origin; undefined without one. */
  private legacyKey(entry: Registration): string | undefined {
    const scope = this.options!.scope;
    if (!scope.legacyRealm) return undefined;
    return JSON.stringify(["webclient-addon-v1", upperAscii(scope.account), scope.legacyRealm,
      entry.character ? scope.character : null, entry.module, entry.name]);
  }

  /**
   * A v1 key of this variable under any gateway address, found by enumerating the storage (once per
   * instance); the first in key order when several addresses hold one. Undefined without enumeration.
   */
  private otherLegacyKey(entry: Registration): string | undefined {
    const scope = this.options!.scope;
    this.#legacyKeys ??= this.scanLegacyKeys();
    const account = upperAscii(scope.account);
    const character = entry.character ? scope.character : null;
    for (const [key, parts] of this.#legacyKeys) {
      if (parts[1] === account && parts[3] === character && parts[4] === entry.module && parts[5] === entry.name) return key;
    }
    return undefined;
  }

  #legacyKeys: [string, readonly unknown[]][] | undefined;

  /** Every v1 key whose realm part names this realm, sorted. */
  private scanLegacyKeys(): [string, readonly unknown[]][] {
    const storage = this.options!.storage;
    if (typeof storage.key !== "function" || typeof storage.length !== "number") return [];
    const found: [string, readonly unknown[]][] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith('["webclient-addon-v1",')) continue;
      try {
        const parts: unknown = JSON.parse(key);
        if (!Array.isArray(parts) || parts.length !== 6 || typeof parts[2] !== "string") continue;
        const realm: unknown = JSON.parse(parts[2]);
        if (Array.isArray(realm) && realm[1] === this.options!.scope.realm) found.push([key, parts]);
      } catch { /* not a key this class wrote */ }
    }
    return found.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  }

  private note(entry: Registration, operation: FrameXmlSavedVariableDiagnostic["operation"], message: string): void {
    const key = `${entry.module}:${entry.name}:${operation}`;
    const diagnostic = { module: entry.module, variable: entry.name, operation, message };
    this.#diagnostics.set(key, diagnostic);
    // Once per variable and operation: a periodic save failing every 30 s says it once.
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    try { this.options?.onProblem?.(diagnostic); } catch { /* the report must not break the save */ }
  }
}

/** ASCII letters only, as the account name has always been keyed (the client's own upper-casing). */
function upperAscii(text: string): string {
  return text.replace(/[a-z]/g, (character) => character.toUpperCase());
}
