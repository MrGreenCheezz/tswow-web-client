import { FrameXmlFontLoader } from "./framexml_compat/FrameXmlFonts.js";

const loadedOrigins = new Set<string>();
const textureObjectUrls = new Map<string, string>();
const textureLoads = new Map<string, Promise<string | undefined>>();

/** The stock 3.3.5 backpack button, shared by the microbutton and the permanent bag bar. */
export const BACKPACK_BUTTON_TEXTURE_PATH = "Interface\\Buttons\\Button-Backpack-Up.blp";

function gatewayUrl(origin: string, route: string, path: string): string {
  const url = new URL(route, origin);
  url.searchParams.set("path", path.replaceAll("/", "\\"));
  return url.href;
}

/** A gateway-safe decoded client texture URL for ordinary image consumers. */
export function nativeUiTextureUrl(origin: string | undefined, path: string): string {
  return origin ? gatewayUrl(origin, "/texture", path) : "";
}

/**
 * The same texture as an object URL that a CSS background can use from any origin.
 *
 * A background-image request does not carry the gateway's `Origin`, so a cross-origin dev page is
 * refused and the layer silently stays empty; fetching it as a blob first turns it into a
 * same-document URL. Answers `undefined` — never throws — when the asset is absent or the
 * environment has no fetch/blob support, because this art is enhancement only.
 */
export async function loadNativeTexture(origin: string, path: string): Promise<string | undefined> {
  return loadTexture(origin, path);
}

function cssUrl(url: string): string {
  return `url(${JSON.stringify(url)})`;
}

/**
 * CSS background images do not reliably carry the gateway's Origin header (notably when the
 * gateway is served from a different dev port).  Fetching the BLP as a blob first gives the
 * browser a same-document object URL while retaining a CSS fallback when the optional asset is
 * unavailable.  The cache is process-wide because all native windows share this little corpus.
 */
function loadTexture(origin: string, path: string): Promise<string | undefined> {
  const source = nativeUiTextureUrl(origin, path);
  const cached = textureObjectUrls.get(source);
  if (cached) return Promise.resolve(cached);
  const pending = textureLoads.get(source);
  if (pending) return pending;
  const request = (async (): Promise<string | undefined> => {
    try {
      if (typeof fetch !== "function" || typeof URL.createObjectURL !== "function") return undefined;
      const response = await fetch(source, { credentials: "same-origin" });
      if (!response.ok) return undefined;
      const blob = await response.blob();
      if (blob.size <= 0) return undefined;
      const objectUrl = URL.createObjectURL(blob);
      textureObjectUrls.set(source, objectUrl);
      return objectUrl;
    } catch {
      // Client art is enhancement, never a reason to make the native UI unusable.
      return undefined;
    } finally {
      textureLoads.delete(source);
    }
  })();
  textureLoads.set(source, request);
  return request;
}

/**
 * Dresses the reliable native UI with the client corpus instead of rebuilding its behaviour in
 * Lua. All assets remain optional: the bevel/colour fallback in style.css is complete while a
 * missing MPQ row merely leaves one custom property unused.
 */
export function installNativeWowUiSkin(origin: string): void {
  document.body.classList.add("native-wow-ui");
  const style = document.documentElement.style;
  const textures: Readonly<Record<string, string>> = {
    "--wow-quickslot": "Interface\\Buttons\\UI-Quickslot2.blp",
    "--wow-action-slot": "Interface\\Buttons\\UI-Quickslot2.blp",
    "--wow-action-border": "Interface\\Buttons\\UI-ActionButton-Border.blp",
    "--wow-slot-background": "Interface\\Buttons\\UI-Slot-Background.blp",
    "--wow-dialog-bg": "Interface\\DialogFrame\\UI-DialogBox-Background.blp",
    "--wow-tooltip-bg": "Interface\\Tooltips\\UI-Tooltip-Background.blp",
    "--wow-quest-folio-left": "Interface\\QuestFrame\\UI-QuestLogDualPane-Left.blp",
    "--wow-quest-folio-right": "Interface\\QuestFrame\\UI-QuestLogDualPane-RIGHT.blp",
    "--wow-quest-book-icon": "Interface\\QuestFrame\\UI-QuestLog-BookIcon.blp",
    "--wow-quest-bullet": "Interface\\QuestFrame\\UI-Quest-BulletPoint.blp",
    "--wow-quest-break": "Interface\\QuestFrame\\UI-HorizontalBreak.blp",
    "--wow-micro-character": "Interface\\Buttons\\UI-MicroButtonCharacter-Up.blp",
    "--wow-micro-spellbook": "Interface\\Buttons\\UI-MicroButton-Spellbook-Up.blp",
    "--wow-micro-talents": "Interface\\Buttons\\UI-MicroButton-Talents-Up.blp",
    "--wow-micro-quest": "Interface\\Buttons\\UI-MicroButton-Quest-Up.blp",
    "--wow-micro-socials": "Interface\\Buttons\\UI-MicroButton-Socials-Up.blp",
    "--wow-micro-world": "Interface\\Buttons\\UI-MicroButton-World-Up.blp",
    "--wow-micro-lfg": "Interface\\Buttons\\UI-MicroButton-LFG-Up.blp",
    "--wow-micro-mainmenu": "Interface\\Buttons\\UI-MicroButton-MainMenu-Up.blp",
    "--wow-micro-inventory": BACKPACK_BUTTON_TEXTURE_PATH,
    "--wow-mail-icon": "Interface\\MailFrame\\Mail-Icon.blp",
    "--wow-mail-top-left": "Interface\\ItemTextFrame\\UI-ItemText-TopLeft.blp",
    "--wow-mail-top-right": "Interface\\Spellbook\\UI-SpellbookPanel-TopRight.blp",
    "--wow-mail-bottom-left": "Interface\\ItemTextFrame\\UI-ItemText-BotLeft.blp",
    "--wow-mail-bottom-right": "Interface\\Spellbook\\UI-SpellbookPanel-BotRight.blp",
  };
  // Leave unset until the fetch resolves.  Every consumer supplies a complete fallback, so a
  // blocked optional request cannot leave a half-painted transparent panel behind.
  void Promise.all(Object.entries(textures).map(async ([property, path]) => {
    const objectUrl = await loadTexture(origin, path);
    if (objectUrl) style.setProperty(property, cssUrl(objectUrl));
  }));

  if (loadedOrigins.has(origin) || typeof FontFace === "undefined" || !document.fonts) return;
  loadedOrigins.add(origin);
  const fonts = new FrameXmlFontLoader({
    resolve: (file) => gatewayUrl(origin, "/client/file", file),
  });
  void Promise.all([
    fonts.load("Fonts\\FRIZQT__.TTF", "WoW Friz"),
    fonts.load("Fonts\\ARIALN.TTF", "WoW Arial Narrow"),
    fonts.load("Fonts\\MORPHEUS.TTF", "WoW Morpheus"),
  ]).then((outcomes) => {
    if (outcomes.some((outcome) => outcome.status !== "failed")) {
      document.body.classList.add("native-wow-fonts-ready");
    }
  });
}
