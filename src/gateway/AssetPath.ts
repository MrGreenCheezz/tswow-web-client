/**
 * Whether a string could name a file inside the client archives.
 *
 * There were six of these, one beside each route or table that needed one, and they had drifted
 * apart character by character as each place met the filename that its own class did not cover:
 * `&` was added for `PASSIVE DOODADS\FOOD&UTENSILS` in two of the six, `'` for the Nightmare voice
 * set in one, `()` for the five PvP shoulder textures in three, and the length cap was 240 in five
 * and 260 in the sixth. A path that one route served was refused by the next, and nothing said so.
 *
 * The guarantees are the ones all six already made, kept whole:
 *
 * * `..` is rejected outright, so no input can walk out of a patch directory;
 * * `:` is not in the class, so `C:\…` and an NTFS stream name cannot be spelt;
 * * a leading separator is rejected, so an input cannot start at the root or at a UNC host;
 * * control characters are not in the class;
 * * the length is capped.
 *
 * What is new is that the class is Unicode: `\p{L}` rather than `A-Za-z`. tswow does not stop a
 * module author from naming a file in their own language, and it is their own patch directory the
 * gateway reads it out of.
 *
 * Measured against this dataset, old class against new, so this is a merge and not a loosening:
 * over 1,331 creature model paths, 45,731 gameobject model paths, 18,877 `CharSections` textures,
 * 15,453 baked NPC textures, 42,954 item icon paths and 25,740 sound paths, **not one path that
 * was served is refused**. Five rows change the other way, and all five are the apostrophe that
 * only the sound class had: `SpellIcon` 3233, 3234, 3502, 3664 and 3665 — five rows naming four
 * files, because `Achievement_Boss_Kael'thasSunstrider_01.blp` is written twice, beside the three
 * `Achievement_Dungeon_Drak'Tharon_` icons — spell icons `/texture` used to answer 400 for. Four
 * paths are refused by both and deserve to be: `<empty>\KL_OnyxiasLair.wmo`, one `SpellIcon` row
 * that ends in a stray dot and so reads `…DevouringPlague..blp`, and two `SoundEntries` files
 * with no extension at all.
 *
 * The bare names of `CreatureDisplayInfo.TextureVariation` and `ItemDisplayInfo`'s component
 * fields come through here too, with `bareName`: 11,685 creature skins, 80,988 component
 * textures, 24,337 item model names and 25,482 model textures, again with nothing lost — and
 * three gained, the three displays that wear `Kel'Thuzad`.
 */

/** What one caller expects on top of the shape every asset path has. */
export interface AssetPathRules {
  /**
   * Extensions the name must end in, lower case and without the dot. An empty list accepts any
   * name, which is what a texture slot value wants: slots 11 to 13 carry a bare name that is
   * resolved beside the model.
   */
  extensions?: readonly string[];
  /** Longest name accepted. Defaults to `MAX_ASSET_PATH`. */
  maxLength?: number;
  /**
   * Whether the value has to be one name, with no separator anywhere in it.
   *
   * The DBC fields that carry a component rather than a path: `CreatureDisplayInfo`'s three
   * `TextureVariation` slots, and `ItemDisplayInfo`'s `Texture`, `ModelName` and `ModelTexture`.
   * The reader resolves them beside something else — `ModelBuild.resolveSlot` puts a creature skin
   * in the model's own directory — and it reads a value that *does* hold a separator as a full
   * path instead, so the two shapes mean different things and only one of them belongs in these
   * fields. Measured on this dataset: of 11,685 creature skins, 80,988 component textures, 24,337
   * item model names and 25,482 model textures, **not one holds a separator**, so allowing them
   * here would be a capability nothing has asked for and nothing has tested.
   */
  bareName?: boolean;
}

/**
 * The longest path any of the six accepted, which is Windows' own `MAX_PATH`.
 *
 * Five of them capped at 240 and the model route at 260. Measured over this dataset, the longest
 * path any of those tables holds is 119 characters — `World\EXPANSION01\DOODADS\HELLFIRECITADEL\`
 * `DEMONWING\PASSIVEDOODADS\DW_Banners\Hellfire_DW_banner_TypeLarge_LongChain.m2` — so the twenty
 * characters between the two old caps separate nothing that exists, and of the two numbers this
 * is the one with a reason behind it.
 */
export const MAX_ASSET_PATH = 260;

/**
 * Letters in any script, combining marks, decimal digits, and the punctuation the client's own
 * filenames use: `_`, space, `.`, `&`, `(`, `)`, `'`, `-`, and both separators.
 *
 * No `:` and no control characters — that is the half of this that is a rule rather than a list.
 */
const ASSET_PATH = /^[\p{L}\p{M}\p{Nd}_ .&()'\\\/-]+$/u;

export function validAssetPath(value: string, rules: AssetPathRules = {}): boolean {
  if (value.length === 0 || value.length > (rules.maxLength ?? MAX_ASSET_PATH)) return false;
  // Before the class, because this is the one that matters: `.` is an ordinary filename character
  // and the class cannot tell one of them from two.
  if (value.includes("..")) return false;
  // An absolute path, or a UNC host. `:` is not in the class, so a drive letter is already gone.
  if (value.startsWith("\\") || value.startsWith("/")) return false;
  if (rules.bareName && /[\\/]/.test(value)) return false;
  if (!ASSET_PATH.test(value)) return false;
  const extensions = rules.extensions ?? [];
  if (extensions.length === 0) return true;
  const lower = value.toLowerCase();
  // `.blp` on its own is not a file named `.blp`, it is an extension with nothing in front of it,
  // and the six regexes all required at least one character there.
  return extensions.some((extension) => lower.length > extension.length + 1 && lower.endsWith(`.${extension}`));
}
