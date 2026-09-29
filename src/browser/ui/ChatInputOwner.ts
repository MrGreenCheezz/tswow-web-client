/**
 * Who answers the chat keys: Enter, `/`, the reply key and a shift-clicked link.
 *
 * There are two chat inputs in this client and only one of them may be the one the keys reach. The
 * native `#chat-input` is the default and is what this module falls back to; the stock FrameXML
 * `ChatFrame1EditBox` takes over only while the world mount has proved that the stock chat frame,
 * its edit box and the Lua that opens it are all present (`FrameXmlChatApi.ts`). Before this module
 * the Enter binding always focused the native input — measured on the canned route, the stock edit
 * box was `display: none` at idle and never opened — so the stock frame showed lines it could not
 * be typed into while a native form sat over it.
 *
 * A registry rather than a flag the callers test: `Actions.ts`, `ChatDock.insertIntoChat` and the
 * item slots ask for a verb, and whichever owner is installed performs it. Nothing here knows about
 * the DOM or about Lua, which is what lets the swap be tested with two plain objects.
 */

export interface ChatInputOwner {
  /**
   * Opens the input and gives it the keyboard. `text` replaces what is in it — the `/` key passes
   * `"/"`, as `OPENCHATSLASH` does — and `undefined` leaves an unsent draft where it was.
   */
  openChat(text?: string): void;
  /** Puts a link, or any text, at the caret; opens the input first when it is closed. */
  insertLink(text: string): void;
  /** Opens a whisper to whoever whispered last. Nothing happens when nobody has. */
  reply(): void;
}

let nativeOwner: ChatInputOwner | undefined;
let replacement: { readonly owner: ChatInputOwner; readonly onFailure?: () => void } | undefined;

/** The native input's verbs, registered once by `ChatDock.ts` when it loads. */
export function setNativeChatInputOwner(owner: ChatInputOwner): void {
  nativeOwner = owner;
}

/**
 * Hands the chat keys to another input until the returned cleanup runs.
 *
 * The cleanup is identity-safe: a stale mount's cleanup cannot remove a newer mount's owner. When
 * the installed owner throws, it is removed on the spot, `onFailure` runs (the mount uses it to
 * show the native form again) and the same verb is retried on the native input — Enter is never
 * left without somewhere to type.
 */
export function installChatInputOwner(owner: ChatInputOwner, onFailure?: () => void): () => void {
  const entry = onFailure ? { owner, onFailure } : { owner };
  replacement = entry;
  return () => {
    if (replacement === entry) replacement = undefined;
  };
}

/** True while an owner other than the native input answers the chat keys. */
export function chatInputReplaced(): boolean {
  return replacement !== undefined;
}

function perform(verb: (owner: ChatInputOwner) => void): boolean {
  const current = replacement;
  if (current) {
    try {
      verb(current.owner);
      return true;
    } catch (error) {
      if (replacement === current) replacement = undefined;
      try {
        current.onFailure?.();
      } catch {
        // The native fallback below still runs; a failed restore must not also lose the key.
      }
      console.warn("[chat] the replacement chat input failed; the native input takes over", error);
    }
  }
  if (!nativeOwner) return false;
  verb(nativeOwner);
  return true;
}

/** Enter and `/`. False only before any input has registered, which the caller can fall back on. */
export function openChatInput(text?: string): boolean {
  return perform((owner) => owner.openChat(text));
}

/** Shift-click on a link. */
export function insertChatLink(text: string): boolean {
  return perform((owner) => owner.insertLink(text));
}

/** The reply key. */
export function replyToLastWhisper(): boolean {
  return perform((owner) => owner.reply());
}
