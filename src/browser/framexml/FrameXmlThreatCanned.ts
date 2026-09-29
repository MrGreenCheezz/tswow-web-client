/**
 * The canned seam's threat list (FrameXmlThreat.ts): one creature — the scripted target — angry at
 * the player and at party1, with the player its victim and ahead. So while the dev page's target
 * exists, `UnitThreatSituation("player", "target")` is 3, the target frame's glow is red and its
 * numeric indicator reads 100%; party1 stands at 40% of the tank. Tests move `world.threat`.
 */
import { ThreatTables } from "../../world/ThreatProtocol.js";
import { FrameXmlThreatModel, type FrameXmlThreatWorld } from "./FrameXmlThreat.js";

export interface CannedFrameXmlThreatOptions {
  /** The seam's unit token resolution, as the canned seam answers `UnitGUID` (the "0x…" text form). */
  readonly unitGuid: (unit: string) => string | undefined;
  readonly playerGuid: string;
  readonly targetGuid: string;
  readonly partyGuid: string;
  readonly inGroup: () => boolean;
}

/** The player's threat on the canned target, in the wire's hundredths: 1250.00 against party1's 500.00. */
export const CANNED_PLAYER_THREAT = 125_000;
export const CANNED_PARTY_THREAT = 50_000;

export function createCannedFrameXmlThreat(options: CannedFrameXmlThreatOptions): {
  readonly model: FrameXmlThreatModel;
  readonly world: FrameXmlThreatWorld & { readonly threat: ThreatTables };
} {
  const player = BigInt(options.playerGuid);
  const threat = new ThreatTables();
  threat.apply({
    guid: BigInt(options.targetGuid),
    highestGuid: player,
    entries: [{ guid: player, threat: CANNED_PLAYER_THREAT }, { guid: BigInt(options.partyGuid), threat: CANNED_PARTY_THREAT }],
  });
  const world = { threat, state: { selfGuid: player } };
  const model = new FrameXmlThreatModel({
    world: () => world,
    unitGuid: (unit) => {
      const guid = options.unitGuid(unit);
      return guid === undefined ? undefined : BigInt(guid);
    },
    // The canned page is never inside an instance; a canned party exists (FrameXmlFriendsCanned.ts).
    inInstance: () => false,
    inGroup: options.inGroup,
  });
  return { model, world };
}
