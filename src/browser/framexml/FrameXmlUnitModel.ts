/**
 * 6.18 / 3.21 (11.11): the PlayerModel widget showing a unit — the character window's model
 * (CharacterModelFrame, PaperDollFrame.xml:460), the pet window's (PetModelFrame,
 * PetPaperDollFrame.xml:208), the inspect window's (InspectModelFrame, Blizzard_InspectUI) and any
 * add-on's PlayerModel. The picture is drawn by the same stage as the dressing room
 * (FrameXmlDressUpStage.ts); the live host that freezes and resolves a unit is
 * FrameXmlUnitModelLive.ts.
 *
 * What Wow.exe does, read from its PlayerModel method table (0x00acf510: SetUnit 0x005978e0,
 * SetCreature 0x00597960, RefreshUnit 0x00597b00, SetRotation 0x00597a10) and CharacterModelBase:
 *
 * - `SetUnit(unit)` needs a string ("Usage: SetUnit(\"unit\")") and resolves the token to a GUID
 *   (0x0060c1c0). A token that names nobody changes nothing. Otherwise the GUID is kept (+0x368)
 *   and, only while the frame is shown (+0xe0), the unit's current model is duplicated into the
 *   frame (0x005977e0 → 0x005975e0, "Duplicated model: %s"): a copy taken now, not a live view —
 *   the stock windows call SetUnit/RefreshUnit again on UNIT_MODEL_CHANGED. A GUID whose unit is not
 *   in the object manager keeps whatever the frame showed.
 * - The copy plays animation 0 (Stand), any variation, looped (0x00832ab0 with −1, 0, −1).
 * - `RefreshUnit()` is the same copy from the kept GUID (0x00597b00). DressUpModel's `Dress()`
 *   (0x00597ed0) is the same function body, which is why the dressing room's «Сброс» re-reads the
 *   unit.
 * - Hiding drops the model (0x00597210: SetModel(0)); showing again duplicates the kept GUID's unit
 *   anew (0x00597870, the show override: +0xe0 is the shown flag 0x004918f0 sets). So a closed window
 *   holds nothing and an opened one shows the unit as it is at that moment.
 * - `SetCreature` forgets the GUID (0x00597960 zeroes +0x368).
 * - `SetRotation(r)` needs a number ("Usage: SetRotation(rotation (in radians))") and, when a model is
 *   there, turns it with a step (0x005970f0): a larger angle than the last one plays ShuffleRight (12),
 *   a smaller one ShuffleLeft (11), the same one Stand — each only if the model has that animation and
 *   is not already playing it — then marks this update as turned and sets a deadline 100 ms ahead. The
 *   frame's update (0x005971b0) puts Stand back once an update passes with no turn after the deadline.
 *   Holding a rotate button (Model_OnUpdate) therefore shuffles for as long as it is held.
 *
 * Not modelled: what the copy hangs in the hands. 0x005975e0 closes the fingers over an attached right
 * or left hand item (0x004e7700 plays HandsClosed on bones 8-12/13-17), and the stage has no attached
 * models (FrameXmlDressUpStage.ts), so weapons, shoulders and helmets are not drawn in the window.
 */
import type { GlueModelSource } from "../glue/GlueModelStage.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

/** AnimationData ids the PlayerModel plays (Wow.exe 0x005975e0, 0x005970f0). */
export const FRAMEXML_MODEL_ANIM_STAND = 0;
export const FRAMEXML_MODEL_ANIM_SHUFFLE_LEFT = 11;
export const FRAMEXML_MODEL_ANIM_SHUFFLE_RIGHT = 12;
/** Wow.exe 0x005970f0: the turn's deadline, `now + 100` on the client's millisecond clock. */
export const FRAMEXML_MODEL_TURN_HOLD_MS = 100;

/** What a PlayerModel reads from the world: a GUID's unit frozen now, and that copy's picture. */
export interface FrameXmlUnitModelHost<S> {
  /** The unit `UnitGUID` named, copied as it is now; undefined while it is not in view. */
  snapshot(guid: string): S | undefined;
  /** The stage source for a copy; undefined while its display or look is still being fetched. */
  source(snapshot: S): GlueModelSource | undefined;
}

