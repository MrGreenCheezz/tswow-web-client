/**
 * Everything the tswow modules on this machine ship for the client, fetched and switched on.
 *
 * A module author edits a file on disk; the browser has no way to see a disk. `GET /modules/index`
 * says what exists and three file routes hand one over, and this is the piece that asks, parses,
 * registers — and, when the file changes under it, does the whole thing again for that one file.
 *
 * What a module gets to add, in the order it is added:
 *
 * 1. **Message schemas** (`content/messages/*.json`) — into `world.customPackets`, owned by the
 *    module's name.
 * 2. **Stylesheets** (`content/css/*.css`) — as one `<style data-module="…">` per module, with
 *    every rule prefixed by that attribute. See {@link prefixModuleCss}: without the prefix a
 *    module could write `body { display: none }` and take the client off the screen.
 * 3. **Windows** (`content/ui/*.json`) — parsed by `WindowSchema`, drawn by `WindowRender`,
 *    registered in the window registry, and then each one may also bring
 *    * its own inline message schemas, owned by `<модуль>/<окно>` rather than by the module, so
 *      that reloading one window takes back exactly the schemas that window declared and leaves
 *      the module's own files alone;
 *    * a slash command, in the chat's dynamic table — which cannot shadow a command or a channel;
 *    * a key binding, offered **unbound** in a «Модули» group of the bindings window.
 *
 * Four habits, all of them the same idea — one bad file is one bad file:
 *
 * * A file that will not parse is skipped and its problems are kept; the rest of the module loads.
 * * A message whose opcode another module already claimed is refused by the registry, named, and
 *   left out; the rest of the file loads.
 * * Two modules that call a window by the same id are a refusal naming both, and the second one is
 *   not drawn — an anchor, a slash command and a key binding all resolve through the id.
 * * The whole load failing (no gateway, no route) leaves a status line and nothing else. A client
 *   with no modules is the client as it was before this slice, not a broken one.
 *
 * ## Hot reload
 *
 * While something is watching — the diagnostics «Окна» pane, and later the builder overlay — the
 * index is re-fetched every two seconds and each file whose `sha1` moved is done again. sha1 and
 * not mtime, because an editor that saves on every keystroke moves the mtime constantly and the
 * hash only when there is something to rebuild; and it is the sha1 of the *entry the index gave*,
 * which since М3 is always the hash of the bytes the route will answer with. While it was not, a
 * changed hash would have been seen on every single poll and the rebuild would never have settled.
 *
 * A rebuilt window is destroyed and drawn again under the same element id, and `GameWindowManager`
 * remembers a window's place by element id — so a window the player dragged into a corner comes
 * back to that corner.
 *
 * ## Unloading
 *
 * Symmetric, and that is what the reload is built out of: `unload()` is `forget` for every module,
 * for every window's inline schemas, for every window, command, binding and `<style>` node, plus
 * the poll timer. What it never registered it does not touch.
 */

import { parseCustomMessages } from "../../world/CustomCodec.js";
import type { CustomPacketRegistry } from "../../world/CustomPacketRegistry.js";
import { checkWindowActions, checkWindowPatch, patchTargetProblems } from "./WindowActions.js";
import type { LivePatch } from "./WindowPatch.js";
import type { LiveWindow } from "./WindowRender.js";
import type { PatchRegistry, WindowRegistry } from "./WindowRegistry.js";
import {
  moduleUiKind, parseWindowDefinition, parseWindowPatch,
  type ParsedPatch, type ParsedWindow,
} from "./WindowSchema.js";

/** One definition file, as the index lists it. */
interface ModuleIndexFile {
  readonly file: string;
  /** `"draft"` for a file the gateway took from `data/ui`, `"module"` for a tswow module's own. */
  readonly source: string;
  readonly sha1: string;
  readonly mtimeMs: number;
  readonly bytes: number;
}

interface ModuleIndexEntry {
  readonly module: string;
  readonly messages?: readonly ModuleIndexFile[];
  readonly windows?: readonly ModuleIndexFile[];
  readonly css?: readonly ModuleIndexFile[];
}

/** One message file that loaded, for the diagnostics window and for the staleness check. */
export interface LoadedMessageFile {
  readonly module: string;
  readonly source: string;
  readonly file: string;
  readonly sha1: string;
  /** How many messages of the file are live. Fewer than the file holds when one was refused. */
  readonly count: number;
}

/** One window file that loaded. */
export interface LoadedWindowFile {
  readonly module: string;
  readonly source: string;
  readonly file: string;
  readonly sha1: string;
  readonly windowId: string;
  /** How many messages the window declared inline, owned by `<модуль>/<окно>`. */
  readonly messages: number;
}

/**
 * A window file that loaded but is not shown, because a TSWoW Lua add-on already subscribes to one
 * of its opcodes: the same content-studio screen, generated twice (9.08). Not a problem — the Lua
 * screen is the one shown, and the window comes back when the Lua goes.
 */
export interface SuppressedWindow {
  readonly module: string;
  readonly file: string;
  readonly windowId: string;
  /** The opcode the Lua holds that made this window a twin. */
  readonly opcode: number;
}

/** One patch file that loaded (М7). */
export interface LoadedPatchFile {
  readonly module: string;
  readonly source: string;
  readonly file: string;
  readonly sha1: string;
  readonly patchId: string;
  /** How many slots it fills, hides and skins — what the «Окна» pane prints beside its name. */
  readonly edits: number;
}

/** One stylesheet that loaded. */
export interface LoadedStyleFile {
  readonly module: string;
  readonly source: string;
  readonly file: string;
  readonly sha1: string;
  /** Rules after prefixing. Zero means the file held nothing this client could scope. */
  readonly rules: number;
}

/** A slash command the loader hands to `Chat.ts`'s dynamic table. */
export interface ModuleCommandRequest {
  readonly module: string;
  readonly name: string;
  readonly help: string;
  run(rest: string): void;
}

/** A key binding the loader offers, unbound, through `Bindings.ts`'s dynamic table. */
export interface ModuleBindingRequest {
  readonly action: string;
  readonly module: string;
  readonly group: string;
  readonly label: string;
  run(): void;
}

/**
 * Everything the loader reaches outside itself.
 *
 * Callbacks and not imports, for the reason `WindowActions.ts` gives: the chat box reaches
 * `Dom.ts` and its 193 resolved elements, and the loader — the file with the fetching, the
 * ordering and the reload arithmetic in it — has to be testable without a page.
 */
