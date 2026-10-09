/**
 * Putting a picture in an `<img>` when the picture comes from the gateway.
 *
 * The gateway refuses a request that carries no `Origin` header — `originAllowed` returns false for
 * `undefined` whatever the allow-list says, so even `*` does not open it — and a browser does not
 * send one for a plain image load. An `<img>` pointed at a gateway route is therefore a silent 403:
 * no error in the console, no broken-image glyph on most themes, just an empty square. The rule is
 * already written down in the header of `TextureBitmaps.ts`; item icons were breaking it, and they
 * are most of the icons in the game. Measured on this dataset: of 38,609 items, 22,489 carry no
 * `iconId` and fall back to the gateway route, so well over half of every bag, bank, mail and
 * vendor window was drawing empty slots that had nothing wrong with them.
 *
 * `fetch` sends `Origin` because it is a cross-origin request, so the bytes arrive; the only
 * question is how they reach the element.
 *
 * The blob URL is kept rather than revoked, and that is the whole design of this file. A slot is
 * not a stable element: the inventory is drawn by rebuilding every slot, so the `<img>` that asked
 * for a picture is very often detached before the picture arrives, and a fresh one takes its place
 * asking for the same thing. Revoking on load meant every rebuild started the wait over and the
 * icon never settled; caching by URL means the first draw waits once and every draw after it is a
 * plain synchronous assignment. What accumulates is one blob per *distinct icon on screen*, not one
 * per slot ever drawn — a few hundred at the very most, and the cache is capped besides.
 */

// `/spell-icon` and `/creature-icon` are `tile` cache routes (10.12): with the gateway's `g` they are
// cached for good, and a new generation is a new URL.
import { withGeneration } from "../GatewayGeneration.js";

/**
 * Whether a source has to be fetched rather than assigned.
 *
 * Pure, and separate from the element on purpose: which of the two paths a URL takes is the whole
 * decision here, and it should be checkable without a browser.
 *
 * `/icons/...` and `/creature-icons/...` are served beside the page and go straight in. Anything
 * naming another origin is the gateway, and the gateway will not answer an `<img>`.
 */
export function needsFetch(url: string, pageOrigin: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  if (url.startsWith("blob:") || url.startsWith("data:")) return false;
  return !url.startsWith(`${pageOrigin}/`);
}

/**
 * Where a spell's picture comes from, given a `SpellIcon` id.
 *
 * Eleven places in nine files built this URL for themselves as `/icons/<id>.png`: the spell book,
 * the aura strips, the talent tree and the glyph row beside it, the action bar, the pet bar, the
 * tracking menu, an item that carries its own `iconId`, the nameplate's pet-family and creature-
 * type glyphs, and the question mark the target frame falls back to. Every one of them was asking
 * the page for a file that `build-assets.bat` had put there. That is fine for the 3,204 rows the
 * bulk pass published and silent for every row a module adds after it: the page has no such file,
 * the `<img>` fails, the element is dropped, and nothing says why.
 *
 * The gateway's `/spell-icon/<id>` reads the same published directory first and falls back to
 * extracting the row's texture from the archives, so the answer is the same picture for everything
 * that was already there and a picture at all for everything that was not. The page-relative path
 * stays as the answer before login, when there is no gateway to ask yet.
 *
 * `undefined` for an id of zero, which is how both the spell rows and the pet bar spell "no icon".
 */
export function spellIconUrl(iconId: number, gatewayOrigin: string | undefined): string | undefined {
  if (!Number.isInteger(iconId) || iconId <= 0) return undefined;
  return gatewayOrigin ? withGeneration(`${gatewayOrigin}/spell-icon/${iconId}`) : `/icons/${iconId}.png`;
}

/** The same, for the picture a hunter pet family shows: `CreatureFamily.IconFile`. */
export function creatureFamilyIconUrl(familyId: number, gatewayOrigin: string | undefined): string | undefined {
  if (!Number.isInteger(familyId) || familyId <= 0) return undefined;
  return gatewayOrigin ? withGeneration(`${gatewayOrigin}/creature-icon/${familyId}`) : `/creature-icons/${familyId}.png`;
}

