/**
 * L7 4.16b + 3.32: the native HUD's extra rows over the character's server data — the one-time move
 * of the old rows onto stock's pages, and the toggles byte both interfaces show the rows from.
 *
 * Nothing runs before the server has answered the per-character settings slot (that is where the
 * record of the move lives, and the browser mirror shown until then may be another character's) and
 * before the player's own fields carry the toggles byte. Nothing runs while the stock FrameXML
 * interface is the chosen one: its own `SetActionBarToggles` owns the byte then
 * (InterfaceOptionsPanels.lua:1168-1195), and it never drew the native rows whose buttons move.
 *
 * The record of the move: one bit per talent group (the core keeps 144 slots per group,
 * `character_action.spec`), stored in this client's per-character settings tagged with the
 * character's GUID — the settings' `localStorage` mirror is shared by every character played in the
 * browser, so an untagged value carried over from another character must not count — and in a
 * per-browser map by realm and GUID, which is all there is when the settings slot holds another
 * client's text (Wow.exe's config cache): that text is never overwritten from here.
 */

import type { ActionButton } from "../../world/ActionBarProtocol.js";
import { planStockLayoutMigration, extraBarBit, talentGroupBit, type ConfigSlotKind } from "./ActionBarStockLayout.js";

export interface ActionBarAccountWorld {
  readonly actionButtons: readonly ActionButton[];
  setActionButton(slot: number, action: number, type: number): void;
  setActionBarToggles(bars: number): void;
}

export interface ActionBarAccountDeps {
  world: ActionBarAccountWorld;
  /** `PLAYER_FIELD_BYTES` byte 2, low four bits; undefined until the player's fields arrive. */
  serverBits(): number | undefined;
  /** The active talent group (`SMSG_TALENTS_INFO`); undefined reads as the first. */
  talentGroup(): number | undefined;
  /** L7-review: the player's class (`UNIT_FIELD_BYTES_0` byte 1); undefined until the fields arrive. */
  playerClass(): number | undefined;
  /** The native HUD is the chosen interface, not stock FrameXML. */
  nativeHud(): boolean;
  /** The four row settings as bits, as the native HUD draws them without the server's byte. */
  settingsBits(): number;
  /** The per-character settings slot as the server answered it, with this character's record in it. */
  configSlot(): { kind: ConfigSlotKind; record: number };
  /** Writes this character's settings: the rows' bits when given, and always the record. Not for a foreign slot. */
  writeSettings(bits: number | undefined, record: number): void;
  /** The per-browser record for this character. */
  localRecord(): number;
  writeLocalRecord(record: number): void;
  /** How many buttons the move copied, when it copied any. */
  onMigrated?(count: number): void;
  /** The rows' visibility may have changed outside a settings redraw (the byte took over, a send). */
  redraw?(): void;
}

export class ActionBarAccountSync {
  readonly #deps: ActionBarAccountDeps;
  #answered = false;
  /** The first full run is over: the record is read, the rows follow the byte. */
  #ready = false;
  #slotKind: ConfigSlotKind = "empty";
  /** Talent groups already moved or checked, this session and before. */
  #record = 0;
  /** The row settings as last seen, so only a change of one of the four rows is sent. */
  #lastSettingsBits = 0;
  /** What was last sent, until the gate closes: the basis of the next change before the echo lands. */
  #lastSent: number | undefined;

  constructor(deps: ActionBarAccountDeps) {
    this.#deps = deps;
  }

  /** The first full run has happened: the record is read and the rows follow the byte. */
  get ready(): boolean {
    return this.#ready;
  }

  /** The gate is open but the run waits for the player's fields (or the native HUD); a retry may run it. */
  get waiting(): boolean {
    return this.#answered && !this.#ready;
  }

  /** A retry from the wiring's timer: runs once the player's fields have come. */
  retry(): void {
    this.#run();
  }

