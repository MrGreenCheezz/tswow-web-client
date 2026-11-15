/**
 * Plan item 5.05 (15.11): a looping clip coming round is an animation start for the sheath rule — Wow.exe 3.3.5a 12340
 * calls back its animation player 0x007385c0 at a sequence's end, and 0x007385c0 ends in the sheath rule 0x00738180
 * (world/AnimationSheathRule.ts).
 *
 * Measured on the stand's Wow.exe (15.11, F:/WowOracle/runs/sheath6-run-600, -run-2000, -stop-2000 .json/.bones):
 * running, with Commanding Shout's answer held back, the sword went to the back and CMSG_SET_SHEATHED 0 went out
 * 1.33-1.34 s after the run began — two rounds of HumanMale's Run (667 ms, no variations), with no other start
 * between. The renderer already restarts a clip with variations at its cycle end (`#drawAgainAtCycleEnd`, which
 * counts as a start); a clip without variations keeps looping in the mixer, so its round is counted here.
 */
export function cycleEndIsSheathStart(round: boolean, loop: boolean, forward: boolean, overlaid: boolean, variations: boolean): boolean {
  return round && loop && forward && !overlaid && !variations;
}