/**
 * How many fetched icons to keep addressable at once.
 *
 * Well above what a screen can hold — bags, bank, character and an open vendor together are a few
 * hundred slots — so in practice nothing is ever evicted and the cap is only there to stop a very
 * long session from growing without bound. Oldest first, which is insertion order for a `Map`.
 */
const ICON_CACHE_LIMIT = 512;
/** Request URL to the blob URL standing in for it, once the bytes have arrived. */
const resolved = new Map<string, string>();
/** Request URL to the fetch in flight, so ten slots wanting one icon make one request. */
const pending = new Map<string, Promise<IconAnswer>>();

function remember(url: string, objectUrl: string): void {
  resolved.set(url, objectUrl);
  while (resolved.size > ICON_CACHE_LIMIT) {
    const oldest = resolved.keys().next();
    if (oldest.done) break;
    const stale = resolved.get(oldest.value);
    resolved.delete(oldest.value);
    if (stale) URL.revokeObjectURL(stale);
  }
}

/**
 * What one fetch answered: the blob URL when there is a picture, and the status when there is not.
 *
 * The status used to be thrown away here — `if (!response.ok) return undefined` — and with it the
 * whole difference between «the gateway refused this path», «the archives do not hold it» and «the
 * page is offline». One caller now needs it: a module window that asks for a picture and does not
 * get one has to be able to say *why* in the «Окна» pane, and «404» against a path is the sentence
 * that would have caught the extensionless-path bug the first time anybody opened such a window.
 * `0` is a fetch that never got an answer at all.
 */
interface IconAnswer {
  readonly objectUrl?: string;
  readonly status: number;
}

function load(url: string): Promise<IconAnswer> {
  let inFlight = pending.get(url);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) return { status: response.status };
      const objectUrl = URL.createObjectURL(await response.blob());
      remember(url, objectUrl);
      return { objectUrl, status: response.status };
    } catch {
      return { status: 0 };
    } finally {
      pending.delete(url);
    }
  })();
  pending.set(url, inFlight);
  return inFlight;
}

/**
 * Points an image at a source, whichever side of the origin it lives on.
 *
 * Synchronous whenever it can be: a path beside the page goes straight in, and so does a gateway
 * icon that has been fetched once already. Only the first sight of an icon waits.
 *
 * Failure is reported as the element's own `error` event, so a caller that already listens for one
 * — to drop the element and leave its coloured stand-in showing — keeps working unchanged.
 *
 * `onProblem` is the second way of hearing about it, for a caller that wants the *status* rather
 * than an event: the `error` event carries nothing, and a module window has to be able to print
 * which answer the gateway gave. It is not fired for a URL that was never asked for — an empty
 * `url` short-circuits above, which is what the studio's own preview passes when there is no
 * session behind it, and «no gateway to ask» is not a broken picture.
 */
export function setIconSource(image: HTMLImageElement, url: string, onProblem?: (status: number) => void): void {
  if (!url) return;
  // Guarded because the widget tests build panels against a DOM stub that has no `location`, and a
  // relative path — which is what they pass — must not need one to be recognised.
  const origin = typeof location === "undefined" ? "" : location.origin;
  if (!needsFetch(url, origin)) {
    image.src = url;
    return;
  }
  const known = resolved.get(url);
  if (known !== undefined) {
    image.src = known;
    return;
  }
  void load(url).then((answer) => {
    if (answer.objectUrl === undefined) {
      onProblem?.(answer.status);
      image.dispatchEvent(new Event("error"));
      return;
    }
    // The element may well have been thrown away while this was in flight — the inventory redraws
    // by rebuilding — and assigning to a detached image is harmless. The next draw finds the URL
    // in the cache and sets it without waiting, which is the point of keeping it.
    image.src = answer.objectUrl;
  });
}
