/**
 * Plan item 5.30 (L12, 04.10): the global cooldown from the moment a cast request leaves, not from the
 * realm's answer.
 *
 * Wow.exe 3.3.5a 12340 (read-only Ghidra, 2026-10-04), in this file's words:
 * - The request builder 0x0080ac90 sends CMSG_CAST_SPELL (or the pet's/an item's request), raises
 *   UNIT_SPELLCAST_SENT and then calls 0x00805d70, which writes an entry into the player's spell history
 *   (0x00805230): this spell, started now, with the spell's StartRecoveryCategory and its
 *   StartRecoveryTime as the global part — when either is set and the duration is not 0. Before writing
 *   it the duration takes SPELLMOD_GLOBAL_COOLDOWN, and for category 133 at exactly 1500 ms (not a melee
 *   or ranged damage class, not REQ_AMMO or ABILITY) the caster's cast speed, kept within 1000..1500 ms.
 *   It then raises ACTIONBAR_UPDATE_COOLDOWN (0x005a7cc0) and SPELL_UPDATE_COOLDOWN (0x0053bac0).
 * - The next request (0x0080cce0) asks the history first (0x00809000 → 0x00807980): a spell whose
 *   StartRecoveryCategory equals an entry's global category is refused locally, without a packet, while
 *   that entry's start + global duration is ahead. So the second /cast of a macro never leaves.
 * - SMSG_CAST_FAILED (0x00809af0) removes the spell's entry — its global part with it — only for a spell
 *   whose cooldown starts on expiry (SPELL_ATTR0_DISABLED_WHILE_ACTIVE) and a result other than
 *   NOT_READY (also 0x00807f10 for NOT_READY on such a held entry). For any other refused spell the
 *   predicted global cooldown runs out on its own. Wow.exe can afford that because 0x0080cce0 refuses
 *   locally, before anything is sent, what this client leaves to the realm (range, sight, facing,
 *   targets, reagents…); the realm (TrinityCore Spell::prepare) never starts its own global cooldown for
 *   a refused cast. Here a refusal therefore takes back the prediction it answers (the plan's «откат
 *   при отказе»), so the client never holds a spell the realm would accept.
 * - SMSG_SPELL_GO of the player's own request does not touch the global part (0x0080e1b0 writes history
 *   on a GO only for the player's pet or charm). L12-review: so the realm's acceptance (SPELL_CAST_ACCEPTED)
 *   only confirms the request's end, it no longer re-anchors it at the answer. The realm starts its own in
 *   Spell::prepare, one way after the request; a request sent at send + duration reaches it one way after
 *   that, at its end — the earlier rule (from before 5.30) refused such casts for a whole round trip.
 * - L12-review: the duration is the realm's, or shorter, never longer (game/GlobalCooldownDuration.ts):
 *   StartRecoveryTime with SPELLMOD_GLOBAL_COOLDOWN's reductions and the cast-speed rule — a hasted caster's
 *   1.5 s is 1.0-1.5 s at the realm, and the 1.5 s held here before cost every global cooldown the
 *   difference. An interrupt keeps the end, as in Wow.exe (the realm's Spell::cancel clears its own, but
 *   Wow.exe's handlers 0x00809af0/0x00809c70 do not — the only callers of the entry remover 0x00802970 are
 *   the cooldown packets, the DISABLED_WHILE_ACTIVE refusal and 0x00807f10).
 *
 * L13 (04.10): the category. Rows from `/dbc/spells?v=17` carry StartRecoveryCategory, and the predictions are
 * kept per category as the realm keys its own (SpellHistory.cpp:585-594) and 0x00807980 matches an entry's
 * global category (+0x28) with the asked spell's: a category-0 row starts none (Spell.cpp:8698), a row of
 * category C is held only by a running global cooldown of C (`globalCooldownEndFor`) — so Death Strike 45469,
 * Spirit Strike 61193-61198 or the rockets 71342/75973 (0/1500) hold nothing, Devotion Aura 48941 (38) holds
 * only category 38, and Will of the Forsaken 7744, Stoneform 20594, Gift of the Naaru 59547 (133/0) wait for
 * the running 133 one. `globalCooldownUntil` keeps the end the ordinary spells share — category 133 — for the
 * bars and sweeps that read it (L13-review: the sweeps — native bar, book, stock seam — now ask per row too:
 * `globalCooldownEndFor` and `globalCooldownSpanFor`, the holding entry's own length; the stock redraw edge follows
 * `globalCooldownRevision`). Deviation: Wow.exe itself writes an entry for a category-0 row with a time and
 * then, comparing 0 with 0, holds every category-0 spell for it (0x00805d70 tests only "category or time
 * set", 0x00807980 has no non-zero test on +0x28, unlike the Category branch); the realm takes those casts,
 * and the client here never refuses what the realm takes. Rows from an older gateway (no category) keep the
 * rule from before L13: one global cooldown for every spell with a StartRecoveryTime.
 *
 * A prediction can never stick: it ends by itself at send + its duration, and a refusal or the
 * acceptance only replaces it. Nothing here runs per frame.
 */
