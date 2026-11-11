/**
 * 11.11 (6.03): `SMSG_GAMEOBJECT_DESPAWN_ANIM` as a custom-animation index.
 *
 * Wow.exe's handler (0x0070bef0) asks the same kind table the custom-animation handler does (0x00a335e8, read at
 * `index + 2`), one row past Custom3: row 6, kind 12, Despawn — and keeps the same `index + 2` (6) while the model is
 * still loading. It removes nothing; the object's destroy comes on its own, and the playing clip holds the object
 * past it until it ends (browser/GameObjectAnimation.ts).
 */
export const GO_DESPAWN_ANIM_INDEX = 4;
