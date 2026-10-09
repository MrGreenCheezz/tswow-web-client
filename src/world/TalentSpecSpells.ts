/**
 * The two spells that switch the active talent group, in group order: index 0 activates the first
 * specialisation, index 1 the second.
 *
 * Switching is not an opcode — `CMSG_SET_ACTIVE_TALENT_GROUP_OBSOLETE` is `Handle_NULL`,
 * `STATUS_NEVER` (`Opcodes.cpp:1350`) — but `SPELL_EFFECT_TALENT_SPEC_SELECT`, whose handler calls
 * `ActivateSpec(damage - 1)` (`SpellEffects.cpp:5726-5734`). The original client keeps the same
 * pair in the same order: `SetActiveTalentGroup` (Wow.exe 0x5c5e70) casts the word at
 * `0xad05e8 + 4 * (group - 1)`, and that table reads 63645, 63644.
 *
 * Shared by the native window (`ui/Talents.ts`) and the stock one (`FrameXmlTalentGroup.ts`), so
 * the two cannot disagree about which button casts what.
 */
export const TALENT_SPEC_ACTIVATION_SPELLS: readonly number[] = Object.freeze([63645, 63644]);