export interface ModuleLoaderHost {
  readonly packets: CustomPacketRegistry;
  readonly windows: WindowRegistry<LiveWindow>;
  /** Turns a parsed definition into a live window. `renderWindow` in the client. */
  render(definition: ParsedWindow): LiveWindow;
  /**
   * Where a patch file's edits are registered (М7). Absent means this client applies no patches,
   * and a patch file is then refused by name rather than quietly ignored.
   */
  readonly patches?: PatchRegistry<LivePatch> | undefined;
  /** Turns a parsed patch into a live one. `applyWindowPatch` in the client. */
  applyPatch?(patch: ParsedPatch): LivePatch;
  /** `SLOT_NAMES`: every slot the built-in windows offer, whether one is on screen yet or not. */
  readonly slotNames?: ReadonlySet<string> | undefined;
  /** `FILLABLE_SLOTS`: the seven of those that take a widget rather than only a `hide`. */
  readonly fillableSlots?: ReadonlySet<string> | undefined;
  /** `SKINNABLE_WINDOWS`: every built-in window a patch's `class` may name. */
  readonly skinnableWindows?: ReadonlySet<string> | undefined;
  /** Adds a slash command, or answers why the name cannot be had. */
  addCommand?(command: ModuleCommandRequest): string | undefined;
  removeCommands?(module: string): void;
  addBinding?(binding: ModuleBindingRequest): void;
  removeBindings?(module: string): void;
  /** Replaces one module's `<style>` node with this text; empty text removes it. */
  setStyle?(module: string, css: string): void;
  /** The names `playUiSound` answers, so a `sound` action can be checked when the file loads. */
  readonly soundKits?: ReadonlySet<string> | undefined;
  /**
   * Starts a repeating timer and hands back the way to stop it.
   *
   * Injected so that a test can drive the poll by hand: a two-second interval in a test is two
   * seconds of waiting, and a fake clock that the test steps is the only way to assert what a
   * second poll does with an unchanged file.
   */
  schedule?(run: () => void, milliseconds: number): () => void;
}

/** How often the index is re-read while something is watching. */
export const MODULE_POLL_MS = 2_000;

/** The three kinds of file a module ships, and the route that answers each. */
const KINDS = ["messages", "css", "ui"] as const;
type ModuleKind = (typeof KINDS)[number];

/** Which key of an index entry each kind is listed under. */
const KIND_KEY: Readonly<Record<ModuleKind, "messages" | "css" | "windows">> = {
  messages: "messages", css: "css", ui: "windows",
};

export class ModuleLoader {
  readonly #baseUrl: string;
  readonly #host: ModuleLoaderHost;
  #pending: Promise<void> | undefined;
  #stopPoll: (() => void) | undefined;
  /**
   * Which load this loader is on. Bumped by {@link unload}, checked after every `await`.
   *
   * A round is a chain of fetches, and `unload()` can happen in the middle of one: the player
   * disconnects, or logs out, while a window file is in flight. `unload` is synchronous and clears
   * its own books, and the round then carried on and registered its window, its schemas and its
   * slash command into the shared registries — which nothing could take back, because the loader
   * had already forgotten it ever asked. The orphan stayed on screen, was repainted every frame,
   * and every module window of the next login was refused as a duplicate of it for the rest of the
   * page's life.
   */
  #generation = 0;
  /**
   * The sha1 of every file this loader currently holds, keyed `<kind>/<модуль>/<файл>`.
   *
   * The whole of the reload decision: a key that is new or whose value moved is done again, one
   * that has gone is taken back. Kept from the *index*, not from the bytes, because that is what
   * the next poll will be compared against.
   */
  readonly #sha = new Map<string, string>();
  /** Every message file that contributed at least one live message. */
  readonly files: LoadedMessageFile[] = [];
  readonly windows: LoadedWindowFile[] = [];
  readonly patches: LoadedPatchFile[] = [];
  readonly styles: LoadedStyleFile[] = [];
  /** Window files held back because the Lua owns their screen (9.08); never in `problems`. */
  readonly suppressed: SuppressedWindow[] = [];
  /** Every opcode each suppressed window uses, keyed `<модуль>/<файл>`, to tell when it is free again. */
  readonly #suppressedOpcodes = new Map<string, readonly number[]>();
  /** The opcodes the TSWoW Lua subscribes to right now (`FrameXmlClientNetworkBridge`). */
  #luaOpcodes: ReadonlySet<number> = new Set();
  #twinsQueued = false;
  /**
   * Every refusal, kept by the file that caused it.
   *
   * By file rather than in one list, and that is what makes hot reload honest: a file that is
   * loaded again drops its own complaints first, so fixing a definition and saving it makes the
   * red line go away. One flat list would have kept the old sentence next to the new file for
   * the rest of the session, and an author would be fixing something that was already fixed.
   */
  readonly #problems = new Map<string, string[]>();
  /** The cross-file checks, which are recomputed whole after every round rather than accumulated. */
  #checkProblems: readonly string[] = [];
  onStatus: ((message: string, error: boolean) => void) | undefined;
  onLoaded: (() => void) | undefined;

  /**
   * What a press could not do, most recent last.
   *
   * A ring, because these are not facts about a file: a button on a repeating key would otherwise
   * grow this list for as long as it was held, and the sixteen most recent are what an author reads.
   */
  readonly #pressProblems: string[] = [];

  /**
   * Pictures a window asked the gateway for and did not get, most recent last.
   *
   * A ring of its own rather than a line in `#problems`, for the same reason a press has one: this
   * is not learnt while the file is being read, it is learnt some milliseconds after a window is
   * drawn, and a window is drawn again every time it is re-registered or re-skinned. Deduplicated
   * for that same reason — the same missing picture arriving sixteen times would push the fifteen
   * other things an author needs to read off the end of the list.
   */
  readonly #textureProblems: string[] = [];

