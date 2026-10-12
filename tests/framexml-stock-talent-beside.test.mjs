// 3.45: the talent-wipe question opens the stock PlayerTalentFrame, as Wow.exe's TalentFrame_LoadUI path
// does — the one kept beside an add-on's N (3.26) when an add-on owns N, else the published owner.

import assert from "node:assert/strict";
import test from "node:test";
import {
  openFrameXmlStockTalent, publishFrameXmlStockTalentBeside, publishFrameXmlTalent,
} from "../dist/code/browser/framexml/FrameXmlTalentController.js";

function owner(name, calls) {
  let open = false;
  return {
    isOpen: () => open,
    show: () => { open = true; calls.push(`${name}:show`); },
    hide: () => { open = false; calls.push(`${name}:hide`); },
  };
}

test("3.45 beside an add-on's N the stock talent frame opens, and the add-on's window stays shut", () => {
  const calls = [];
  const unpublish = publishFrameXmlTalent(owner("addon", calls));
  const unpublishBeside = publishFrameXmlStockTalentBeside(owner("stock", calls));
  try {
    openFrameXmlStockTalent();
    openFrameXmlStockTalent();
    assert.deepEqual(calls, ["stock:show"], "the stock frame once, never the add-on's");
  } finally {
    unpublishBeside();
    unpublish();
  }
});

test("3.45 without an add-on's N the published owner is the stock one and opens", () => {
  const calls = [];
  const unpublish = publishFrameXmlTalent(owner("stock", calls));
  try {
    openFrameXmlStockTalent();
    openFrameXmlStockTalent();
    assert.deepEqual(calls, ["stock:show"], "opened once, not toggled shut by the second ask");
  } finally {
    unpublish();
  }
});

test("3.45 the frame beside is withdrawn by its own cleanup only, and a failing one demotes nothing", () => {
  const calls = [];
  const first = owner("first", calls);
  const second = owner("second", calls);
  const unpublish = publishFrameXmlTalent(owner("addon", calls));
  const dropFirst = publishFrameXmlStockTalentBeside(first);
  const dropSecond = publishFrameXmlStockTalentBeside(second);
  dropFirst();
  openFrameXmlStockTalent();
  assert.deepEqual(calls, ["second:show"], "a stale cleanup does not withdraw the newer frame");
  dropSecond();
  const broken = { isOpen: () => false, show: () => { throw new Error("load failed"); }, hide: () => {} };
  const dropBroken = publishFrameXmlStockTalentBeside(broken);
  assert.doesNotThrow(() => openFrameXmlStockTalent());
  dropBroken();
  openFrameXmlStockTalent();
  assert.deepEqual(calls, ["second:show", "addon:show"], "with none beside, the published owner");
  unpublish();
});