  /** `ACCOUNT_DATA_CHANGED` for the per-character settings slot. Only the first answer opens the gate. */
  configAnswered(): void {
    if (this.#answered) return;
    this.#answered = true;
    this.#run();
  }

  /** `ACTION_BUTTONS_CHANGED`: after a talent group swap the new group's bars may need their move. */
  buttonsChanged(): void {
    if (!this.#ready) {
      this.#run();
      return;
    }
    if (!this.#deps.nativeHud()) return;
    // A swap first clears the bars (`SendActionButtons(2)`, Player.cpp:26730) and sends the new
    // group's later (Player.cpp:26855-26861); an empty list is that gap, not the group's bars.
    if (this.#deps.world.actionButtons.length === 0) return;
    if (this.#migrate(this.#deps.settingsBits()) && this.#slotKind !== "foreign") {
      this.#deps.writeSettings(undefined, this.#record);
    }
  }

  /** Any settings change: a change of one of the four rows goes to the server as the toggles byte. */
  settingsApplied(): void {
    if (!this.#ready) {
      this.#run();
      return;
    }
    const bits = this.#deps.settingsBits();
    if (!this.#deps.nativeHud()) {
      // The stock options own the byte; when the native HUD comes back it starts from the byte again.
      this.#lastSent = undefined;
      this.#lastSettingsBits = bits;
      return;
    }
    if (bits === this.#lastSettingsBits) return;
    const changed = bits ^ this.#lastSettingsBits;
    this.#lastSettingsBits = bits;
    const basis = this.#lastSent ?? this.#deps.serverBits();
    if (basis === undefined) return;
    // Only the rows whose setting moved: the other bits stay as the server has them (a settings
    // slot this client may not write can disagree with the byte).
    const next = ((basis & ~changed) | (bits & changed)) & 0x0f;
    if (next === basis) return;
    this.#lastSent = next;
    this.#deps.world.setActionBarToggles(next);
    // The settings redraw ran before this listener, with the bits that were in force then.
    this.#deps.redraw?.();
  }

  /** The rows the native HUD shows once the byte rules them; undefined while the settings still do. */
  visibleBits(): number | undefined {
    if (!this.#ready || !this.#deps.nativeHud()) return undefined;
    return this.#lastSent ?? this.#deps.serverBits();
  }

  #run(): void {
    if (this.#ready || !this.#answered || !this.#deps.nativeHud()) return;
    const server = this.#deps.serverBits();
    if (server === undefined) return;
    const slot = this.#deps.configSlot();
    this.#slotKind = slot.kind;
    this.#record = (slot.kind === "own" ? slot.record : 0) | this.#deps.localRecord();
    const firstEver = this.#record === 0;
    // What the native HUD showed until now: the rows whose old pages may hold the player's buttons.
    const shownBefore = this.#deps.settingsBits();
    this.#ready = true;
    // Set before anything is written: the writes below come back through `settingsApplied`.
    this.#lastSettingsBits = shownBefore;
    const moved = this.#migrate(shownBefore);
    let bits: number | undefined;
    if (firstEver && server === 0 && shownBefore !== 0 && this.#slotKind === "own") {
      // 3.32 transition: the native HUD never sent the byte, so a zero byte under rows the player
      // had on is this client's omission, not the player's choice; the byte takes the rows.
      // L7-review: only over this client's own settings for the character — an empty slot or
      // Wow.exe's config cache leaves the browser-wide mirror (maybe another character's) in force,
      // and the zero may be the player's choice in Wow.exe or a fresh character's.
      this.#lastSent = shownBefore;
      this.#deps.world.setActionBarToggles(shownBefore);
    } else if (shownBefore !== server) {
      // The byte rules, as at stock's world entry; the settings follow it so the window says so.
      bits = server;
    }
    if (this.#slotKind !== "foreign" && (moved || bits !== undefined)) {
      if (bits !== undefined) this.#lastSettingsBits = bits;
      this.#deps.writeSettings(bits, this.#record);
    }
    // The rows follow the byte from now on.
    this.#deps.redraw?.();
  }

  /** Copies the active group's old rows once; says whether the record changed. */
  #migrate(shown: number): boolean {
    const group = talentGroupBit(this.#deps.talentGroup());
    if ((this.#record & group) !== 0) return false;
    // L7-review: which old pages are the class's stance pages decides what moves; until the class is
    // known nothing is recorded, and the next ACTION_BUTTONS_CHANGED asks again.
    const classId = this.#deps.playerClass();
    if (classId === undefined) return false;
    // The record first: every write raises ACTION_BUTTONS_CHANGED, which comes back here.
    this.#record |= group;
    this.#deps.writeLocalRecord(this.#record);
    const writes = planStockLayoutMigration(this.#deps.world.actionButtons, (bar) => extraBarBit(shown, bar), classId);
    for (const write of writes) this.#deps.world.setActionButton(write.slot, write.action, write.type);
    if (writes.length > 0) this.#deps.onMigrated?.(writes.length);
    return true;
  }
}
