/**
 * Environment vegetation classifier (1.23), pure and three-free.
 *
 * The world renderer needs to know which outdoor doodads are trees for three things: the legacy
 * vegetation leash (600 vs 400 yards for M2s without a published radius), the grow-in from 25 %,
 * and the trunk-and-canopy stand-in while the model is on its way. The old rule was a substring
 * test of the whole archive path (`/tree|oak|pine|willow|bush|shrub/i`), which also matched street
 * lamps (`…STREETLAMP…`, «sTREEt»), dragon and snake spines («sPINE»), stumps, logs, roots, trunks,
 * tree huts, smoke emitters and herb nodes: 3 936 of the 96 553 objects it called trees in the
 * cached tiles of the 424 outdoor ADTs (docs/implementation/probes/A7b/probe-trees3.out.txt).
 *
 * The rule here was fitted to that list of names, not to memory: lower-cased, a veto on any
 * directory, then a veto on the basename, then the plant stems on the basename or a leaf directory
 * that is itself a tree/bush/shrub folder. Over the same corpus it keeps 92 617 objects and adds
 * none. `VegetationWind.ts` has its own botanical rule for wind and is deliberately not shared:
 * its `wall` veto rejects `DUSTWALLOWBUSH` and it misses `DUSKWOODTREESPOOKLESS`.
 */

const DIRECTORY_VETO = /tradeskillnodes|skillactivated|bones|smoke|lamps?|lampposts|firefx|skeleton|treehuts|treelogs|treestumps|stumps|rocktrees/;
const BASENAME_VETO = /street|spine|smoke|stump|hut|log|branch|root|trunk|lamp|fx|rocktree/;
const PLANT_STEM = /tree|oak|pine|willow|bush|shrub/;
const PLANT_DIRECTORY = /(?:trees?|bushes|bush|shrubs?)$/;

/** `"tree"` when an environment model path names a tree, bush or shrub; `"none"` otherwise. */
export function environmentVegetationKind(name: string): "tree" | "none" {
  const parts = name.toLowerCase().split(/[\\/]/);
  const base = (parts.pop() ?? "").replace(/\.(?:m2|mdx|mdl)$/, "");
  if (base === "") return "none";
  for (const directory of parts) if (DIRECTORY_VETO.test(directory)) return "none";
  if (BASENAME_VETO.test(base)) return "none";
  if (PLANT_STEM.test(base)) return "tree";
  const leaf = parts.at(-1);
  return leaf !== undefined && PLANT_DIRECTORY.test(leaf) ? "tree" : "none";
}