  /**
   * Every refusal there is right now: per file in load order, the cross-file checks, then presses
   * and pictures.
   */
  get problems(): readonly string[] {
    const all: string[] = [];
    for (const list of this.#problems.values()) all.push(...list);
    all.push(...this.#checkProblems, ...this.#pressProblems, ...this.#textureProblems);
    return all;
  }

  /** Records what one press could not do. Called by the action runner through `ModuleClient`. */
  notePressProblem(text: string): void {
    this.#pressProblems.push(text);
    if (this.#pressProblems.length > 16) this.#pressProblems.shift();
  }

  /** Records one picture that did not arrive. Called by the renderer through `ModuleClient`. */
  noteTextureProblem(text: string): void {
    if (this.#textureProblems.includes(text)) return;
    this.#textureProblems.push(text);
    if (this.#textureProblems.length > 16) this.#textureProblems.shift();
  }

  /** Records one refusal against the file that caused it. */
  #note(key: string, text: string): void {
    const list = this.#problems.get(key);
    if (list) list.push(text);
    else this.#problems.set(key, [text]);
  }

  constructor(gatewayWebSocketUrl: string, host: ModuleLoaderHost) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#host = host;
  }

  /**
   * The opcodes the TSWoW Lua is subscribed to, every time the set changes (9.08).
   *
   * A content-studio screen is generated twice — `content/ui/<id>.json` for this loader and a Lua
   * add-on for the client — and both name the same opcode pair; the studio requires opcodes unique
   * server-wide, so a shared opcode is the reliable sign of the same screen (names are transliterated
   * and are not compared). The Lua wins: it cannot be cleanly switched off once its TOC ran, while a
   * window is one registry entry. Applied on a microtask, since a load subscribes opcode by opcode.
   */
  noteLuaOpcodes(opcodes: ReadonlySet<number>): void {
    this.#luaOpcodes = new Set(opcodes);
    if (this.#twinsQueued) return;
    this.#twinsQueued = true;
    queueMicrotask(() => {
      this.#twinsQueued = false;
      this.#applyTwins();
    });
  }

  /** Every opcode a window definition sends or reads: its packet pair when enabled, its inline messages. */
  #opcodesOf(definition: ParsedWindow): number[] {
    const opcodes = definition.packets.enabled ? [definition.packets.opcodeIn, definition.packets.opcodeOut] : [];
    for (const message of definition.messages) opcodes.push(message.opcode);
    // 0 is what the parser answers for a missing opcode; no screen is identified by it.
    return [...new Set(opcodes.filter((opcode) => opcode > 0))];
  }

  /** The first of these opcodes the Lua holds, or undefined. */
  #luaTwin(opcodes: readonly number[]): number | undefined {
    return opcodes.find((opcode) => this.#luaOpcodes.has(opcode));
  }

  #suppress(entry: SuppressedWindow, opcodes: readonly number[]): void {
    this.suppressed.push(entry);
    this.#suppressedOpcodes.set(`${entry.module}/${entry.file}`, opcodes);
  }

  #unsuppress(module: string, file: string): boolean {
    const index = this.suppressed.findIndex((entry) => entry.module === module && entry.file === file);
    this.#suppressedOpcodes.delete(`${module}/${file}`);
    if (index < 0) return false;
    this.suppressed.splice(index, 1);
    return true;
  }

  /**
   * Takes down every live window the Lua now owns, and lets go of every held one it no longer does.
   * A taken-down window keeps its `#sha` key, so the poll does not fetch it every two seconds; a
   * released one loses it, so the next poll loads it again the ordinary way.
   */
  #applyTwins(): void {
    for (const window of [...this.windows]) {
      const definition = this.#host.windows.definition(window.windowId);
      if (!definition) continue;
      const opcodes = this.#opcodesOf(definition);
      const opcode = this.#luaTwin(opcodes);
      if (opcode === undefined) continue;
      this.#dropWindow(window.module, window.file);
      this.#suppress({ module: window.module, file: window.file, windowId: window.windowId, opcode }, opcodes);
    }
    let released = false;
    for (const entry of [...this.suppressed]) {
      const opcodes = this.#suppressedOpcodes.get(`${entry.module}/${entry.file}`) ?? [];
      if (this.#luaTwin(opcodes) !== undefined) continue;
      this.#unsuppress(entry.module, entry.file);
      this.#sha.delete(`ui/${entry.module}/${entry.file}`);
      released = true;
    }
    // After a round already in flight, which computed its work before these keys were cleared.
    if (released) void (this.#pending ? this.#pending.finally(() => this.poll()) : this.poll());
  }

  /** How many messages are live from this loader's files, the inline ones included. */
  get messageCount(): number {
    let total = 0;
    for (const file of this.files) total += file.count;
    for (const window of this.windows) total += window.messages;
    return total;
  }

  /** Whether the index is being re-read on a timer right now. */
  get watching(): boolean {
    return this.#stopPoll !== undefined;
  }

  /** Starts the fetch. A second call while the first is in flight joins it rather than repeating it. */
  load(): Promise<void> {
    return this.#start(true);
  }

  /**
   * Re-reads the index once and rebuilds whatever moved.
   *
   * Public so that the diagnostics pane can ask for one immediately when it is opened, rather than
   * making the author wait out the first two seconds of the timer.
   */
  poll(): Promise<void> {
    return this.#start(false);
  }

  #start(first: boolean): Promise<void> {
    if (this.#pending) return this.#pending;
    const round = this.#round(first).finally(() => {
      // Only when it is still this loader's round. `unload` drops the one in flight so that the
      // next login starts its own rather than joining a round that is about to give up — and the
      // abandoned one must not then clear the new one's slot as it settles.
      if (this.#pending === round) this.#pending = undefined;
    });
    this.#pending = round;
    return round;
  }

  /**
   * Turns the two-second poll on or off.
   *
   * On while something is looking — the «Окна» pane, the builder later — and off otherwise: a
   * directory scan every two seconds for a session nobody is authoring in is a cost with no reader.
   */
  watch(on: boolean): void {
    if (on === this.watching) return;
    if (!on) {
      this.#stopPoll?.();
      this.#stopPoll = undefined;
      return;
    }
    const schedule = this.#host.schedule;
    if (!schedule) return;
    this.#stopPoll = schedule(() => { void this.poll(); }, MODULE_POLL_MS);
  }

  /** Drops everything this loader registered. What it never registered it does not touch. */
  unload(): void {
    // First, so that a round already inside a `fetch` stops at its next `await` instead of
    // registering into registries this call is about to empty.
    this.#generation++;
    this.watch(false);
    for (const window of this.windows) {
      this.#host.packets.forget(inlineOwner(window.module, window.windowId));
      this.#host.windows.remove(window.windowId);
    }
    // Destroyed one at a time rather than by module, because a patch's own `destroy` is what puts
    // the built-in windows back the way it found them — `PatchRegistry.remove` calls it.
    for (const patch of this.patches) this.#host.patches?.remove(patch.patchId);
    for (const module of this.#modules()) {
      this.#host.packets.forget(module);
      this.#host.removeCommands?.(module);
      this.#host.removeBindings?.(module);
      this.#host.setStyle?.(module, "");
    }
    this.files.length = 0;
    this.windows.length = 0;
    this.patches.length = 0;
    this.styles.length = 0;
    this.suppressed.length = 0;
    this.#suppressedOpcodes.clear();
    this.#problems.clear();
    this.#checkProblems = [];
    this.#pressProblems.length = 0;
    this.#textureProblems.length = 0;
    this.#raw.clear();
    this.#sha.clear();
    // The round in flight, if there is one, is nobody's now: it will find the generation moved and
    // stop, and a `load()` for the next world has to start a round of its own rather than join it.
    this.#pending = undefined;
  }

  /** Every module this loader has taken anything from. */
  #modules(): string[] {
    return [...new Set([
      ...this.files.map((file) => file.module),
      ...this.windows.map((window) => window.module),
      ...this.patches.map((patch) => patch.module),
      ...this.styles.map((style) => style.module),
    ])];
  }

