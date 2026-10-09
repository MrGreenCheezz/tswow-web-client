import { REACTION_FRIENDLY, REACTION_HOSTILE } from "../../world/FactionRules.js";
import { setPortraitCanvasBackingStore, UNIT_FRAME_PORTRAIT_CSS_PIXELS } from "../PortraitCanvas.js";
import { setTip, Bar } from "./Widgets.js";
import { classColor, healthFraction, raidMarkGlyph, type UnitSnapshot } from "./UnitSnapshot.js";

/**
 * One unit frame, and every unit frame.
 *
 * Slice I2 asks for thirteen kinds of frame — target of target, focus, pet, four party slots, a
 * forty-slot raid grid, five boss frames, five arena frames — plus the player and target frames
 * that already exist in the page markup. Written one at a time that is thirteen private ideas of
 * what a health bar looks like, which is exactly the "rough that cannot be polished afterwards"
 * the widget kit exists to prevent. So there is one class, and the differences between the frames
 * are a size and a click handler.
 *
 * Nothing here reads the world. It is handed a `UnitSnapshot` — which knows how to come from either
 * the object grid or the party-stats packet — and paints it. That is what lets the raid grid work
 * at all: twenty-eight of its forty slots describe people the client has never received an object
 * for, and this class cannot tell the difference.
 */

export type UnitFrameSize = "full" | "compact" | "grid";

export interface UnitFrameOptions {
  /** `full` shows level and a power bar, `compact` drops the level, `grid` is name and health. */
  size?: UnitFrameSize;
  /** Named for the stylesheet and for tests: `party`, `raid`, `boss`, `arena`, `pet`, `focus`. */
  kind: string;
  onClick?: ((guid: bigint) => void) | undefined;
  /**
   * Right-click. The browser's own menu is suppressed here rather than at the page level: the
   * canvas already does that for itself, and every other element should keep the real one.
   */
  onContext?: ((guid: bigint, anchor: HTMLElement) => void) | undefined;
  /** Adds a model portrait canvas, used by the five single-unit secondary frames. */
  portrait?: boolean;
}

export class UnitFrame {
  readonly root: HTMLElement;
  readonly #name: HTMLElement;
  readonly #level: HTMLElement | undefined;
  readonly #mark: HTMLElement;
  readonly #role: HTMLElement;
  readonly #health: Bar;
  readonly #power: Bar | undefined;
  readonly #portrait: HTMLCanvasElement | undefined = undefined;
  readonly #size: UnitFrameSize;
  #guid: bigint | undefined;
  /**
   * Last values written to the DOM. `show` runs on every world update for every visible frame —
   * dozens of writes per packet in a raid — so unchanged values compare instead of writing.
   * The health/power bars already cache inside `Bar`; everything text-like is cached here.
   */
  #paintedName: string | undefined;
  #paintedColor: string | undefined;
  #paintedRole: string | undefined;
  #paintedClasses = 0;
  #paintedMark: string | undefined;
  #paintedLevel: string | undefined;
  #paintedReaction: string | undefined;
  #paintedThreat: string | undefined;
  #paintedTitle: string | undefined;
  /** 4.08: whether the frame is a raid grid's empty slot (guid 0), which takes no clicks. */
  #paintedEmpty = false;

