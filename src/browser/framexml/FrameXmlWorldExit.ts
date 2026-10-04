/**
 * The world exit's events (plan item 3.18, L5c 04.10).
 *
 * Wow.exe 3.3.5a 12340 (read-only Ghidra): the world exit (0x00528c30), guarded by its «in the
 * world» flag, raises CINEMATIC_STOP (event 0x169) only while a cinematic plays — its flag at
 * 0xbd07fc, which the exit also clears — then runs the subsystems' cleanups, then INSTANCE_LOCK_STOP
 * (0x279) unconditionally, then PLAYER_LEAVING_WORLD (0x100). Event ids index the name table at
 * 0x00c24eb0. The exit runs on the active player's destruction behind a loading screen (0x006e6020)
 * and in the UI teardown (0x00528f00) before PLAYER_LOGOUT.
 *
 * INSTANCE_LOCK_STOP is UIParent's `StaticPopup_Hide("INSTANCE_LOCK")` (UIParent.lua:876): the lock
 * question is hidden with the world it was asked in. This client never plays a cinematic — WorldClient
 * answers SMSG_TRIGGER_CINEMATIC at once — so CINEMATIC_STOP stays behind a source that says «no».
 */

const WITHOUT_CINEMATIC: readonly string[] = Object.freeze(["INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD"]);
const WITH_CINEMATIC: readonly string[] = Object.freeze(["CINEMATIC_STOP", "INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD"]);

/** The events 0x00528c30 raises, in its order. */
export function frameXmlWorldExitEvents(inCinematic: boolean): readonly string[] {
  return inCinematic ? WITH_CINEMATIC : WITHOUT_CINEMATIC;
}
