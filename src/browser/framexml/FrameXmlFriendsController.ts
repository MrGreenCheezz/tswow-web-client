/**
 * The ownership seam between the stock FriendsFrame (Friends/Ignore, Who, Guild, Chat and Raid
 * tabs) and the native social windows: SocialPanel.ts (`#social-window`), Guild.ts
 * (`#guild-window`), ChannelRoster.ts (`#channel-roster`).
 *
 * The world mount publishes an owner only after the stock tree passed its gate. Every entry point —
 * the Socials micro button, the HUD's social button, the chat's FriendsMicroButton, `/who`,
 * `/friends`, `/ignore`, `/gw`, `/roster`, the native menu entries and stock `ToggleFriendsFrame` —
 * goes through SocialPanel.ts/Guild.ts/ChannelRoster.ts, which ask here first: a `false` answer
 * means «not published, use the native window».
 */

/** The stock tabs by their role; `ToggleFriendsFrame(tab)` numbers them 1-5, Ignore is tab 1's subtab 2. */
export type FrameXmlFriendsTab = "friends" | "ignore" | "who" | "guild" | "channel" | "raid";

export interface FrameXmlFriendsOwner {
  isOpen(): boolean;
  /** Whether the frame is shown on this tab. */
  isTabOpen(tab: FrameXmlFriendsTab): boolean;
  /** Show on a tab (switching to it when open); undefined keeps the stock selected tab. */
  show(tab?: FrameXmlFriendsTab): void;
  /** Stock ToggleFriendsFrame semantics: the open tab closes, another tab switches, closed opens. */
  toggle(tab?: FrameXmlFriendsTab): void;
  hide(): void;
  /**
   * Select the Chat tab's row for a typed channel (`/roster Name`): its roster shows and the server
   * is asked for it. False when no joined channel matches.
   */
  selectChannel?(name: string): boolean;
}

let owner: FrameXmlFriendsOwner | undefined;

/** Publish the one gated stock FriendsFrame owner and return an identity-safe cleanup. */
export function publishFrameXmlFriends(next: FrameXmlFriendsOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.hide(); } catch { /* stale VM teardown must not block the new owner */ }
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    try { next.hide(); } catch { /* mount cleanup continues */ }
    owner = undefined;
  };
}

/** Whether the stock frame owns the social routes; the native windows step aside while it does. */
export function frameXmlFriendsPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlFriendsOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

export function frameXmlFriendsTabOpen(tab: FrameXmlFriendsTab): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isTabOpen(tab); } catch { return false; }
}

/** Toggle the stock frame (on a tab). A missing owner tells the caller to use its native fallback. */
export function toggleFrameXmlFriends(tab?: FrameXmlFriendsTab): boolean {
  const current = owner;
  if (!current) return false;
  try {
    current.toggle(tab);
  } catch {
    // The stock route stays authoritative until mount teardown; do not open the native window too.
  }
  return true;
}

/** Open the stock frame on a tab without toggling it closed. */
export function openFrameXmlFriends(tab: FrameXmlFriendsTab): boolean {
  const current = owner;
  if (!current) return false;
  try { current.show(tab); } catch { /* stays authoritative, as above */ }
  return true;
}

/**
 * The native channel roster's routes (ChannelRoster.ts). `/roster [channel]` toggles: with nothing
 * typed the open Chat tab closes, as the native roster window did, and a closed one opens on
 * `fallback` (the active chat tab's channel); a typed channel always opens on its row.
 */
export function toggleFrameXmlFriendsChannel(typed?: string, fallback?: string): boolean {
  const current = owner;
  if (!current) return false;
  const wanted = typed?.trim() ?? "";
  if (!wanted && frameXmlFriendsTabOpen("channel")) {
    try { current.toggle("channel"); } catch { /* stays authoritative, as above */ }
    return true;
  }
  return openFrameXmlFriendsChannel(wanted || fallback);
}

/** Open the stock Chat tab, on the named channel's row when one matches. */
export function openFrameXmlFriendsChannel(name?: string): boolean {
  const current = owner;
  if (!current) return false;
  try {
    current.show("channel");
    const wanted = name?.trim();
    if (wanted) current.selectChannel?.(wanted);
  } catch { /* stays authoritative, as above */ }
  return true;
}

export function closeFrameXmlFriends(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.hide(); } catch { /* teardown owns the final cleanup */ }
  return true;
}
