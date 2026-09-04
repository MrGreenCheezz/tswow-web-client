/**
 * Getting the client's own TrueType files past the browser's font sanitiser.
 *
 * Chrome runs every downloaded face through OTS, and OTS rejected the one face the whole login
 * screen is written in: `Fonts\FRIZQT__.TTF` came back as «cmap: Range glyph reference too high
 * (65535 > 241)» and the screen fell back to the CSS stack for all thirteen of its font objects.
 *
 * Measured, by reading the file's own tables: `maxp.numGlyphs` is 242, the `cmap` holds a format 0
 * subtable and a format 4 subtable, and of the format 4 subtable's 114 segments **exactly one** is
 * out of range — segment 113, the mandatory `U+FFFF..U+FFFF` sentinel, with `idDelta = 0`. The
 * specification requires that segment to map U+FFFF to glyph 0, which means `idDelta = 1`; this
 * file leaves it at zero, so U+FFFF maps to glyph 65535 and the font is refused. Two bytes.
 *
 * `repairFontSentinelSegment` writes those two bytes and nothing else. It is deliberately not a
 * general font fixer: it changes a segment only when the segment is the sentinel, has no glyph
 * array behind it, and currently resolves out of range — so a font that is already valid comes
 * through byte-identical, and a font that is broken some other way is still refused by OTS rather
 * than silently mangled here.
 *
 * The pass/fail table this was measured against, on this machine's Chrome, straight from
 * `/client/file` (bytes · glyphs · Latin+Cyrillic coverage · OTS):
 *
 * | file | bytes | glyphs | lat | cyr | OTS |
 * | --- | --- | --- | --- | --- | --- |
 * | `Fonts\FRIZQT__.TTF` | 63,208 | 242 | 62/62 | 66/66 | refused → **passes after the repair** |
 * | `Fonts\ARIALN.TTF` | 134,188 | 658 | 62/62 | 66/66 | passes |
 * | `Fonts\MORPHEUS.TTF` | 104,716 | 359 | 62/62 | 66/66 | passes |
 * | `Fonts\SKURRI.TTF` | 169,028 | 266 | 62/62 | 66/66 | passes |
 * | `Fonts\NIM_____.ttf` | 143,708 | 661 | 62/62 | 66/66 | passes |
 * | `Fonts\OptimusPrinceps.ttf` | 41,416 | 162 | 62/62 | 0/66 | passes |
 * | `Fonts\OptimusPrincepsSemiBold.ttf` | 57,296 | 193 | 62/62 | 0/66 | passes |
 * | `Fonts\varsity_regular.ttf` | 26,572 | 245 | 62/62 | 0/66 | passes |
 *
 * `Fonts\FRIZQT___CYR.TTF`, `Fonts\MORPHEUS_CYR.TTF` and `Fonts\SKURRI_CYR.TTF` are **404** in
 * this patch chain — the ruRU build ships the Cyrillic glyphs inside the plain names instead, which
 * the coverage column confirms. So there is no CYR sibling to map onto, and the substitution table
 * below exists only for a face that fails for some reason this repair does not cover: `NIM_____`
 * is the fallback because it is the one shipped face with both scripts and the largest glyph set.
 */

const SUBSTITUTE_FOR_UNREADABLE = "Fonts\\NIM_____.ttf";

/**
 * Fix the `cmap` format 4 sentinel segment, in place, and say how many segments changed.
 *
 * Returns the same buffer: the caller owns it and `FontFace` takes it as it stands.
 */
export function repairFontSentinelSegment(bytes: ArrayBuffer): number {
  if (bytes.byteLength < 12) return 0;
  const view = new DataView(bytes);
  const tableCount = view.getUint16(4);
  if (12 + tableCount * 16 > bytes.byteLength) return 0;
  let cmapOffset = 0;
  let maxpOffset = 0;
  for (let index = 0; index < tableCount; index++) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(
      view.getUint8(record), view.getUint8(record + 1),
      view.getUint8(record + 2), view.getUint8(record + 3),
    );
    if (tag === "cmap") cmapOffset = view.getUint32(record + 8);
    if (tag === "maxp") maxpOffset = view.getUint32(record + 8);
  }
  if (cmapOffset === 0 || maxpOffset === 0) return 0;
  if (maxpOffset + 6 > bytes.byteLength || cmapOffset + 4 > bytes.byteLength) return 0;
  const glyphCount = view.getUint16(maxpOffset + 4);

  let repaired = 0;
  const subtables = view.getUint16(cmapOffset + 2);
  for (let index = 0; index < subtables; index++) {
    const record = cmapOffset + 4 + index * 8;
    if (record + 8 > bytes.byteLength) break;
    const subtable = cmapOffset + view.getUint32(record + 4);
    if (subtable + 16 > bytes.byteLength) continue;
    if (view.getUint16(subtable) !== 4) continue;
    const segmentBytes = view.getUint16(subtable + 6);
    const endBase = subtable + 14;
    const startBase = endBase + segmentBytes + 2;
    const deltaBase = startBase + segmentBytes;
    const rangeBase = deltaBase + segmentBytes;
    if (rangeBase + segmentBytes > bytes.byteLength) continue;
    for (let segment = 0; segment < segmentBytes / 2; segment++) {
      if (view.getUint16(endBase + segment * 2) !== 0xffff) continue;
      if (view.getUint16(startBase + segment * 2) !== 0xffff) continue;
      // A non-zero range offset means the segment reads a glyph array; leave it alone.
      if (view.getUint16(rangeBase + segment * 2) !== 0) continue;
      const delta = view.getInt16(deltaBase + segment * 2);
      if (((0xffff + delta) & 0xffff) < glyphCount) continue;
      view.setInt16(deltaBase + segment * 2, 1);
      repaired += 1;
    }
  }
  return repaired;
}

