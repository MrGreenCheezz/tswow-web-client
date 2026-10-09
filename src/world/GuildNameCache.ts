/**
 * Plan item 3.12 (04.10, L4): guild names by guild id, for the unit tooltip's guild line of any
 * player. Wow.exe 3.3.5a 12340 (read 2026-10-04) writes that line from its guild cache by the
 * player's PLAYER_GUILDID (0x00621070 → 0x0067d930): a miss creates the record, sends
 * CMSG_GUILD_QUERY once and redraws the tooltip on the answer; the record then stays.
 *
 * Here the player's own guild keeps its one `WorldClient.guildQuery` slot (the guild frame reads its
 * rank names and emblem from it). SMSG_GUILD_QUERY_RESPONSE names its guild either way; an answer
 * this cache alone asked for, about a guild that is not the player's, leaves that slot alone.
 */
export class GuildNameCache {
  readonly #names = new Map<number, string>();
  readonly #asked = new Set<number>();

  name(guildId: number): string | undefined {
    return this.#names.get(guildId);
  }

  /** True when the caller should send CMSG_GUILD_QUERY: not known and not asked about yet. */
  shouldQuery(guildId: number): boolean {
    if (!Number.isSafeInteger(guildId) || guildId <= 0 || this.#names.has(guildId) || this.#asked.has(guildId)) return false;
    this.#asked.add(guildId);
    return true;
  }

  /**
   * Keeps an answer's name. True when only this cache asked for it and it is not the player's own
   * guild (`ownGuildId`): the player's guild slot is then left as it was.
   */
  accept(guildId: number, name: string, ownGuildId: number | undefined): boolean {
    const asked = this.#asked.delete(guildId);
    if (name.length > 0) this.#names.set(guildId, name);
    return asked && guildId !== ownGuildId;
  }
}