interface UnitState<S> {
  /** `UnitGUID`'s text for the unit SetUnit named (Wow.exe +0x368). */
  readonly guid: string;
  /** The duplicated model's inputs; undefined while the frame is hidden or the unit was never seen. */
  snapshot: S | undefined;
}

/** The host half of every PlayerModel's SetUnit/RefreshUnit/SetCreature and its show/hide. */
export class FrameXmlUnitModels<S> {
  readonly #host: FrameXmlUnitModelHost<S>;
  readonly #states = new Map<FrameXmlFrame, UnitState<S>>();
  #revision = 0;

  constructor(host: FrameXmlUnitModelHost<S>) {
    this.#host = host;
  }

  /** Bumped whenever what a frame shows changes. */
  get revision(): number { return this.#revision; }

  frames(): IterableIterator<FrameXmlFrame> { return this.#states.keys(); }

  has(frame: FrameXmlFrame): boolean { return this.#states.has(frame); }

  /** The GUID a frame keeps, if it was given one. */
  guid(frame: FrameXmlFrame): string | undefined { return this.#states.get(frame)?.guid; }

  /** Whether the frame holds a copied model (what `SetRotation` checks before it steps). */
  shows(frame: FrameXmlFrame): boolean { return this.#states.get(frame)?.snapshot !== undefined; }

  /** `SetUnit` with the token already resolved: keep the GUID, copy the unit when shown. */
  setUnit(frame: FrameXmlFrame, guid: string, shown: boolean): void {
    // 0x005977e0 replaces the model only when the unit is found: until then the frame keeps
    // whatever it showed, the previous unit's copy included.
    const state: UnitState<S> = { guid, snapshot: this.#states.get(frame)?.snapshot };
    this.#states.set(frame, state);
    if (shown) this.#copy(state);
    this.#revision += 1;
  }

  /** `RefreshUnit`: the kept GUID's unit copied again, while shown. */
  refresh(frame: FrameXmlFrame, shown: boolean): void {
    const state = this.#states.get(frame);
    if (!state || !shown) return;
    this.#copy(state);
    this.#revision += 1;
  }

  /** The frame was shown (0x00597870): copy the kept GUID's unit as it is now. */
  shown(frame: FrameXmlFrame): void {
    const state = this.#states.get(frame);
    if (!state) return;
    this.#copy(state);
    this.#revision += 1;
  }

  /** The frame was hidden (0x00597210): the model is dropped, the GUID kept. */
  hidden(frame: FrameXmlFrame): void {
    const state = this.#states.get(frame);
    if (!state || state.snapshot === undefined) return;
    state.snapshot = undefined;
    this.#revision += 1;
  }

  /** SetCreature/SetModel/SetDisplayInfo/ClearModel: the frame no longer shows a unit. */
  clear(frame: FrameXmlFrame): void {
    if (this.#states.delete(frame)) this.#revision += 1;
  }

  /** What the frame draws now, or undefined while it shows nothing or its answers are in flight. */
  resolve(frame: FrameXmlFrame): GlueModelSource | undefined {
    const snapshot = this.#states.get(frame)?.snapshot;
    return snapshot === undefined ? undefined : this.#host.source(snapshot);
  }

  dispose(): void {
    this.#states.clear();
    this.#revision += 1;
  }

  #copy(state: UnitState<S>): void {
    const snapshot = this.#host.snapshot(state.guid);
    if (snapshot !== undefined) state.snapshot = snapshot;
  }
}

/** What the turn rule reads and writes on a model frame. */
export interface FrameXmlModelTurnHost {
  /** Whether the frame has a model loaded whose clips include `animation` (0x00825ee0). */
  hasAnimation(frame: FrameXmlFrame, animation: number): boolean;
  /** The animation the frame plays now. */
  playing(frame: FrameXmlFrame): number;
  play(frame: FrameXmlFrame, animation: number): void;
  /** The client's millisecond clock. */
  now(): number;
}

interface TurnState {
  /** The last `SetRotation` angle (Wow.exe +0x328), kept whether or not a model was there. */
  rotation: number | undefined;
  /** Set by a turn, cleared by the next update (+0x370). */
  turned: boolean;
  /** When Stand may come back (+0x374). */
  deadline: number;
}

/** PlayerModel:SetRotation's step and the update that ends it (Wow.exe 0x005970f0, 0x005971b0). */
export class FrameXmlModelTurns {
  readonly #host: FrameXmlModelTurnHost;
  readonly #states = new Map<FrameXmlFrame, TurnState>();

  constructor(host: FrameXmlModelTurnHost) {
    this.#host = host;
  }

  /**
   * `SetRotation(rotation)`; `loaded` says whether the frame holds a model now (+0x2a0). `current` is
   * the angle the widget already holds, for a frame whose earlier SetRotation (Model_OnLoad's 0.61)
   * ran before this rule was installed.
   */
  rotate(frame: FrameXmlFrame, rotation: number, loaded: boolean, current?: number): void {
    let state = this.#states.get(frame);
    if (!state) {
      state = { rotation: current, turned: false, deadline: 0 };
      this.#states.set(frame, state);
    }
    if (loaded) {
      const previous = state.rotation ?? 0;
      const step = rotation > previous ? FRAMEXML_MODEL_ANIM_SHUFFLE_RIGHT
        : rotation < previous ? FRAMEXML_MODEL_ANIM_SHUFFLE_LEFT : FRAMEXML_MODEL_ANIM_STAND;
      if (this.#host.hasAnimation(frame, step) && this.#host.playing(frame) !== step) this.#host.play(frame, step);
    }
    state.turned = true;
    state.rotation = rotation;
    state.deadline = this.#host.now() + FRAMEXML_MODEL_TURN_HOLD_MS;
  }

  /** One update of a shown frame: Stand again once a turn-free update is past the deadline. */
  update(frame: FrameXmlFrame): void {
    const state = this.#states.get(frame);
    if (!state) return;
    if (!state.turned && state.deadline < this.#host.now() && this.#host.playing(frame) !== FRAMEXML_MODEL_ANIM_STAND) {
      this.#host.play(frame, FRAMEXML_MODEL_ANIM_STAND);
      state.deadline = 0;
    }
    state.turned = false;
  }

  forget(frame: FrameXmlFrame): void { this.#states.delete(frame); }

  dispose(): void { this.#states.clear(); }
}

/** The hidden host names the Lua methods call; never read by stock. */
const BINDING = {
  setUnit: "__fxUnitModelSetUnit",
  refresh: "__fxUnitModelRefresh",
  clear: "__fxUnitModelClear",
  turn: "__fxUnitModelTurn",
} as const;

/**
 * The PlayerModel type's methods on its shared method table (found through any stock PlayerModel's
 * metatable), so CharacterModelFrame, PetModelFrame, PetStableModel and every add-on's PlayerModel
 * have them. The token goes through the VM's own `UnitGUID`, the same resolver every other unit API
 * answers with. DressUpModel and TabardModel have their own tables (FrameXmlDressUp.ts).
 */
const PLAYER_MODEL_METHODS = `
local model = rawget(_G, "CharacterModelFrame") or rawget(_G, "PetModelFrame")
if type(model) ~= "table" then return 0 end
local meta = getmetatable(model)
local methods = type(meta) == "table" and rawget(meta, "__index")
if type(methods) ~= "table" then return 0 end
local setUnit, refresh = rawget(_G, "${BINDING.setUnit}"), rawget(_G, "${BINDING.refresh}")
local clear, turn = rawget(_G, "${BINDING.clear}"), rawget(_G, "${BINDING.turn}")
if not (setUnit and refresh and clear and turn) then return 0 end
if not rawget(methods, "__webclientUnitModel") then
  rawset(methods, "__webclientUnitModel", true)
  methods.SetUnit = function(self, unit)
    if type(unit) ~= "string" and type(unit) ~= "number" then error("Usage: SetUnit(\\"unit\\")", 0) end
    local guid = UnitGUID(tostring(unit))
    if guid then setUnit(self, guid) end
  end
  methods.RefreshUnit = function(self) refresh(self) end
  local rotate = rawget(methods, "SetRotation")
  if type(rotate) == "function" then
    methods.SetRotation = function(self, rotation, ...)
      local value = tonumber(rotation)
      if value == nil then error("Usage: SetRotation(rotation (in radians))", 0) end
      turn(self, value)
      return rotate(self, rotation, ...)
    end
  end
  for _, name in ipairs({ "SetModel", "SetCreature", "SetDisplayInfo", "ClearModel" }) do
    local base = rawget(methods, name)
    if type(base) == "function" then
      methods[name] = function(self, ...) clear(self); return base(self, ...) end
    end
  end
end
return 1
`;

/** What `installFrameXmlUnitModels` needs of the bridge. */
export type FrameXmlUnitModelBoot = Pick<FrameXmlBoot, "vm"> & {
  readonly bridge: Pick<FrameXmlBoot["bridge"], "resolve" | "isVisible" | "HookScript" | "update">;
};

/**
 * Bind the PlayerModel methods to `units` and `turns`. `onChange` runs after every call that changes
 * a picture and when a model frame that shows a unit is shown (the stage wakes on it). False when no
 * stock PlayerModel is there to find the method table through.
 */
export function installFrameXmlUnitModels<S>(
  boot: FrameXmlUnitModelBoot,
  units: FrameXmlUnitModels<S>,
  turns: FrameXmlModelTurns,
  onChange: () => void,
): boolean {
  const { bridge } = boot;
  const frameArg = (value: unknown): FrameXmlFrame | undefined =>
    value && typeof value === "object" ? bridge.resolve(value as FrameXmlFrame) : undefined;
  const hooked = new WeakSet<FrameXmlFrame>();
  const watch = (frame: FrameXmlFrame): void => {
    if (hooked.has(frame)) return;
    hooked.add(frame);
    // Host hooks (FrameXmlHostHooks.ts): an add-on's SetScript on the frame keeps them, as the
    // client's own show/hide overrides are not scripts.
    bridge.HookScript(frame, "OnShow", (self) => { units.shown(self); onChange(); });
    bridge.HookScript(frame, "OnHide", (self) => { units.hidden(self); });
  };
  const isModel = (frame: FrameXmlFrame | undefined): frame is FrameXmlFrame => frame?.type === "PlayerModel";
  boot.vm.registerGlobal(BINDING.setUnit, (args) => {
    const frame = frameArg(args[0]);
    const guid = args[1];
    if (!isModel(frame) || typeof guid !== "string" || guid === "") return [];
    watch(frame);
    // SetUnit forgets a creature the frame was showing (0x005977e0 zeroes +0x378), so the id stage
    // (FrameXmlModelPreview.ts) lets go of it.
    bridge.update(frame, (m) => { m.model.file = ""; m.model.creatureEntry = undefined; m.model.displayId = undefined; });
    units.setUnit(frame, guid, bridge.isVisible(frame));
    onChange();
    return [];
  });
  boot.vm.registerGlobal(BINDING.refresh, (args) => {
    const frame = frameArg(args[0]);
    if (isModel(frame)) { units.refresh(frame, bridge.isVisible(frame)); onChange(); }
    return [];
  });
  boot.vm.registerGlobal(BINDING.clear, (args) => {
    const frame = frameArg(args[0]);
    if (isModel(frame)) { units.clear(frame); turns.forget(frame); onChange(); }
    return [];
  });
  boot.vm.registerGlobal(BINDING.turn, (args) => {
    const frame = frameArg(args[0]);
    const rotation = Number(args[1]);
    if (isModel(frame) && Number.isFinite(rotation)) {
      turns.rotate(frame, rotation, units.shows(frame) && bridge.isVisible(frame), frame.model.facing);
    }
    return [];
  });
  const installed = frameXmlSilentProbe(boot, "@webclient/player-model", PLAYER_MODEL_METHODS, 1);
  return Number(installed?.[0]) === 1;
}