import type { EventBus, Unsubscribe, WorldPacketEvents } from "../../world/EventBus.js";
import {
  HASTED_GLOBAL_COOLDOWN_CATEGORY, globalCooldownDurationIn, type GlobalCooldownRow, type GlobalCooldownWorld,
} from "./GlobalCooldownDuration.js"; // L12-review; L13: + the category

/** Where the global cooldown's end lives (`game.globalCooldownUntil`), in `performance.now()` milliseconds. */
export interface PredictedGlobalCooldownSink {
  globalCooldownUntil: number;
}

/** The spell rows: StartRecoveryTime, and what the duration rule reads beside it (GlobalCooldownDuration.ts). */
export interface PredictedGlobalCooldownSpells {
  get(spellId: number): GlobalCooldownRow | undefined; // L12-review
}

/** L13: the category of a prediction whose row came without StartRecoveryCategory (an older gateway). */
const UNKNOWN_CATEGORY = -1;
/** L13: the category whose end `globalCooldownUntil` shows — the ordinary spells' (7,045 non-passive rows). */
const SHARED_CATEGORY = HASTED_GLOBAL_COOLDOWN_CATEGORY;

interface Prediction {
  readonly spellId: number;
  readonly castCount: number;
  readonly until: number;
  /** L13: StartRecoveryCategory, or UNKNOWN_CATEGORY. Never 0: category 0 predicts nothing. */
  readonly category: number;
  /** L13-review 5.30: the predicted length (`until` − send), what a sweep of this entry runs (0x00807980). */
  readonly duration: number;
}

/** L13: the model writing each sink, for `globalCooldownEndFor` (the latest one constructed). */
const models = new WeakMap<PredictedGlobalCooldownSink, PredictedGlobalCooldown>();

export class PredictedGlobalCooldown {
  readonly #sink: PredictedGlobalCooldownSink;
  readonly #spells: () => PredictedGlobalCooldownSpells | undefined;
  /** L12-review: the player's cast speed and SPELLMOD entries; none known — the rows' own numbers. */
  readonly #caster: () => GlobalCooldownWorld | undefined;
  /** The requests sent and not answered yet whose spell has a global cooldown. */
  readonly #predictions: Prediction[] = [];
  /** L13: a value someone else wrote (a test, the world's reset): it holds every category but 0. */
  #base: number;
  /** The accepted casts' ends; L13: by category (UNKNOWN_CATEGORY for a row without one). */
  readonly #confirmed = new Map<number, number>();
  /** L13-review 5.30: the length of each confirmed end, by the same category. */
  readonly #confirmedSpan = new Map<number, number>();
  /** What this model last wrote into the sink; anything else there was written by someone else. */
  #written: number;
  /** L13-review 5.30: moves whenever some category's end can have moved (a request, a refusal, a write from outside). */
  #revision = 0;
  /** L13-review 5.30: moves on every change of the state (the acceptance too) — the key of the memo below. */
  #version = 0;
  /** L13-review 5.30: the last `#hold` answer — the bars ask it for every slot every frame, nearly always for 133. */
  #memoCategory = Number.NaN;
  #memoVersion = -1;
  #heldUntil = 0;
  #heldSpan = 0;