  async #round(first: boolean): Promise<void> {
    const generation = this.#generation;
    let index: { modules?: readonly ModuleIndexEntry[] };
    try {
      const response = await fetch(`${this.#baseUrl}/modules/index`);
      if (!response.ok) throw new Error(`шлюз ответил ${response.status}`);
      index = await response.json() as { modules?: readonly ModuleIndexEntry[] };
    } catch (error) {
      // Left unfetched rather than retried: a client with no modules is the client as it was, and
      // a gateway with no such route is the ordinary case on an older build. Said once, on the
      // first attempt: a poll that cannot reach the gateway must not shout every two seconds.
      if (first) this.onStatus?.(`модули: ${describe(error)}`, true);
      return;
    }
    // The world was left while the index was in flight. Everything below registers into the
    // client's own registries, and this loader has already given up whatever it held.
    if (generation !== this.#generation) return;

    const entries = (Array.isArray(index.modules) ? index.modules : [])
      .filter((entry): entry is ModuleIndexEntry => typeof entry?.module === "string" && entry.module.length > 0);
    const wanted = new Map<string, { entry: ModuleIndexEntry; kind: ModuleKind; file: ModuleIndexFile }>();
    for (const entry of entries) {
      for (const kind of KINDS) {
        for (const file of entry[KIND_KEY[kind]] ?? []) {
          if (typeof file?.file !== "string" || !file.file) continue;
          wanted.set(`${kind}/${entry.module}/${file.file}`, { entry, kind, file });
        }
      }
    }

    // Gone first, then changed — and messages before stylesheets before windows. The order is
    // load-bearing in exactly one place, and it is worth naming: a window may declare schemas
    // *inline*, and an opcode can only be claimed once, so whichever is registered first wins.
    // Messages first means a module's own `content/messages/*.json` beats a copy of the same
    // message written into a screen, which is the way round a module author would guess.
    const dropped = [...this.#sha.keys()].filter((key) => !wanted.has(key));
    const changed = [...wanted].filter(([key, { file }]) => this.#sha.get(key) !== file.sha1);
    if (dropped.length === 0 && changed.length === 0) {
      if (first) this.#report();
      return;
    }

    for (const key of dropped) this.#drop(key);
    for (const kind of KINDS) {
      for (const [key, { entry, file }] of changed) {
        if (!key.startsWith(`${kind}/`)) continue;
        const read = await this.#reload(kind, entry.module, file);
        if (generation !== this.#generation) return;
        // The hash is recorded only when the bytes actually arrived — a file that will not parse
        // still counts, since re-fetching it every two seconds would produce the same complaint.
        // A file the gateway refused does not: its sha1 on disk will not move again, so recording
        // it here left that window missing, with its red line, for the rest of the session over one
        // 503 or one gateway restart.
        if (read) this.#sha.set(key, file.sha1);
      }
    }
    this.#check();
    this.#report();
  }

  /** Takes back one file that the index no longer lists. */
  #drop(key: string): void {
    const [kind, module, file] = splitKey(key);
    this.#sha.delete(key);
    this.#problems.delete(key);
    if (!module || !file) return;
    if (kind === "ui") this.#dropUi(module, file);
    else if (kind === "css") this.#dropStyle(module, file);
    else this.#dropMessages(module, file);
  }

  /** Loads one file over whatever the previous copy of it registered. False when it never arrived. */
  async #reload(kind: ModuleKind, module: string, file: ModuleIndexFile): Promise<boolean> {
    // Whatever the previous copy of this file registered comes off first, so that a reload is a
    // load and never a second registration on top of the first — and its complaints go with it, so
    // that fixing a definition and saving it takes the red line off the screen.
    this.#problems.delete(`${kind}/${module}/${file.file}`);
    if (kind === "ui") this.#dropUi(module, file.file);
    else if (kind === "css") this.#dropStyle(module, file.file);
    else this.#dropMessages(module, file.file);
    if (kind === "ui") return await this.#loadUi(module, file);
    if (kind === "css") return await this.#loadStyle(module, file);
    return await this.#loadMessages(module, file);
  }

  /* -------------------------------------------------------------------------------------------
   * Message schemas
   * ----------------------------------------------------------------------------------------- */

  /**
   * Takes one message file's schemas back out of the registry.
   *
   * The registry forgets by *module*, not by file, so a module with two message files loses both
   * and the survivor is loaded again — which is what {@link #reloadMessagesOf} does. Coarser than
   * the file granularity everything else here has, and it is the registry's shape rather than a
   * choice: a per-message `forget` would be a second index over the same map for one caller.
   */
  #dropMessages(module: string, file: string): void {
    const index = this.files.findIndex((entry) => entry.module === module && entry.file === file);
    if (index < 0) return;
    this.files.splice(index, 1);
    this.#raw.delete(`messages/${module}/${file}`);
    this.#host.packets.forget(module);
    // The module's other message files went with it; they are still listed, so they are loaded
    // again from the copy of the definition each of them kept.
    this.#reloadMessagesOf(module);
  }

