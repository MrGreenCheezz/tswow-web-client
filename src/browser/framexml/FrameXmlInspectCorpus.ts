/**
 * Two places where a stock load-on-demand add-on of this lane (Blizzard_InspectUI, Blizzard_BarbershopUI)
 * meets a stricter FrameXML runtime than the client's, and the one overlay that bridges them for the
 * duration of that add-on's load only.
 *
 * * A missing `<Include>`: InspectPVPFrame.xml includes `PVPFrameTemplates.xml` relative to the add-on,
 *   which the client's MPQ chain does not have there (measured: missing). Its templates are FrameXML's
 *   and already loaded by PVPFrame.xml; the client loads the add-on regardless, the add-on runtime
 *   refuses the whole add-on on a missing include. The overlay answers an empty `<Ui>` for that one
 *   path when (and only when) the chain has no such file.
 * * A `virtual="true"` child of a template: BarberShopSelectorTemplate declares its `$parentPrev` and
 *   `$parentNext` arrows that way (Blizzard_BarberShopUI.xml:15, :36). The client creates them for
 *   every selector — BarberShopFrameSelector1Prev and the rest exist in the client, and their OnClick is
 *   the only stock call of SetNextBarberShopStyle — while FrameXmlRuntime skips a virtual child
 *   (measured: BarberShopFrameSelector1Prev is nil after the load). The overlay drops the attribute
 *   from exactly those two elements of that one file.
 *
 * Both belong in the runtime (requested from the renderer lane); the overlay then answers the files
 * unchanged and can go.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import { normalizeGluePath } from "../glue/GlueLoader.js";

const EMPTY_UI = '<Ui xmlns="http://www.blizzard.com/wow/ui/"></Ui>';

/** Paths answered with an empty `<Ui>` when the chain has no file there. */
const MISSING_INCLUDES: ReadonlySet<string> = new Set([
  normalizeGluePath("interface/addons/blizzard_inspectui/pvpframetemplates.xml"),
]);

/** Per file: the exact source fragments rewritten, and what they become. */
const REWRITES: ReadonlyMap<string, readonly (readonly [string, string])[]> = new Map([
  [normalizeGluePath("interface/addons/blizzard_barbershopui/blizzard_barbershopui.xml"), [
    ['<Button name="$parentPrev" virtual="true">', '<Button name="$parentPrev">'],
    ['<Button name="$parentNext" virtual="true">', '<Button name="$parentNext">'],
  ]],
]);

/** Apply the overlay to one read. Exported for the tests. */
export function frameXmlLaneCorpusOverlay(path: string, source: string | undefined): string | undefined {
  const key = normalizeGluePath(path);
  if (source === undefined) return MISSING_INCLUDES.has(key) ? EMPTY_UI : undefined;
  const rewrites = REWRITES.get(key);
  if (!rewrites) return source;
  let rewritten = source;
  for (const [from, to] of rewrites) rewritten = rewritten.split(from).join(to);
  return rewritten;
}

type LaneCorpus = { read(path: string): Promise<string | undefined> };

/** The overlay installed on a corpus: how many loads are inside it, and the read it wraps. */
const installed = new WeakMap<object, { loads: number; readonly own: boolean; readonly previous: LaneCorpus["read"] }>();

/**
 * Run `load` with the overlay on the boot's corpus reads, and leave the corpus as it was afterwards,
 * even when the load throws. Every other read passes through unchanged. Overlapping loads (an
 * inspection while the barber add-on loads) share one installation: the last to finish restores.
 */
export async function withFrameXmlLaneCorpus<T>(boot: Pick<FrameXmlBoot, "corpus">, load: () => Promise<T>): Promise<T> {
  const corpus = boot.corpus as unknown as LaneCorpus;
  let entry = installed.get(corpus);
  if (entry) entry.loads += 1;
  else {
    const previous = corpus.read;
    entry = { loads: 1, own: Object.prototype.hasOwnProperty.call(corpus, "read"), previous };
    installed.set(corpus, entry);
    corpus.read = async (path: string): Promise<string | undefined> =>
      frameXmlLaneCorpusOverlay(path, await previous.call(corpus, path));
  }
  const held = entry;
  try {
    return await load();
  } finally {
    held.loads -= 1;
    if (held.loads === 0) {
      installed.delete(corpus);
      if (held.own) corpus.read = held.previous;
      else delete (corpus as { read?: unknown }).read;
    }
  }
}
