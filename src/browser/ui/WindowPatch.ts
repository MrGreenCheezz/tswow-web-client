/**
 * A patch file, switched on: widgets into slots, slots hidden, windows given a class.
 *
 * This is to `ParsedPatch` what `WindowRender.renderWindow` is to `ParsedWindow`, and it is a
 * separate file for the same reason `Slots.ts` is: everything here is bookkeeping over handles, so
 * the whole of it runs against the small fake document the window tests build.
 *
 * Three things are worth reading before changing it.
 *
 * **A patch's widget is drawn once per place, not once.** `quest-log/entry-actions` is declared per
 * quest card, so one `add` entry can be twenty subtrees, each with its own bindings and its own
 * `slot.questId`. {@link Slots.fillSlot} calls back with each place as it appears — including
 * places that appear long after the module loaded, which is every panel the player has not opened
 * yet.
 *
 * **The roots are known before a single copy exists.** `PatchRegistry.roots()` is read once per
 * change and decides what `WindowBindings` assembles each frame, and a root that arrived after the
 * union was taken would read blank until something else moved. So one copy of every `add` widget is
 * built into a detached node at apply time purely to collect its roots and then thrown away —
 * exactly what `WindowRender.buildRepeat` does with a `repeat`'s first row, and for the same
 * reason: the collector *is* the builder, and a second walk written beside it is the thing that
 * would fall behind a new widget field.
 *
 * **Switching off has to leave the interface as it was found.** Every edit hands back an
 * unsubscribe and {@link LivePatch.destroy} runs the lot in reverse: the widgets come off their
 * hosts, `hidden` goes back to the value it held before the first hide, and the class and the
 * `data-module` mark come off the window. М7's acceptance test serialises the target frame before
 * and after and compares the two strings.
 */

import { fillSlot, hideSlot, skinWindow, type SlotInstance } from "./Slots.js";
import type { Unsubscribe } from "../../world/EventBus.js";
import type { ExpressionScope } from "./WindowExpression.js";
import {
  renderSlotWidget, type LiveSlotWidget, type WindowRenderHost, type WindowUpdateStats,
} from "./WindowRender.js";
import type { RegisteredPatch } from "./WindowRegistry.js";
import type { ParsedPatch } from "./WindowSchema.js";

export interface LivePatch extends RegisteredPatch {
  readonly definition: ParsedPatch;
  /** How many copies of this patch's widgets are on the screen right now. */
  readonly filled: number;
  /** What the last binding pass over all of them cost, for the «Окна» pane. */
  readonly stats: WindowUpdateStats;
  /** How many times a widget of this patch asked for its actions to run, and how many ran. */
  readonly actionPresses: { asked: number; ran: number };
}

/**
 * Applies one parsed patch and hands back the handle that takes it away again.
 *
 * The caller registers the handle in a {@link PatchRegistry}, which is what puts it on the
 * once-a-frame binding pass; nothing here reaches a registry of its own.
 */
export function applyWindowPatch(patch: ParsedPatch, host: WindowRenderHost = {}): LivePatch {
  const owner = patch.module;
  const undo: Unsubscribe[] = [];
  const roots = new Set<string>();
  const stats: WindowUpdateStats = { evaluated: 0, changed: 0 };
  const presses = { asked: 0, ran: 0 };
  /** Every copy on the screen, keyed by the node the slot registry holds. */
  const drawn = new Map<HTMLElement, LiveSlotWidget>();
  /**
   * The last snapshot the patch was updated against.
   *
   * Kept because a copy built between two frames — the card of a quest just accepted — has to be
   * drawn against what the rest of the interface is showing rather than against nothing, exactly as
   * `LiveWindow.show` redraws a window the player has just opened.
   */
  let last: ExpressionScope = {};
  let destroyed = false;

  for (const add of patch.add) {
    // The probe. Built with the bare helpers and no `textureUrl`, so it fetches no picture: a path
    // that would be a request in a real host is an empty source here, and the widget is discarded
    // the moment its roots have been read off it.
    const probe = renderSlotWidget(add.widget, {
      module: owner, patch: patch.id, slot: { name: add.slot, params: {} },
    }, { ...(host.helpers ? { helpers: host.helpers } : {}) });
    for (const root of probe.roots) roots.add(root);
    probe.destroy();

    undo.push(fillSlot(add.slot, {
      build: (instance: SlotInstance): HTMLElement | undefined => {
        if (destroyed) return undefined;
        const live = renderSlotWidget(add.widget, {
          module: owner, patch: patch.id, slot: { name: instance.name, params: instance.params }, presses,
        }, host);
        live.update(last);
        drawn.set(live.element, live);
        return live.element;
      },
      drop: (node: HTMLElement): void => {
        drawn.get(node)?.destroy();
        drawn.delete(node);
      },
    }, owner));
  }

  for (const name of patch.hide) undo.push(hideSlot(name, owner));
  for (const [id, className] of Object.entries(patch.classes)) undo.push(skinWindow(id, className, owner));

  return {
    id: patch.id,
    module: patch.module,
    target: patch.target,
    definition: patch,
    roots,
    stats,
    actionPresses: presses,
    get filled(): number {
      return drawn.size;
    },
    update(snapshot: ExpressionScope): void {
      if (destroyed) return;
      last = snapshot;
      stats.evaluated = 0;
      stats.changed = 0;
      for (const live of drawn.values()) {
        live.update(snapshot);
        stats.evaluated += live.stats.evaluated;
        stats.changed += live.stats.changed;
      }
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      // Backwards, so a class that went on last comes off first and the window's `data-module` is
      // rewritten in the order it was written.
      for (const off of [...undo].reverse()) off();
      undo.length = 0;
      // Empty by now — dropping a fill calls `drop` for every copy it made, and `drop` destroys
      // it — but a copy whose slot was cleared while the fill was already gone would have no other
      // way out, and a subtree left on the frame pass is a subtree drawn for ever.
      for (const live of drawn.values()) live.destroy();
      drawn.clear();
    },
  };
}