  /** Re-defines every message file of one module that is still listed, after a `forget`. */
  #reloadMessagesOf(module: string): void {
    const survivors = this.files.filter((entry) => entry.module === module);
    for (const entry of survivors) {
      const raw = this.#raw.get(`messages/${module}/${entry.file}`);
      if (raw === undefined) continue;
      const parsed = parseCustomMessages(raw);
      this.#host.packets.define(parsed.messages, module);
    }
  }

  /**
   * The bytes of every file this loader is holding, so a reload does not have to fetch a sibling.
   *
   * Kept because the registry forgets a whole module at a time: dropping one of a module's two
   * message files takes the other one with it, and re-fetching the survivor would mean a round trip
   * for a file that has not changed — on a timer, every two seconds, for as long as somebody is
   * editing.
   */
  readonly #raw = new Map<string, unknown>();

  async #loadMessages(module: string, file: ModuleIndexFile): Promise<boolean> {
    const key = `messages/${module}/${file.file}`;
    const where = `${module}/${file.file}`;
    const generation = this.#generation;
    const raw = await this.#fetchJson("messages", module, file.file, key, where);
    if (raw === undefined) return false;
    if (generation !== this.#generation) return false;
    this.#raw.set(key, raw);

    const parsed = parseCustomMessages(raw);
    for (const problem of parsed.problems) this.#note(key, `${where}: ${problem}`);
    if (!parsed.messages.length) return true;

    const result = this.#host.packets.define(parsed.messages, module);
    for (const problem of result.problems) this.#note(key, `${where}: ${problem}`);
    if (!result.defined.length) return true;
    this.files.push({
      module,
      // Per file, not per module: a module may be answered from both roots at once, one file from
      // a draft and the rest from the module itself.
      source: typeof file.source === "string" ? file.source : "module",
      file: file.file,
      sha1: typeof file.sha1 === "string" ? file.sha1 : "",
      count: result.defined.length,
    });
    return true;
  }

  /* -------------------------------------------------------------------------------------------
   * Stylesheets
   * ----------------------------------------------------------------------------------------- */

  #dropStyle(module: string, file: string): void {
    const index = this.styles.findIndex((entry) => entry.module === module && entry.file === file);
    if (index < 0) return;
    this.styles.splice(index, 1);
    this.#raw.delete(`css/${module}/${file}`);
    this.#writeStyle(module);
  }

  async #loadStyle(module: string, file: ModuleIndexFile): Promise<boolean> {
    const key = `css/${module}/${file.file}`;
    const where = `${module}/${file.file}`;
    const generation = this.#generation;
    let text: string;
    try {
      const response = await fetch(this.#url("css", module, file.file));
      if (!response.ok) throw new Error(`шлюз ответил ${response.status}`);
      text = await response.text();
    } catch (error) {
      this.#note(key, `${where}: ${describe(error)}`);
      return false;
    }
    if (generation !== this.#generation) return false;
    const scoped = prefixModuleCss(text, module);
    for (const problem of scoped.problems) this.#note(key, `${where}: ${problem}`);
    this.#raw.set(key, scoped.css);
    this.styles.push({
      module,
      source: typeof file.source === "string" ? file.source : "module",
      file: file.file,
      sha1: typeof file.sha1 === "string" ? file.sha1 : "",
      rules: scoped.rules,
    });
    this.#writeStyle(module);
    return true;
  }

  /** One `<style>` per module, holding every stylesheet it ships, in filename order. */
  #writeStyle(module: string): void {
    const parts: string[] = [];
    for (const entry of this.styles) {
      if (entry.module !== module) continue;
      const css = this.#raw.get(`css/${module}/${entry.file}`);
      if (typeof css === "string") parts.push(css);
    }
    this.#host.setStyle?.(module, parts.join("\n"));
  }

  /* -------------------------------------------------------------------------------------------
   * Windows and patches — both live under `content/ui/`
   * ----------------------------------------------------------------------------------------- */

  /**
   * Takes back whatever one `ui/` file registered, whichever of the two kinds it was.
   *
   * The kind is not asked again: the file was a window or it was a patch, and whichever list holds
   * an entry for it is the one that answers. That matters on a hot reload, where a file that was a
   * window and has just been rewritten as a patch has to lose the window before it gains the patch.
   */
  #dropUi(module: string, file: string): void {
    this.#dropWindow(module, file);
    this.#dropPatch(module, file);
  }

  #dropPatch(module: string, file: string): void {
    const index = this.patches.findIndex((entry) => entry.module === module && entry.file === file);
    if (index < 0) return;
    const [entry] = this.patches.splice(index, 1);
    if (!entry) return;
    // `remove` destroys the handle, and the handle is what puts the built-in windows back.
    this.#host.patches?.remove(entry.patchId);
    // And the stylesheet the patch carried inside itself, for exactly the reason `#dropWindow`
    // below gives — this line was missing, and a patch with `css` grew a second copy of its rules
    // on every save and left the lot on the page when the file was deleted. Measured on the fake
    // document: three saves, three copies; the file removed from the index, three copies still
    // there. It is the one asymmetry that would not show as a broken window, only as a `<style>`
    // that keeps growing, so nothing on the screen would have said so.
    this.#dropInlineStyle(module, inlinePatchStyleFile(entry.patchId));
  }

  #dropWindow(module: string, file: string): void {
    // A held-back copy of this file goes too: a reload decides again, a deleted file is gone.
    this.#unsuppress(module, file);
    const index = this.windows.findIndex((entry) => entry.module === module && entry.file === file);
    if (index < 0) return;
    const [entry] = this.windows.splice(index, 1);
    if (!entry) return;
    this.#host.packets.forget(inlineOwner(module, entry.windowId));
    this.#host.windows.remove(entry.windowId);
    // The stylesheet the window carried inside itself, which is listed under a name no index ever
    // has — so `#drop` never reaches it and only `#dropWindow` can. Without this a window with
    // `params.css` grew a second copy of its rules in the module's `<style>` on every hot reload,
    // and left them all behind when the file was deleted: on a two-second poll, once per save.
    this.#dropInlineStyle(module, inlineStyleFile(entry.windowId));
    // The command and the binding are dropped per module rather than per window, so a module with
    // two windows loses both and both are put back by the reload of the file that survived. Said
    // here because it is the one place the file granularity does not reach on its own.
    this.#host.removeCommands?.(module);
    this.#host.removeBindings?.(module);
    for (const other of this.windows) {
      if (other.module === module) this.#offerCommandAndBinding(module, other.windowId);
    }
  }

  /**
   * One `content/ui/*.json`, fetched and sent to whichever parser its `kind` names.
   *
   * The index lists every json under `ui/` and says nothing about what is in one — the gateway
   * reads directories, not files — so the kind is read here, from the bytes, and a file that is
   * neither goes to the window parser, whose refusal names both words.
   */
  async #loadUi(module: string, file: ModuleIndexFile): Promise<boolean> {
    const key = `ui/${module}/${file.file}`;
    const where = `${module}/${file.file}`;
    const generation = this.#generation;
    const raw = await this.#fetchJson("ui", module, file.file, key, where);
    if (raw === undefined) return false;
    // The world was left while this file was in flight. Everything below this line registers into
    // registries the client shares, and the loader that would take them back has already let go.
    if (generation !== this.#generation) return false;
    if (moduleUiKind(raw) === "patch") {
      this.#loadPatch(module, file, raw, key, where);
      return true;
    }
    this.#loadWindow(module, file, raw, key, where);
    return true;
  }

  /** The three tables a patch is checked against, in one place because two callers need all three. */
  #slotTables(): { slotNames: ReadonlySet<string>; fillableSlots: ReadonlySet<string>; skinnableWindows: ReadonlySet<string> } {
    return {
      slotNames: this.#host.slotNames ?? new Set<string>(),
      fillableSlots: this.#host.fillableSlots ?? new Set<string>(),
      skinnableWindows: this.#host.skinnableWindows ?? new Set<string>(),
    };
  }

  /**
   * A patch, checked against this client's own slots before a single edit is made.
   *
   * Refused whole rather than half-applied, and that is the one place the patch rule differs from
   * the window rule. A window with one broken widget is still a window the player can use; a patch
   * that hid a line and then failed to add the button that replaced it has taken something away and
   * given nothing back, and there is nothing on the screen to say so.
   */
  #loadPatch(module: string, file: ModuleIndexFile, raw: unknown, key: string, where: string): void {
    const parsed = parseWindowPatch(raw, { module });
    for (const problem of parsed.problems) this.#note(key, problem);
    const patch = parsed.patch;
    if (!patch || !patch.enabled) return;

    const apply = this.#host.applyPatch;
    const registry = this.#host.patches;
    if (!apply || !registry) {
      this.#note(key, `${where}: этот клиент не применяет правки встроенных окон`);
      return;
    }
    // Only the half that is a fact about this client. The action checks are made after the round,
    // with `#check`, because «this sendCustom names no schema» depends on which module files have
    // been read yet and refusing on it here would come and go with the order of a directory walk.
    const refusals = patchTargetProblems(patch, this.#slotTables());
    if (refusals.length > 0) {
      for (const problem of refusals) this.#note(key, problem);
      return;
    }

    const live = apply(patch);
    const clash = registry.register(live);
    if (clash) {
      this.#note(key, `${where}: ${clash}`);
      live.destroy();
      return;
    }
    this.patches.push({
      module,
      source: typeof file.source === "string" ? file.source : "module",
      file: file.file,
      sha1: typeof file.sha1 === "string" ? file.sha1 : "",
      patchId: patch.id,
      edits: patch.hide.length + patch.add.length + Object.keys(patch.classes).length,
    });
    if (patch.css) {
      // The same inline stylesheet a window may carry, through the same prefixer and into the same
      // `<style>` node. Listed under `<правка>.patch.inline`, a name no index can hold and — since
      // `ID_SHAPE` lets no id carry a dot — one no *window* of this module can produce either. A
      // module that calls its window and the patch that edits it by the same name is the ordinary
      // case, and under one shared `<id>.inline` the two would have shared one entry and one
      // stylesheet: whichever was dropped first took the other's rules with it.
      const scoped = prefixModuleCss(patch.css, module);
      for (const problem of scoped.problems) this.#note(key, `${where}: ${problem}`);
      const styleFile = inlinePatchStyleFile(patch.id);
      this.#raw.set(inlineStyleKey(module, styleFile), scoped.css);
      this.styles.push({ module, source: "inline", file: styleFile, sha1: "", rules: scoped.rules });
      this.#writeStyle(module);
    }
  }

  #loadWindow(module: string, file: ModuleIndexFile, raw: unknown, key: string, where: string): void {
    const parsed = parseWindowDefinition(raw, { module });
    for (const problem of parsed.problems) this.#note(key, problem);
    const definition = parsed.window;
    if (!definition) return;
    if (!definition.enabled) {
      // `"enabled": false` is the studio's own switch, and a screen turned off there must not
      // appear here — otherwise the switch means nothing outside the studio.
      return;
    }
    // 9.08: the Lua add-on of the same studio screen is already subscribed — no window, no inline
    // schemas, no command, no key; held until the Lua goes (`#applyTwins`).
    const opcodes = this.#opcodesOf(definition);
    const twin = this.#luaTwin(opcodes);
    if (twin !== undefined) {
      this.#suppress({ module, file: file.file, windowId: definition.id, opcode: twin }, opcodes);
      return;
    }

    // The window's own inline schemas, owned by the window rather than by the module, so that a
    // reload of this one file takes back exactly what this file declared.
    let messages = 0;
    if (definition.messages.length) {
      const result = this.#host.packets.define(definition.messages, inlineOwner(module, definition.id));
      for (const problem of result.problems) this.#note(key, `${where}: ${problem}`);
      messages = result.defined.length;
    }

    const live = this.#host.render(definition);
    const clash = this.#host.windows.register(live);
    if (clash) {
      this.#note(key, `${where}: ${clash}`);
      live.destroy();
      this.#host.packets.forget(inlineOwner(module, definition.id));
      return;
    }
    this.windows.push({
      module,
      source: typeof file.source === "string" ? file.source : "module",
      file: file.file,
      sha1: typeof file.sha1 === "string" ? file.sha1 : "",
      windowId: definition.id,
      messages,
    });
    if (definition.css) {
      // A window may carry its stylesheet inline as well as beside itself; both go through the same
      // prefixer, and the module's `<style>` is rewritten so the two cannot fight over the node.
      // Listed under `<окно>.inline`, which is a name no index can hold — so it is taken back by
      // {@link #dropInlineStyle} from `#dropWindow` rather than by the ordinary `#drop`.
      const scoped = prefixModuleCss(definition.css, module);
      for (const problem of scoped.problems) this.#note(key, `${where}: ${problem}`);
      const styleFile = inlineStyleFile(definition.id);
      this.#raw.set(inlineStyleKey(module, styleFile), scoped.css);
      this.styles.push({ module, source: "inline", file: styleFile, sha1: "", rules: scoped.rules });
      this.#writeStyle(module);
    }
    this.#offerCommandAndBinding(module, definition.id, definition, key);
  }

  /** Takes back the stylesheet one window or one patch file carried inside itself. */
  #dropInlineStyle(module: string, file: string): void {
    const index = this.styles.findIndex((entry) => entry.module === module && entry.file === file);
    if (index < 0) return;
    this.styles.splice(index, 1);
    this.#raw.delete(inlineStyleKey(module, file));
    this.#writeStyle(module);
  }

  /** The slash command and the key a window asked for, both of them optional and both refusable. */
  #offerCommandAndBinding(module: string, windowId: string, known?: ParsedWindow, key?: string): void {
    const definition = known ?? this.#host.windows.definition(windowId);
    if (!definition) return;
    if (definition.slash) {
      const problem = this.#host.addCommand?.({
        module,
        name: definition.slash,
        help: `окно «${windowId}»`,
        run: () => { this.#host.windows.toggle(windowId); },
      });
      if (problem) this.#note(key ?? `ui/${module}/${windowId}`, `${module}/${windowId}: ${problem}`);
    }
    if (definition.binding) {
      this.#host.addBinding?.({
        action: `module:${module}:${definition.binding}`,
        module,
        group: "Модули",
        label: `${definition.binding} (${module})`,
        run: () => { this.#host.windows.toggle(windowId); },
      });
    }
  }

  /* -------------------------------------------------------------------------------------------
   * After a round
   * ----------------------------------------------------------------------------------------- */

  /**
   * The cross-file checks, made once every window that is going to load has loaded.
   *
   * They cannot be made any earlier: «this button opens a window nobody defines» is only knowable
   * once every module has had its turn, and a check made per file would accuse the first module of
   * a screen the second one was about to bring.
   */
  #check(): void {
    const ids = new Set(this.#host.windows.list().map((window) => window.id));
    const kits = this.#host.soundKits ?? new Set<string>();
    const context = {
      windowIds: ids,
      message: (name: string) => this.#host.packets.message(name),
      soundKits: kits,
    };
    const found: string[] = [];
    for (const window of this.windows) {
      const definition = this.#host.windows.definition(window.windowId);
      if (!definition) continue;
      found.push(...checkWindowActions(definition, context));
    }
    // A patch is checked again here for the same reason a window is: «this button opens a window
    // nobody defines» depends on which modules loaded, and the answer at the moment this one file
    // was read is not the answer for the whole round.
    for (const entry of this.patches) {
      const definition = this.#host.patches?.patch(entry.patchId)?.definition;
      if (!definition) continue;
      found.push(...checkWindowPatch(definition, { ...context, ...this.#slotTables() }));
    }
    // Replaced whole rather than appended: these answers are about the set of windows that is live
    // right now, and a poll that appended would show the same sentence once per two seconds.
    this.#checkProblems = found;
  }

  #report(): void {
    const counts: string[] = [];
    if (this.windows.length) counts.push(`окон ${this.windows.length}`);
    if (this.patches.length) counts.push(`правок ${this.patches.length}`);
    if (this.messageCount) counts.push(`сообщений ${this.messageCount}`);
    if (this.styles.length) counts.push(`стилей ${this.styles.length}`);
    const message = counts.length ? `модули: ${counts.join(", ")}` : "модули: файлов для клиента нет";
    const problems = this.problems.length;
    this.onStatus?.(problems ? `${message}, ошибок ${problems}` : message, problems > 0);
    this.onLoaded?.();
  }

  #url(kind: ModuleKind, module: string, file: string): string {
    return `${this.#baseUrl}/modules/${kind}/${module}/${file}`;
  }

  async #fetchJson(kind: ModuleKind, module: string, file: string, key: string, where: string): Promise<unknown> {
    try {
      const response = await fetch(this.#url(kind, module, file));
      if (!response.ok) throw new Error(`шлюз ответил ${response.status}`);
      return await response.json();
    } catch (error) {
      this.#note(key, `${where}: ${describe(error)}`);
      return undefined;
    }
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The registry owner name for the schemas a window file declares inline. */
const inlineOwner = (module: string, windowId: string): string => `${module}/${windowId}`;

/**
 * What a window's own `params.css` is listed as, in the two places that hold stylesheets.
 *
 * `.inline` rather than a real filename, and it cannot collide with one: the gateway only lists
 * `[A-Za-z0-9_-]+.css`, so nothing an index names can end in `.inline`.
 */
const inlineStyleFile = (windowId: string): string => `${windowId}.inline`;
/**
 * And what a patch's own `css` is listed as — a different suffix, on purpose.
 *
 * A module is very likely to call its window and the patch that edits that window by one name, and
 * `ID_SHAPE` allows no dot in either, so `.patch.inline` is a name the window form cannot produce.
 * Under one shared name the two entries would have been one, and dropping either file would have
 * taken the other's rules off the page with it.
 */
const inlinePatchStyleFile = (patchId: string): string => `${patchId}.patch.inline`;
const inlineStyleKey = (module: string, file: string): string => `css/${module}/${file}`;

function splitKey(key: string): [ModuleKind, string | undefined, string | undefined] {
  const cut = key.indexOf("/");
  const kind = key.slice(0, cut) as ModuleKind;
  const rest = key.slice(cut + 1);
  const gap = rest.indexOf("/");
  return [kind, rest.slice(0, gap), rest.slice(gap + 1)];
}

/* ---------------------------------------------------------------------------------------------
 * Scoping a module stylesheet
 * ------------------------------------------------------------------------------------------- */

/** Nested at-rules whose contents are ordinary rules and are therefore prefixed in turn. */
const NESTED_AT_RULES: ReadonlySet<string> = new Set([
  "@media", "@supports", "@layer", "@container", "@scope", "@starting-style",
]);
/** At-rules whose block is not made of selectors at all and must be copied through untouched. */
const OPAQUE_AT_RULES: ReadonlySet<string> = new Set([
  "@keyframes", "@-webkit-keyframes", "@font-face", "@page", "@counter-style", "@property",
]);

export interface ScopedCss {
  readonly css: string;
  /** How many style rules were prefixed. Zero means the file said nothing this client could scope. */
  readonly rules: number;
  readonly problems: readonly string[];
}

/**
 * Every rule in a module stylesheet, scoped to that module's own nodes.
 *
 * `[data-module="shop"] ` in front of every selector, and the renderer puts `data-module` on every
 * node it makes — so a rule can reach the module's own widgets and nothing else. That is the whole
 * security argument for allowing module CSS at all: `body { display: none }` becomes
 * `[data-module="shop"] body { display: none }`, which matches nothing, because there is no `body`
 * inside a window. The same for `html`, `#world`, `.game-window` and every other client selector.
 *
 * Three at-rule families are told apart, and the middle one is why this is a parser and not a
 * regular expression: `@media`, `@supports`, `@layer`, `@container`, `@scope` and `@starting-style`
 * hold ordinary rules and are recursed into; `@keyframes`, `@font-face` and the rest of the
 * descriptor blocks hold things that are *not* selectors and are copied through untouched —
 * prefixing `50%` would silently break every animation a module ships; and everything else,
 * `@import` included, is dropped with a word.
 *
 * Dropped rather than copied through, which is the way round it has to be: `@import` fetches a
 * stylesheet from wherever it likes and nothing downstream would scope it, and an at-rule this
 * client has not been taught may well hold selectors — `@scope (:root) { body { display: none } }`
 * was exactly that, and copying it through handed a module the one rule the prefix exists to make
 * unreachable. An unknown at-rule that ought to pass belongs in one of the two lists above, by
 * name, by somebody who has read what its block holds.
 */
export function prefixModuleCss(css: string, module: string): ScopedCss {
  const problems: string[] = [];
  // The module name is `[A-Za-z0-9_-]` by the gateway's own rule, so nothing here can need
  // escaping — but a selector built out of somebody's file name is exactly the place where that
  // stops being true quietly, so it is checked rather than assumed.
  const safe = module.replace(/[^A-Za-z0-9_-]/g, "");
  const prefix = `[data-module="${safe}"]`;
  let rules = 0;

  const scope = (source: string, depth: number): string => {
    if (depth > 8) {
      problems.push("правила вложены глубже восьми уровней — остаток файла пропущен");
      return "";
    }
    let out = "";
    let index = 0;
    while (index < source.length) {
      const next = readPrelude(source, index);
      if (next === undefined) break;
      const { prelude, at, kind } = next;
      index = next.index;
      const trimmed = prelude.trim();
      if (kind === "statement") {
        if (trimmed) {
          if (at === "@import") problems.push("@import пропущен: он тянет стиль из-за пределов модуля");
          else if (at) out += `${trimmed};\n`;
          // A bare statement that is not an at-rule is a declaration outside any rule: nothing can
          // apply it, and copying it through would leave the file looking like it did something.
        }
        continue;
      }
      const block = readBlock(source, index);
      index = block.index;
      if (at && OPAQUE_AT_RULES.has(at)) {
        out += `${trimmed} {${block.body}}\n`;
        continue;
      }
      if (at && NESTED_AT_RULES.has(at)) {
        out += `${trimmed} {\n${scope(block.body, depth + 1)}}\n`;
        continue;
      }
      if (at) {
        // An at-rule this client has not been taught is dropped, with a word — the same treatment
        // `@import` gets, and for the same reason. Copying one through unscoped is what this file
        // exists to prevent: `@scope (:root) { body { display: none } }` holds ordinary selectors,
        // so a copied-through block would put `body { display: none }` on the page and take the
        // client off the screen. `@scope` is in the nested list above now; anything the next CSS
        // release brings will be dropped until somebody puts it in one of the two lists on purpose.
        problems.push(`правило ${at} этот клиент не разбирает — оно пропущено, иначе его нечем ограничить модулем`);
        continue;
      }
      if (!trimmed) continue;
      const selectors: string[] = [];
      for (const selector of splitSelectors(trimmed)) {
        selectors.push(`${prefix} ${selector}`);
        // …and the same selector *attached* to the mark rather than under it, when it can be:
        // `[data-module="shop"].my-skin`, which is the module's own node itself. Without it a module
        // could style everything inside its own window except the window, because `WindowRender`
        // puts `data-module` on the `<section>` — and М7's `class:` could not re-skin a built-in
        // window at all, since that is exactly one element carrying the mark and nothing under it.
        // Only when the selector starts with `.`, `#`, `[` or `:`: a type selector has to come
        // first in a compound, so `[data-module="shop"]body` is a parse error, and one of those in
        // a selector list takes the whole rule down with it.
        if (ATTACHABLE_SELECTOR.test(selector)) selectors.push(`${prefix}${selector}`);
      }
      rules++;
      out += `${selectors.join(", ")} {${block.body}}\n`;
    }
    return out;
  };

  return { css: scope(css, 0), rules, problems };
}

/** Reads up to the next `{` or `;`, skipping comments and strings. */
function readPrelude(
  source: string, from: number,
): { prelude: string; index: number; at: string | undefined; kind: "block" | "statement" } | undefined {
  let index = from;
  let prelude = "";
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quoted = readString(source, index);
      prelude += quoted.text;
      index = quoted.index;
      continue;
    }
    if (char === "{") return { prelude, index: index + 1, at: atRuleOf(prelude), kind: "block" };
    if (char === ";") return { prelude, index: index + 1, at: atRuleOf(prelude), kind: "statement" };
    // A stray `}` closes a block this level does not own; the recursion handles its own.
    if (char === "}") return { prelude, index: index + 1, at: atRuleOf(prelude), kind: "statement" };
    prelude += char;
    index++;
  }
  return prelude.trim() ? { prelude, index, at: atRuleOf(prelude), kind: "statement" } : undefined;
}

