import { lua, to_luastring, type LuaState } from "fengari";
import type { GlueLuaVm } from "../glue/GlueLua.js";
import { glueCallingAddon } from "../glue/GlueAddonIdentity.js";

export interface FrameXmlSavedVariablesScope {
  readonly account: string;
  readonly realm: string;
  readonly character: string;
}

export interface FrameXmlSavedVariablesOptions {
  readonly scope: FrameXmlSavedVariablesScope;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
}

export interface FrameXmlSavedVariableDiagnostic {
  readonly module: string;
  readonly variable: string;
  readonly operation: "register" | "restore" | "save";
  readonly message: string;
}

type Scalar = null | boolean | number | string;
type SavedValue = Scalar | { readonly entries: readonly (readonly [Scalar, SavedValue])[] };
interface Registration { readonly module: string; readonly name: string; readonly character: boolean; restored: boolean }
const MAX_BYTES = 1024 * 1024;
const MAX_NODES = 10000;
const MAX_DEPTH = 32;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readValue(L: LuaState, index: number, ancestors: Set<unknown>, budget: { nodes: number }, depth = 0): SavedValue {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("saved value exceeds table limits");
  if (!lua.lua_checkstack(L, 4)) throw new Error("not enough Lua stack to save value");
  const type = lua.lua_type(L, index);
  if (type === lua.LUA_TNIL) return null;
  if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index);
  if (type === lua.LUA_TSTRING) {
    const value = lua.lua_tojsstring(L, index);
    if (value.length > MAX_BYTES) throw new Error("saved string exceeds size limit");
    return value;
  }
  if (type === lua.LUA_TNUMBER) {
    const value = lua.lua_tonumber(L, index);
    if (!Number.isFinite(value)) throw new Error("non-finite number cannot be saved");
    return value;
  }
  if (type !== lua.LUA_TTABLE) throw new Error("only nil, booleans, finite numbers, strings and plain tables can be saved");
  const absolute = lua.lua_absindex(L, index);
  if (lua.lua_getmetatable(L, absolute)) {
    lua.lua_pop(L, 1);
    throw new Error("tables with metatables cannot be saved");
  }
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

  flush(): void {
    if (!this.options) return;
    const L = this.vm.state;
    for (const entry of this.#registrations.values()) {
      if (!entry.restored) continue;
      const top = lua.lua_gettop(L);
      try {
        lua.lua_pushglobaltable(L);
        lua.lua_pushstring(L, to_luastring(entry.name));
        lua.lua_rawget(L, -2);
        const value = readValue(L, -1, new Set(), { nodes: 0 });
        const serialized = JSON.stringify({ version: 1, value });
        if (serialized.length > MAX_BYTES) throw new Error("saved value exceeds size limit");
        const key = this.key(entry);
        if (this.options.storage.getItem(key) !== serialized) this.options.storage.setItem(key, serialized);
      } catch (error) {
        this.note(entry, "save", String(error));
      } finally { lua.lua_settop(L, top); }
    }
  }

  private restore(entry: Registration): void {
    if (entry.restored) return;
    entry.restored = true;
    if (!this.options) return;
    const L = this.vm.state;
    const top = lua.lua_gettop(L);
    try {
      const serialized = this.options.storage.getItem(this.key(entry));
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
    const account = scope.account.replace(/[a-z]/g, (character) => character.toUpperCase());
    return JSON.stringify(["webclient-addon-v1", account, scope.realm, entry.character ? scope.character : null, entry.module, entry.name]);
  }

  private note(entry: Registration, operation: FrameXmlSavedVariableDiagnostic["operation"], message: string): void {
    this.#diagnostics.set(`${entry.module}:${entry.name}:${operation}`, { module: entry.module, variable: entry.name, operation, message });
  }
}
