/**
 * 6.09 (line A7a, 05.10-A7a-A): the stock «Показывать плащ / шлем» C API — `ShowingHelm`,
 * `ShowingCloak`, `ShowHelm`, `ShowCloak` — used by InterfaceOptionsDisplayPanelShowCloak/ShowHelm
 * (InterfaceOptionsPanels.xml:571-645: `GetValue` is `ShowingX() and "1" or "0"`, `SetValue` calls
 * `ShowX(value)` with the string "1"/"0", and PLAYER_FLAGS_CHANGED("player") re-reads the box).
 *
 * Wow.exe (registration table at 0x00ac86d0..0x00ac86e8; `.runtime/re-2026-10-02/a403-review/`):
 * * `ShowingHelm` 0x0051bfd0 / `ShowingCloak` 0x0051c040: no active player → nil; otherwise 1 while
 *   PLAYER_FLAGS bit 10 (0x400) / bit 11 (0x800) is clear, nil while it is set. The two functions
 *   differ only in the shift (byte compare of the two bodies, 05.10).
 * * `ShowHelm` 0x0051c0b0 / `ShowCloak` 0x0051c100: no active player → nothing. The argument is read
 *   by 0x00815500 with default **true**: nil false, a boolean as is, a number when not 0, a string
 *   by 0x00815400 (first letter 0 F N f n false; 1–9 T Y t y true; else "off"/"disabled" false,
 *   "on"/"enabled" true, anything else — the empty string too — the default), any other type the
 *   default. Then 0x006e0e00 (show) / 0x006dd0f0 (hide) for the helm, 0x006e0ef0 / 0x006dd1b0 for
 *   the cloak: CMSG_SHOWING_HELM 0x2B9 / CLOAK 0x2BA with one byte goes out **only when the flag
 *   says otherwise**, and the flag is not written locally — the core flips it
 *   (CharacterHandler.cpp:1121-1135) and the field update is the answer.
 */
import { readField } from "../../world/Fields.js";
import { PLAYER_FLAGS_HIDE_CLOAK, PLAYER_FLAGS_HIDE_HELM } from "../../world/CharacterStatFields.js";
import type { WorldClient } from "../../world/WorldClient.js";

const NOTHING: readonly [] = Object.freeze([]);

export type FrameXmlWornPart = "helm" | "cloak";

/** What the four functions need from a world: the player's flag word and the two packets. */
export interface FrameXmlHelmCloakHost {
  /** `PLAYER_FLAGS` of the active player; undefined without one. */
  playerFlags(): number | undefined;
  /** CMSG_SHOWING_HELM / CMSG_SHOWING_CLOAK with the byte `show ? 1 : 0`. */
  send(part: FrameXmlWornPart, show: boolean): void;
}

export interface FrameXmlHelmCloakSeam {
  readonly helmCloak?: FrameXmlHelmCloakHost | undefined;
}

const HIDE_BIT: Readonly<Record<FrameXmlWornPart, number>> = Object.freeze({
  helm: PLAYER_FLAGS_HIDE_HELM,
  cloak: PLAYER_FLAGS_HIDE_CLOAK,
});

/** 0x00815500(L, 1, default true) followed by 0x00815400 for a string. */
export function frameXmlShowArgument(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Math.trunc(value) !== 0;
  if (typeof value !== "string") return true;
  const first = value.charAt(0);
  if (first !== "" && "0FNfn".includes(first)) return false;
  if (first !== "" && "123456789TYty".includes(first)) return true;
  const word = value.toLowerCase();
  if (word === "off" || word === "disabled") return false;
  return true; // "on", "enabled" and anything else: the default
}

/** `ShowingHelm()` / `ShowingCloak()`: 1 while shown, nil while hidden or without a player. */
export function frameXmlShowing(host: FrameXmlHelmCloakHost | undefined, part: FrameXmlWornPart): readonly unknown[] {
  const flags = host?.playerFlags();
  return flags === undefined || (flags & HIDE_BIT[part]) !== 0 ? NOTHING : [1];
}

/** `ShowHelm(value)` / `ShowCloak(value)`: a packet only when the flag says otherwise. */
export function frameXmlShow(host: FrameXmlHelmCloakHost | undefined, part: FrameXmlWornPart, value: unknown): void {
  const flags = host?.playerFlags();
  if (host === undefined || flags === undefined) return;
  const show = frameXmlShowArgument(value);
  const shown = (flags & HIDE_BIT[part]) === 0;
  if (show !== shown) host.send(part, show);
}

export type FrameXmlHelmCloakBinding = (seam: FrameXmlHelmCloakSeam, args: readonly unknown[]) => readonly unknown[];

/** The flat C API, spread into FRAMEXML_SEAM_BINDINGS; a seam without a host answers nil and sends nothing. */
export const FRAMEXML_HELM_CLOAK_BINDINGS: Readonly<Record<string, FrameXmlHelmCloakBinding>> = Object.freeze({
  ShowingHelm: (seam) => frameXmlShowing(seam.helmCloak, "helm"),
  ShowingCloak: (seam) => frameXmlShowing(seam.helmCloak, "cloak"),
  // 05.10 review: no argument at all is LUA_TNONE, which 0x00815500 answers with its default (true);
  // an explicit nil arrives as undefined in a one-long list and is false.
  ShowHelm: (seam, args) => { frameXmlShow(seam.helmCloak, "helm", args.length === 0 ? true : args[0]); return NOTHING; },
  ShowCloak: (seam, args) => { frameXmlShow(seam.helmCloak, "cloak", args.length === 0 ? true : args[0]); return NOTHING; },
});

type HelmCloakWorld = Pick<WorldClient, "state" | "setShowingHelm" | "setShowingCloak">;

/** The live host: the active player's PLAYER_FLAGS and WorldClient's two packets. */
export function liveFrameXmlHelmCloak(world: () => HelmCloakWorld | undefined): FrameXmlHelmCloakHost {
  return {
    playerFlags() {
      const current = world();
      const guid = current?.state.selfGuid;
      const self = guid === undefined ? undefined : current?.state.objects.get(guid);
      return self === undefined ? undefined : readField(self, "PLAYER_FLAGS") ?? 0;
    },
    send(part, show) {
      const current = world();
      if (part === "helm") current?.setShowingHelm(show);
      else current?.setShowingCloak(show);
    },
  };
}