/** Reads a brace-balanced block, having already stepped over its `{`. */
function readBlock(source: string, from: number): { body: string; index: number } {
  let index = from;
  let depth = 1;
  let body = "";
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quoted = readString(source, index);
      body += quoted.text;
      index = quoted.index;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return { body, index: index + 1 };
    }
    body += char;
    index++;
  }
  return { body, index };
}

function readString(source: string, from: number): { text: string; index: number } {
  const quote = source[from] as string;
  let index = from + 1;
  let text = quote;
  while (index < source.length) {
    const char = source[index] as string;
    text += char;
    index++;
    if (char === "\\") {
      if (index < source.length) {
        text += source[index] as string;
        index++;
      }
      continue;
    }
    if (char === quote) break;
  }
  return { text, index };
}

function atRuleOf(prelude: string): string | undefined {
  const trimmed = prelude.trim();
  if (!trimmed.startsWith("@")) return undefined;
  const match = /^@[-\w]+/.exec(trimmed);
  return match ? match[0].toLowerCase() : "@";
}

/**
 * A selector that may be written straight onto the module's own mark, with no combinator.
 *
 * A class, an id, an attribute or a pseudo-class — everything a compound selector may carry after
 * its type. A type selector (`body`, `div`) and `*` must come first in a compound and are therefore
 * left as descendant rules only, which is what keeps `body { display: none }` unreachable.
 */
const ATTACHABLE_SELECTOR = /^[.#[:]/;

/** Splits a selector list on commas that are not inside brackets or quotes. */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let index = 0;
  while (index < list.length) {
    const char = list[index] as string;
    if (char === '"' || char === "'") {
      const quoted = readString(list, index);
      current += quoted.text;
      index = quoted.index;
      continue;
    }
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      index++;
      continue;
    }
    current += char;
    index++;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length ? parts : [list.trim()];
}