  constructor(
    sink: PredictedGlobalCooldownSink,
    spells: () => PredictedGlobalCooldownSpells | undefined,
    caster: () => GlobalCooldownWorld | undefined = () => undefined, // L12-review
  ) {
    this.#sink = sink;
    this.#spells = spells;
    this.#caster = caster;
    this.#base = sink.globalCooldownUntil;
    this.#written = sink.globalCooldownUntil;
    models.set(sink, this); // L13
  }

  /** The request left (`SPELL_CAST_SENT`, 0x0080ac90 → 0x00805d70). */
  sent(spellId: number, castCount: number, at: number): void {
    const row = this.#spells()?.get(spellId);
    // L12-review: the realm's duration or shorter (cast speed, SPELLMOD_GLOBAL_COOLDOWN); L13: 0 for category 0.
    const gcd = globalCooldownDurationIn(this.#caster(), row);
    if (gcd <= 0) return;
    this.#adopt();
    this.#prune(at);
    this.#predictions.push({ spellId, castCount, until: at + gcd, category: row?.startRecoveryCategory ?? UNKNOWN_CATEGORY,
      duration: gcd }); // L13-review 5.30: + its length
    this.#revision++; // L13-review 5.30
    this.#version++; // L13-review 5.30
    this.#publish();
  }

  /**
   * L13: the end a spell of `category` is held to — 0x00807980's match of the entries' global category with
   * the asked spell's: this category's predictions and confirmed ends, those of unknown category, and a value
   * written by someone else. Category 0 is never held (the realm keeps none). No allocation.
   */
  endFor(category: number): number {
    if (category === 0) return 0;
    this.#hold(category); // L13-review 5.30: shared with `spanFor`, remembered until the state changes
    return this.#heldUntil;
  }

  /**
   * L13-review 5.30: the length of the entry whose end `endFor(category)` answers — the global part a sweep runs
   * (0x00807980 hands out the entry's start and its own length); 0 when none of this model's entries is that end
   * (nothing running, or a value written by someone else). No allocation.
   */
  spanFor(category: number): number {
    if (category === 0) return 0;
    this.#hold(category);
    return this.#heldSpan;
  }

  /** L13-review 5.30: a number that moves whenever some category's end can have moved — not on the acceptance. */
  revision(): number {
    this.#adopt();
    return this.#revision;
  }

  /**
   * L13-review 5.30: the end and the length for `category` into `#heldUntil`/`#heldSpan` — the base (no known length),
   * this category's and the unknown category's confirmed ends and predictions; the latest end wins, an equal end
   * with a known length over one without. Index loops and a one-category memo: the native bars ask per slot per frame.
   */
  #hold(category: number): void {
    this.#adopt();
    if (category === this.#memoCategory && this.#version === this.#memoVersion) return;
    let until = this.#base;
    let span = 0;
    for (let pass = 0; pass < 2; pass++) {
      const key = pass === 0 ? category : UNKNOWN_CATEGORY;
      const confirmed = this.#confirmed.get(key);
      if (confirmed !== undefined && (confirmed > until || (confirmed === until && span === 0))) {
        until = confirmed;
        span = this.#confirmedSpan.get(key) ?? 0;
      }
    }
    const predictions = this.#predictions;
    for (let index = 0; index < predictions.length; index++) {
      const prediction = predictions[index]!;
      if (prediction.category !== category && prediction.category !== UNKNOWN_CATEGORY) continue;
      if (prediction.until > until || (prediction.until === until && prediction.duration > span)) {
        until = prediction.until;
        span = prediction.duration;
      }
    }
    this.#heldUntil = until;
    this.#heldSpan = span;
    this.#memoCategory = category;
    this.#memoVersion = this.#version;
  }

  /**
   * The realm accepted the request (`SPELL_CAST_ACCEPTED`): its end is confirmed as it stands — a later
   * refusal of the same request (an interrupt while casting) keeps it. L12-review: no longer moved to the
   * answer's moment (Wow.exe's GO leaves the player's history alone, 0x0080e1b0).
   */
  accepted(spellId: number, castCount: number): void {
    this.#adopt();
    const prediction = this.#take(spellId, castCount);
    if (!prediction) return;
    // L13: confirmed in its own category.
    if (prediction.until > (this.#confirmed.get(prediction.category) ?? 0)) {
      this.#confirmed.set(prediction.category, prediction.until);
      this.#confirmedSpan.set(prediction.category, prediction.duration); // L13-review 5.30
    }
    this.#version++; // L13-review 5.30: no end moved — the revision stays
    this.#publish();
  }

  /** The realm refused the request (`SMSG_CAST_FAILED`): its prediction is taken back. */
  refused(spellId: number, castCount: number): void {
    this.#adopt();
    if (!this.#take(spellId, castCount)) return;
    this.#revision++; // L13-review 5.30
    this.#version++; // L13-review 5.30
    this.#publish();
  }

  /**
   * A value written by anyone else (a test, a reset) becomes the base the predictions stand on; L13: and the
   * confirmed ends of every category go with it, as the single confirmed end did.
   */
  #adopt(): void {
    const current = this.#sink.globalCooldownUntil;
    if (current === this.#written) return;
    this.#base = current;
    this.#confirmed.clear();
    this.#confirmedSpan.clear(); // L13-review 5.30
    this.#written = current;
    this.#revision++; // L13-review 5.30
    this.#version++; // L13-review 5.30
  }

  #prune(now: number): void {
    for (let index = this.#predictions.length - 1; index >= 0; index--) {
      if (this.#predictions[index]!.until <= now) this.#predictions.splice(index, 1);
    }
  }

  #take(spellId: number, castCount: number): Prediction | undefined {
    const index = this.#predictions.findIndex((entry) => entry.spellId === spellId && entry.castCount === castCount);
    if (index < 0) return undefined;
    return this.#predictions.splice(index, 1)[0]; // L12-review: the taken one (its end, for the acceptance)
  }

  /** L13: the sink shows the shared category's end (133), and any of unknown category (an older gateway's rows). */
  #publish(): void {
    let until = Math.max(this.#base, this.#confirmed.get(SHARED_CATEGORY) ?? 0, this.#confirmed.get(UNKNOWN_CATEGORY) ?? 0);
    for (const prediction of this.#predictions) {
      if ((prediction.category === SHARED_CATEGORY || prediction.category === UNKNOWN_CATEGORY) && prediction.until > until) {
        until = prediction.until;
      }
    }
    this.#written = until;
    this.#sink.globalCooldownUntil = until;
  }
}