  constructor(options: UnitFrameOptions) {
    this.#size = options.size ?? "full";
    this.root = document.createElement("button");
    (this.root as HTMLButtonElement).type = "button";
    this.root.className = `ui-unit-frame ui-unit-${options.kind} ui-unit-size-${this.#size}`;
    this.root.hidden = true;

    if (options.portrait) {
      this.#portrait = document.createElement("canvas");
      this.#portrait.className = "ui-unit-portrait";
      // Portraits.ts uses this stable slot marker to borrow the existing canvas into a stock
      // FrameXML portrait Texture. Party rows are renamed to party1..party4 by UnitFrameList.at;
      // the single-unit kinds already have their final slot name here.
      this.#portrait.dataset["portraitSlot"] = options.kind;
      setPortraitCanvasBackingStore(this.#portrait, UNIT_FRAME_PORTRAIT_CSS_PIXELS);
      this.#portrait.dataset["portraitReady"] = "false";
      this.root.append(this.#portrait);
    }

    const header = document.createElement("div");
    header.className = "ui-unit-header";
    this.#role = document.createElement("i");
    this.#role.className = "ui-unit-role";
    this.#role.hidden = true;
    this.#mark = document.createElement("i");
    this.#mark.className = "ui-unit-mark";
    this.#name = document.createElement("strong");
    header.append(this.#role, this.#mark, this.#name);
    if (this.#size === "full") {
      this.#level = document.createElement("span");
      this.#level.className = "ui-unit-level";
      header.append(this.#level);
    }

    this.#health = new Bar({ kind: "health", text: this.#size === "full" });
    this.root.append(header, this.#health.root);
    // The grid slot is a name and a health bar and nothing else: forty of them have to fit beside
    // the world, and a power bar per slot is forty bars nobody reads.
    if (this.#size !== "grid") {
      this.#power = new Bar({ kind: "power" });
      this.root.append(this.#power.root);
    }

    this.root.addEventListener("click", () => {
      if (this.#guid !== undefined) options.onClick?.(this.#guid);
    });
    if (options.onContext) {
      this.root.addEventListener("contextmenu", (event) => {
        if (this.#guid === undefined) return;
        event.preventDefault();
        options.onContext?.(this.#guid, this.root);
      });
    }
  }

  get guid(): bigint | undefined {
    return this.#guid;
  }

  get portraitCanvas(): HTMLCanvasElement | undefined {
    return this.#portrait;
  }

  hide(): void {
    this.#guid = undefined;
    this.#markEmpty(false);
    if (!this.root.hidden) this.root.hidden = true;
  }

  /**
   * An empty raid slot is a snapshot of guid 0 (`emptyGridSlot`): it holds its place in the
   * subgroup but is nobody, so a click must not select guid 0 or open the group menu for it.
   */
  #markEmpty(empty: boolean): void {
    if (empty === this.#paintedEmpty) return;
    this.#paintedEmpty = empty;
    if (empty) {
      this.root.dataset["empty"] = "";
      this.root.setAttribute("aria-hidden", "true");
    } else {
      delete this.root.dataset["empty"];
      this.root.removeAttribute("aria-hidden");
    }
  }

  /**
   * Paints one unit.
   *
   * `threat` is the fraction of the highest threat on whatever this unit is fighting, which is the
   * only form the number is useful in: raw threat says nothing without the tank's to compare it to.
   */
  show(snapshot: UnitSnapshot, options: {
    threat?: number | undefined;
    active?: boolean | undefined;
    /** Group standing, drawn as a glyph in front of the name rather than as more text. */
    role?: "leader" | "assistant" | "maintank" | "mainassist" | undefined;
    /** Ready-check answer, while one is running. */
    ready?: boolean | undefined;
    /**
     * Beyond typical heal range (~40 yd) although visible. Fades the frame so a heal aimed
     * there is not expected to land; unknown (no position for either end) leaves it alone.
     */
    outOfRange?: boolean | undefined;
  } = {}): void {
    const empty = snapshot.guid === 0n;
    this.#guid = empty ? undefined : snapshot.guid;
    this.#markEmpty(empty);
    if (this.root.hidden) this.root.hidden = false;
    if (snapshot.name !== this.#paintedName) {
      this.#paintedName = snapshot.name;
      this.#name.textContent = snapshot.name;
    }

    // Class colour is a player thing: a creature has a class byte too and it means something else
    // entirely, so colouring a boar by it paints it rogue yellow.
    const color = snapshot.classId !== undefined && snapshot.inGrid ? classColor(snapshot.classId) : undefined;
    const colorText = color ?? "";
    if (colorText !== this.#paintedColor) {
      this.#paintedColor = colorText;
      this.#name.style.color = colorText;
    }

    const role = options.role;
    const roleText = role === "leader" ? "★" : role === "assistant" ? "☆"
      : role === "maintank" ? "T" : role === "mainassist" ? "A" : "";
    if (roleText !== this.#paintedRole) {
      this.#paintedRole = roleText;
      this.#role.textContent = roleText;
      this.#role.hidden = role === undefined;
    }
    // Eight class toggles plus the power-bar visibility as one compared integer: a raid frame
    // repaint on every world update toggled all of these sixty times a second before.
    const classes = (options.ready === true ? 1 : 0)
      | (options.ready === false ? 2 : 0)
      | (snapshot.dead ? 4 : 0)
      | (!snapshot.online ? 8 : 0)
      | (snapshot.away ? 16 : 0)
      | (!snapshot.inGrid ? 32 : 0)
      | (options.outOfRange === true ? 64 : 0)
      | (options.active === true ? 128 : 0)
      | (this.#power !== undefined && snapshot.power !== undefined && !!snapshot.maxPower ? 0 : 256);
    if (classes !== this.#paintedClasses) {
      this.#paintedClasses = classes;
      this.root.classList.toggle("is-ready", options.ready === true);
      this.root.classList.toggle("is-not-ready", options.ready === false);
      this.root.classList.toggle("is-dead", snapshot.dead);
      this.root.classList.toggle("is-offline", !snapshot.online);
      this.root.classList.toggle("is-away", snapshot.away);
      this.root.classList.toggle("is-far", !snapshot.inGrid);
      this.root.classList.toggle("is-out-of-range", options.outOfRange === true);
      this.root.classList.toggle("is-active", options.active === true);
      if (this.#power) this.#power.root.hidden = (classes & 256) !== 0;
    }

    const mark = raidMarkGlyph(snapshot.raidMark);
    const markText = mark ?? "";
    if (markText !== this.#paintedMark) {
      this.#paintedMark = markText;
      this.#mark.textContent = markText;
      this.#mark.hidden = mark === undefined;
    }

    if (this.#level) {
      const levelText = snapshot.level === undefined ? "" : String(snapshot.level);
      if (levelText !== this.#paintedLevel) {
        this.#paintedLevel = levelText;
        this.#level.textContent = levelText;
      }
    }

    const health = snapshot.health;
    const maxHealth = snapshot.maxHealth;
    this.#health.set(health, maxHealth, this.#size === "full" && health !== undefined
      ? `${health}/${maxHealth ?? "?"}`
      : `${Math.round(healthFraction(snapshot) * 100)}%`);

    if (this.#power) {
      const hasPower = snapshot.power !== undefined && !!snapshot.maxPower;
      if (hasPower) {
        this.#power.set(snapshot.power, snapshot.maxPower);
        // The whole of the "correct power types" complaint in one line: the bar is coloured by the
        // unit's own power type, so a warrior is red and a rogue is yellow rather than everyone
        // watching an empty blue mana bar.
        this.#power.setVariant(String(snapshot.powerType ?? 0));
      }
    }

    if (options.outOfRange === true) {
      if (this.#paintedTitle !== "Вне дальности исцеления (~40 м)") {
        this.#paintedTitle = "Вне дальности исцеления (~40 м)";
        setTip(this.root, this.#paintedTitle);
      }
    } else if (this.#paintedTitle !== undefined && this.#paintedTitle.startsWith("Вне дальности")) {
      this.#paintedTitle = "";
      setTip(this.root, "");
    }

    const reaction = snapshot.reaction;
    const reactionText = reaction === undefined ? undefined
      : reaction === REACTION_HOSTILE ? "hostile"
        : reaction === REACTION_FRIENDLY ? "friendly" : "neutral";
    if (reactionText !== this.#paintedReaction) {
      this.#paintedReaction = reactionText;
      if (reactionText === undefined) delete this.root.dataset["reaction"];
      else this.root.dataset["reaction"] = reactionText;
    }

    // Threat is drawn as a border rather than a number: what a player needs from it is "am I about
    // to pull", which is a glance, and the number behind it is meaningless out of context anyway.
    const threat = options.threat;
    const threatText = threat === undefined ? undefined
      : threat >= 1 ? "tanking" : threat >= 0.8 ? "high" : threat >= 0.5 ? "some" : "low";
    if (threatText !== this.#paintedThreat) {
      this.#paintedThreat = threatText;
      if (threatText === undefined) delete this.root.dataset["threat"];
      else this.root.dataset["threat"] = threatText;
    }
  }
}

/**
 * A row or grid of frames that grows and shrinks with what it is given.
 *
 * Frames are kept and reused rather than rebuilt, because these repaint on every world update —
 * several times a second — and replacing forty buttons that often loses the click that was in
 * flight and makes the whole grid flicker.
 */
export class UnitFrameList {
  readonly root: HTMLElement;
  readonly #frames: UnitFrame[] = [];
  readonly #options: UnitFrameOptions;

  constructor(options: UnitFrameOptions & { className?: string }) {
    this.#options = options;
    this.root = document.createElement("div");
    this.root.className = options.className ?? `ui-unit-list ui-unit-list-${options.kind}`;
  }

  /** The frame at `index`, created on first use. */
  at(index: number): UnitFrame {
    let frame = this.#frames[index];
    if (!frame) {
      frame = new UnitFrame(this.#options);
      this.#frames[index] = frame;
      if (this.#options.kind === "party" && frame.portraitCanvas) {
        frame.portraitCanvas.dataset["portraitSlot"] = `party${index + 1}`;
      }
      this.root.append(frame.root);
    }
    return frame;
  }

  /** Paints the list and hides whatever is left over from a larger group. */
  render(units: ReadonlyArray<{
    snapshot: UnitSnapshot;
    threat?: number | undefined;
    active?: boolean | undefined;
    role?: "leader" | "assistant" | "maintank" | "mainassist" | undefined;
    ready?: boolean | undefined;
    outOfRange?: boolean | undefined;
  }>): void {
    units.forEach((entry, index) => {
      this.at(index).show(entry.snapshot, {
        threat: entry.threat, active: entry.active, role: entry.role, ready: entry.ready,
        outOfRange: entry.outOfRange,
      });
    });
    for (let index = units.length; index < this.#frames.length; index++) this.#frames[index]?.hide();
    this.root.hidden = units.length === 0;
  }
}
