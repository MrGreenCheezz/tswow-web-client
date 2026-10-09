/**
 * Dual specialisation in the stock talent window: `SetActiveTalentGroup` and the
 * `ACTIVE_TALENT_GROUP_CHANGED` edge.
 *
 * Stock callers: `Blizzard_TalentUI.lua:527` (`PlayerTalentFrameActivateButton_OnClick` →
 * `SetActiveTalentGroup(talentGroup)`, 1-based) and the frame's `ACTIVE_TALENT_GROUP_CHANGED`
 * handler (`:242`, `:366`), which re-selects the active group's tab.
 *
 * The original client (Wow.exe 3.3.5a build 12340, read-only Ghidra), in this file's words:
 * * `SetActiveTalentGroup(n)` (0x5c5e70) needs a number (otherwise a usage error), rounds it and
 *   takes `n - 1` as an unsigned group index. It casts only when that index is not the active group,
 *   is below the number of groups the last talent packet reported, and is below 2; the spell is the
 *   index's word of the table at 0xad05e8 (63645, 63644 — `world/TalentSpecSpells.ts`), cast on the
 *   player (0x80da80). Nothing else is checked here: the cast path does the rest.
 * * The player's `SMSG_TALENTS_INFO` handler (0x5c9e50, reached from 0x6cd770 when the packet's
 *   first byte is 0) stores the new groups, fires `PLAYER_TALENT_UPDATE` and then, only when the
 *   active group changed, `ACTIVE_TALENT_GROUP_CHANGED` with two numbers: the new group and the
 *   previous one, both 1-based, each 0 when its packet reported no groups (the first packet of a
 *   session has 0 as its "previous").
 *
 * The cast goes through the host's `castSpell` (`Spellbook.castSpell`), the same preflight the
 * native window's buttons use.
 */
import { TALENT_SPEC_ACTIVATION_SPELLS } from "../../world/TalentSpecSpells.js";
import { frameXmlLuaNumber, frameXmlRoundToInt } from "./FrameXmlPvpFlag.js";

/** The talent-group words of the player's last `SMSG_TALENTS_INFO`: 0-based active, and the count. */
export interface FrameXmlTalentGroupState {
  readonly activeSpec: number;
  readonly specCount: number;
}

export interface FrameXmlTalentGroupContext {
  /** The player's (not the pet's) last talent packet; undefined before the first one. */
  talents(): FrameXmlTalentGroupState | undefined;
  castSpell(spellId: number): void;
}

interface FrameXmlTalentGroupPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export const ACTIVE_TALENT_GROUP_CHANGED = "ACTIVE_TALENT_GROUP_CHANGED";

/** The client's two words before any packet: no active group, no groups. */
const NO_GROUPS: FrameXmlTalentGroupState = Object.freeze({ activeSpec: 0, specCount: 0 });

export class FrameXmlTalentGroupModel {
  readonly #context: FrameXmlTalentGroupContext;
  #pump: FrameXmlTalentGroupPump | undefined;
  #last: FrameXmlTalentGroupState = NO_GROUPS;

  constructor(context: FrameXmlTalentGroupContext) {
    this.#context = context;
  }

  /**
   * A (re)mount takes the groups already known as its starting point: the edge belongs to a packet
   * that moved the active group, not to a window that was mounted after it.
   */
  attach(pump: FrameXmlTalentGroupPump): void {
    this.#pump = pump;
    this.#last = snapshot(this.#context.talents());
  }

  detach(): void {
    this.#pump = undefined;
  }

  /** `SetActiveTalentGroup(n)`. */
  setActive(value: unknown): void {
    const number = frameXmlLuaNumber(value);
    if (number === undefined || !Number.isFinite(number)) return;
    const index = frameXmlRoundToInt(number) - 1;
    const state = snapshot(this.#context.talents());
    // The client compares the unsigned index, so 0 and negatives fall out with the upper bounds.
    if (index < 0 || index === state.activeSpec || index >= state.specCount) return;
    const spell = TALENT_SPEC_ACTIVATION_SPELLS[index];
    if (spell !== undefined) this.#context.castSpell(spell);
  }

  /**
   * After the player's talent packet was stored and PLAYER_TALENT_UPDATE fired: the group edge,
   * when the active group moved.
   */
  talentsChanged(): void {
    const next = snapshot(this.#context.talents());
    const previous = this.#last;
    this.#last = next;
    if (next.activeSpec === previous.activeSpec) return;
    this.#pump?.fire(ACTIVE_TALENT_GROUP_CHANGED,
      next.specCount === 0 ? 0 : next.activeSpec + 1,
      previous.specCount === 0 ? 0 : previous.activeSpec + 1);
  }
}

function snapshot(state: FrameXmlTalentGroupState | undefined): FrameXmlTalentGroupState {
  if (!state) return NO_GROUPS;
  return { activeSpec: state.activeSpec, specCount: state.specCount };
}

/** The part of the world seam the binding reads. */
export interface FrameXmlTalentGroupHost {
  readonly talentGroup?: FrameXmlTalentGroupModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

export const FRAMEXML_TALENT_GROUP_BINDINGS: Readonly<Record<string,
  (host: FrameXmlTalentGroupHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  SetActiveTalentGroup: (host, args) => {
    host.talentGroup?.setActive(args[0]);
    return NOTHING;
  },
});