/**
 * L13 (5.30): when the global cooldown holding a spell row ends — what the cast guard (SpellCastGuard.ts) asks.
 * A row with StartRecoveryCategory: 0 for category 0, else the end of its own category (`endFor`) — or the
 * sink's value when no model writes it. A row without it (an older gateway): the sink's value for a row with a
 * StartRecoveryTime and 0 for one without, the rule from before L13.
 */
export function globalCooldownEndFor(sink: PredictedGlobalCooldownSink, row: GlobalCooldownRow | undefined): number {
  if (!row) return 0;
  const category = row.startRecoveryCategory;
  if (category === undefined) return row.startRecoveryTime > 0 ? sink.globalCooldownUntil : 0;
  if (category === 0) return 0;
  const model = models.get(sink);
  return model ? model.endFor(category) : sink.globalCooldownUntil;
}

/**
 * L13-review 5.30: the length of the global cooldown that `globalCooldownEndFor` holds this row to — what a sweep runs
 * (Wow.exe 0x00807980 answers the holding entry's start and its own length): the 1000-ms 133 entry for a 1500-ms or a
 * timeless 133 row, its own 38 entry for Аура благочестия. A row without StartRecoveryCategory reads the shared (133)
 * entry its end comes from. 0 — not held, or no length known (no model, a value written by someone else): the caller
 * falls back to the row's own duration. No allocation.
 */