/** What happened to one font file, for the host to report. */
export interface FrameXmlFontOutcome {
  readonly file: string;
  readonly family: string;
  readonly bytes: number;
  readonly repairedSegments: number;
  /** The file actually loaded, when this one could not be. */
  readonly substituted?: string;
  readonly status: "loaded" | "repaired" | "substituted" | "failed";
  readonly message?: string;
}

export interface FrameXmlFontLoaderOptions {
  /** Trusted host mapping from a WoW font path to a URL. */
  readonly resolve: (file: string) => string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Loads client fonts as real `FontFace` objects rather than as `@font-face` rules.
 *
 * The bytes have to pass through JavaScript anyway to be repaired, and once they have there is no
 * reason to ask the browser to fetch them a second time. The family names are the renderer's own
 * (`fontFamilyName`), so a font object that names `Fonts\FRIZQT__.TTF` finds the face under the
 * name the renderer will write into `font-family`.
 */
export class FrameXmlFontLoader {
  readonly #resolve: (file: string) => string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #outcomes: FrameXmlFontOutcome[] = [];
  readonly #started = new Set<string>();

  constructor(options: FrameXmlFontLoaderOptions) {
    this.#resolve = options.resolve;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** One row per font file the screen asked for, in the order they were asked for. */
  get outcomes(): readonly FrameXmlFontOutcome[] {
    return this.#outcomes;
  }

  /** Fetch, repair if needed, and publish one file under `family`. Idempotent per file. */
  async load(file: string, family: string): Promise<FrameXmlFontOutcome> {
    const key = file.toLowerCase();
    const existing = this.#outcomes.find((outcome) => outcome.file.toLowerCase() === key);
    if (existing) return existing;
    this.#started.add(key);
    const outcome = await this.loadOnce(file, family);
    this.#outcomes.push(outcome);
    return outcome;
  }

  private async loadOnce(file: string, family: string): Promise<FrameXmlFontOutcome> {
    let bytes = 0;
    let repaired = 0;
    try {
      const buffer = await this.fetchFont(file);
      bytes = buffer.byteLength;
      repaired = repairFontSentinelSegment(buffer);
      await this.publish(family, buffer);
      return {
        file, family, bytes, repairedSegments: repaired,
        status: repaired > 0 ? "repaired" : "loaded",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The substitute is a *shipped* face with the same two scripts, not a web font: a login
      // screen in the wrong serif is the original's typography missed by a little, and a login
      // screen in the browser's default sans is not the original at all.
      if (file.toLowerCase() !== SUBSTITUTE_FOR_UNREADABLE.toLowerCase()) {
        try {
          const buffer = await this.fetchFont(SUBSTITUTE_FOR_UNREADABLE);
          repairFontSentinelSegment(buffer);
          await this.publish(family, buffer);
          return {
            file, family, bytes, repairedSegments: repaired,
            substituted: SUBSTITUTE_FOR_UNREADABLE, status: "substituted", message,
          };
        } catch { /* fall through to the honest failure below */ }
      }
      return { file, family, bytes, repairedSegments: repaired, status: "failed", message };
    }
  }

  private async fetchFont(file: string): Promise<ArrayBuffer> {
    const response = await this.#fetch(this.#resolve(file));
    if (!response.ok) throw new Error(`${file}: ${response.status}`);
    return await response.arrayBuffer();
  }

  private async publish(family: string, buffer: ArrayBuffer): Promise<void> {
    const face = new FontFace(family, buffer);
    await face.load();
    document.fonts.add(face);
  }
}