export function globalCooldownSpanFor(sink: PredictedGlobalCooldownSink, row: GlobalCooldownRow | undefined): number {
  if (!row) return 0;
  const category = row.startRecoveryCategory;
  if (category === 0 || (category === undefined && !(row.startRecoveryTime > 0))) return 0;
  return models.get(sink)?.spanFor(category ?? SHARED_CATEGORY) ?? 0;
}

/**
 * L13-review 5.30: a number that moves whenever the end of any category can have moved (a request, a refusal, a value
 * written by someone else) — the stock redraw edge (LiveWorldSeam): Wow.exe raises ACTIONBAR_UPDATE_COOLDOWN and
 * SPELL_UPDATE_COOLDOWN after every history write (0x00805d70), a category-38 one too, which moves no shared end.
 * Without a model, the sink's own value (the edge as before).
 */
export function globalCooldownRevision(sink: PredictedGlobalCooldownSink): number {
  return models.get(sink)?.revision() ?? sink.globalCooldownUntil;
}

/** L13-review 5.30: the three questions above about one sink, as the stock seam takes them (FrameXmlWorldMount). */
export interface GlobalCooldownView {
  endFor(row: GlobalCooldownRow | undefined): number;
  spanFor(row: GlobalCooldownRow | undefined): number;
  revision(): number;
}

/** L13-review 5.30: a view of `sink`, made once (the seam's context), not per call. */
export function globalCooldownView(sink: PredictedGlobalCooldownSink): GlobalCooldownView {
  return {
    endFor: (row) => globalCooldownEndFor(sink, row),
    spanFor: (row) => globalCooldownSpanFor(sink, row),
    revision: () => globalCooldownRevision(sink),
  };
}

/**
 * The world's events the model listens to; L12-review: and, when it has them, the player's cast speed and
 * SPELLMOD entries (`WorldClient.state`, `.spellModifiers`) the duration is read from.
 */
export interface PredictedGlobalCooldownWorld extends GlobalCooldownWorld {
  readonly events: Pick<EventBus<WorldPacketEvents>, "on">;
}

/**
 * Subscribe one model to a world's cast events. `current` is false once the page moved to another world
 * (the old one's late events change nothing); `now` is the clock the requests are stamped with.
 */
export function attachPredictedGlobalCooldown(
  world: PredictedGlobalCooldownWorld,
  sink: PredictedGlobalCooldownSink,
  spells: () => PredictedGlobalCooldownSpells | undefined,
  current: () => boolean = () => true,
  now: () => number = () => performance.now(),
): Unsubscribe[] {
  const model = new PredictedGlobalCooldown(sink, spells, () => world); // L12-review
  return [
    () => { if (models.get(sink) === model) models.delete(sink); }, // L13: detached, the sink's value stands alone
    world.events.on("SPELL_CAST_SENT", ({ spellId, castCount }) => {
      if (current()) model.sent(spellId, castCount, now());
    }),
    world.events.on("SPELL_CAST_ACCEPTED", ({ spellId, castId }) => {
      if (current()) model.accepted(spellId, castId); // L12-review: the answer's moment is not the anchor
    }),
    world.events.on("SPELL_CAST_RESULT", ({ spellId, castCount, refusal }) => {
      // Only SMSG_CAST_FAILED (`refusal`, always the player's own request) takes a prediction back; the
      // interrupt pair (SMSG_SPELL_FAILURE/_FAILED_OTHER) and a GO's success keep the end.
      if (refusal === true && current()) model.refused(spellId, castCount);
    }),
  ];
}
