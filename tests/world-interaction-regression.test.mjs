import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function sourceModule(path, replacements = []) {
  let source = await readFile(new URL(path, import.meta.url), "utf8");
  for (const [from, to] of replacements) source = source.replace(from, to);
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("right-click interacts with a game object without putting it in the unit target", async () => {
  const [controls, npc, world] = await Promise.all([
    read("src/browser/input/Controls.ts"),
    read("src/browser/ui/Npc.ts"),
    read("src/world/WorldClient.ts"),
  ]);

  assert.match(npc, /export function interactWithGuid\(guid:\s*bigint\)/,
    "the picked object must be interactable without first becoming world.targetGuid");
  assert.match(controls, /interactWithGuid\(guid\)/,
    "right-click must pass the picked game-object guid directly to interaction");
  assert.match(controls, /typeId\s*!==\s*5[\s\S]{0,180}?selectTarget\(guid\)/,
    "only unit-like picks may be installed as CMSG_SET_SELECTION targets");
  assert.match(world, /selectTarget\([\s\S]{0,500}?typeId\s*===\s*5[\s\S]{0,40}?return/,
    "WorldClient must enforce that a game object can never leak into unit selection through another caller");
});

test("mailboxes use the mail protocol while meeting stones keep the ordinary GO-use path", async () => {
  const [interaction, npc, protocol] = await Promise.all([
    read("src/browser/game/Interaction.ts"),
    read("src/browser/ui/Npc.ts"),
    read("src/world/GameObjectProtocol.ts"),
  ]);

  assert.match(interaction, /GO_TYPE_MAILBOX/);
  assert.match(interaction, /GO_TYPE_MAILBOX[\s\S]{0,120}?kind:\s*["']mail["']/,
    "mailbox cannot go through CMSG_GAMEOBJ_USE, which the server deliberately ignores for this type");
  assert.match(npc, /action\.kind\s*===\s*["']mail["'][\s\S]{0,100}?openMailbox\(guid\)/);
  assert.match(protocol, /GO_TYPE_MEETINGSTONE[\s\S]{0,400}?USABLE_TYPES[\s\S]{0,500}?GO_TYPE_MEETINGSTONE/,
    "meeting stones remain an explicit GameObject::Use type, not a blanket all-GO fallback");
});

test("guild-bank game objects use their dedicated activation opcode", async () => {
  const [interaction, npc, protocol] = await Promise.all([
    read("src/browser/game/Interaction.ts"),
    read("src/browser/ui/Npc.ts"),
    read("src/world/GameObjectProtocol.ts"),
  ]);

  assert.match(protocol, /GO_TYPE_GUILD_BANK\s*=\s*34/);
  assert.match(protocol, /interactiveGameObjectType[\s\S]{0,500}?GO_TYPE_GUILD_BANK/,
    "a guild-bank chest must participate in picking and hover admission");
  assert.match(interaction, /GO_TYPE_GUILD_BANK[\s\S]{0,200}?kind:\s*["']guild-bank["']/,
    "CMSG_GAMEOBJ_USE is not the activation protocol for a guild-bank chest");
  assert.match(npc, /action\.kind\s*===\s*["']guild-bank["'][\s\S]{0,120}?openGuildBank\(guid\)/);
});

test("right-click dispatches neutral service NPCs from server NPC flags", async () => {
  const npc = await read("src/browser/ui/Npc.ts");

  assert.match(npc, /npcFlags\s*&\s*NPC_FLAGS_VENDOR_MASK[^\n]*openVendor\(guid\)/,
    "a vendor-only neutral creature must open its inventory even when it has no gossip bit");
  assert.match(npc, /NPC_FLAG_TRAINER[\s\S]{0,900}?openTrainer\(guid\)/,
    "trainer flags must have a direct server-authoritative route");
  assert.match(npc, /NPC_FLAG_BANKER[\s\S]{0,900}?openBank\(guid\)/,
    "bankers must not depend on a separately authored gossip menu");
  assert.match(npc, /NPC_FLAG_MAILBOX[\s\S]{0,900}?openMailbox\(guid\)/,
    "mailbox creatures without gossip must use the mail protocol directly");
  assert.doesNotMatch(npc, /reactionTo\(|REACTION_(?:HOSTILE|NEUTRAL|FRIENDLY)/,
    "neutral faction reaction is not permission to suppress an NPC service");
});

test("a service-only stable master uses the existing visible stable interface", async () => {
  const [npc, enterWorld, windows] = await Promise.all([
    read("src/browser/ui/Npc.ts"),
    read("src/browser/app/EnterWorld.ts"),
    read("src/browser/ui/Windows.ts"),
  ]);

  assert.match(npc, /NPC_FLAG_STABLEMASTER[\s\S]{0,1200}?requestStable\(guid\)/,
    "a stable master without GOSSIP still needs to open the stable roster");
  assert.match(npc, /NPC_FLAG_PETITIONER[\s\S]{0,1200}?requestPetitionVendor\(guid\)/,
    "a petitioner without GOSSIP asks for its offer list like every other service NPC");
  const petition = await read("src/browser/ui/Petition.ts");
  assert.match(petition, /buyPetition\(vendorGuid, name, offer\.index\)/,
    "the petition route is not silent: the vendor offers render with a buy button each");
  assert.doesNotMatch(npc, /NPC_FLAG_GUILD_BANKER[\s\S]{0,1200}?openGuildBank\(guid\)/,
    "this core accepts CMSG_GUILD_BANKER_ACTIVATE only for GO type 34, never a creature guid");
  assert.match(windows, /export function showCharacterWindow\(tab:\s*CharacterTab\)/,
    "a server response needs an idempotent open operation, not a toggle that may close the pane");
  assert.match(enterWorld, /STABLE_CHANGED[\s\S]{0,350}?showCharacterWindow\(["']collections["']\)/,
    "the stable response must make the pet collection visible when the character window was closed");
});

test("flight, battlemaster and tabard service responses open visible native controls", async () => {
  const [npc, enterWorld, world, events] = await Promise.all([
    read("src/browser/ui/Npc.ts"),
    read("src/browser/app/EnterWorld.ts"),
    read("src/world/WorldClient.ts"),
    read("src/world/EventBus.ts"),
  ]);

  assert.match(npc, /reachableTaxiRoutes\(catalog,\s*menu\.currentNode,\s*menu\.knownNodes\)[\s\S]{0,1500}?takeTaxi\(menu\.guid,\s*route\.nodes\)/,
    "a taxi response needs visible named controls that submit the complete authored route");
  assert.match(enterWorld, /(?:events\.on|onWorldEvent)\(["']TAXI_MENU["'][\s\S]{0,120}?showTaxiMenu\(\)/,
    "the native HUD must consume the taxi response instead of only retaining it in WorldClient");
  assert.match(enterWorld, /(?:events\.on|onWorldEvent)\(["']TAXI_CHANGED["'][\s\S]{0,120}?showTaxiMenu\(\)/,
    "the flight window must stay until the server accepts or refuses the selected route");
  assert.match(world, /SMSG_NEW_TAXI_PATH[\s\S]{0,700}?CMSG_TAXIQUERYAVAILABLENODES/,
    "discovering a node must retry the omitted taxi map exactly once");

  assert.match(npc, /function drawBattlegroundList\([\s\S]{0,2400}?joinBattleground\(/,
    "a battlemaster response needs a native queue control");
  assert.match(npc, /export function showBattlegroundList\(\)[\s\S]{0,600}?drawBattlegroundList\(/,
    "the exported battlemaster response handler must render the native queue controls");
  assert.match(enterWorld, /(?:events\.on|onWorldEvent)\(["']BATTLEFIELD_LIST_CHANGED["'][\s\S]{0,160}?showBattlegroundList\(\)/,
    "the battlemaster packet must open its controls without optional FrameXML");
  assert.match(npc, /BattlegroundClient[^]*list\.fromWhere\s*!==\s*0/,
    "the native NPC window must use the shared metadata client and ignore queue-window lists");

  assert.match(events, /TABARD_VENDOR_CHANGED/);
  assert.match(world, /MSG_TABARDVENDOR_ACTIVATE[\s\S]{0,480}?TABARD_VENDOR_CHANGED/,
    "the tabard activation packet needs a dedicated UI edge rather than an unrelated guild repaint");
  assert.match(npc, /export function showTabardVendor\(\)[\s\S]{0,3200}?saveGuildEmblem\(/,
    "the tabard response needs visible, functional emblem controls");
  assert.match(enterWorld, /(?:events\.on|onWorldEvent)\(["']TABARD_VENDOR_CHANGED["'][\s\S]{0,160}?showTabardVendor\(\)/);
  assert.match(npc, /guild\.emblemStyle/,
    "the editor must start from the current emblem instead of destructive zeroes");
  assert.match(npc, /Textures\\\\GuildEmblems/,
    "the editor must preview the original layered GuildEmblems textures");
  assert.doesNotMatch(npc, /input\.max\s*=\s*["']255["']/,
    "raw 0..255 service fields can erase the current emblem and expose invalid catalog values");

  assert.match(npc, /NPC_FLAG_FLIGHTMASTER[\s\S]{0,180}?showPendingNpcDialog\(/,
    "service-only NPCs should acknowledge the click while their server response is in flight");
});

test("an eligible game object exposes its server name in a cursor-following hover tooltip", async () => {
  const [controls, protocol, interaction] = await Promise.all([
    read("src/browser/input/Controls.ts"),
    read("src/world/GameObjectProtocol.ts"),
    read("src/browser/game/Interaction.ts"),
  ]);

  assert.match(protocol, /export function interactiveGameObjectType\(/,
    "hover admission must use a finite supported-type list rather than treating every collision GO as interactive");
  const liveProtocol = await sourceModule("../src/world/GameObjectProtocol.ts", [
    ['"../protocol/PacketReader.js"', JSON.stringify(new URL("../dist/code/protocol/PacketReader.js", import.meta.url).href)],
    ['"../protocol/PacketWriter.js"', JSON.stringify(new URL("../dist/code/protocol/PacketWriter.js", import.meta.url).href)],
  ]);
  for (const type of [liveProtocol.GO_TYPE_DOOR, liveProtocol.GO_TYPE_CHEST,
    liveProtocol.GO_TYPE_MAILBOX, liveProtocol.GO_TYPE_MEETINGSTONE]) {
    assert.equal(liveProtocol.interactiveGameObjectType(type), true);
  }
  for (const type of [5, liveProtocol.GO_TYPE_TRANSPORT, liveProtocol.GO_TYPE_AREADAMAGE]) {
    assert.equal(liveProtocol.interactiveGameObjectType(type), false,
      `unsupported technical game-object type ${type} must not get a hand or tooltip`);
  }
  assert.match(controls, /gameObjectTemplate\(entry,\s*object\.guid\)/,
    "hover asks the server-owned gameobject template for the actual localized name");
  assert.doesNotMatch(controls, /interactionDistance\(type\)/,
    "the original client names a selectable object at a distance, even when a click is out of range");
  assert.match(interaction, /distance > interactionDistance\(type\)\) return undefined/,
    "a distant click still must not dispatch a game-object action");
  assert.match(controls, /GAMEOBJECT_FLAGS[\s\S]{0,200}?GO_FLAG_NOT_SELECTABLE/,
    "server-authored non-selectable objects must remain scenery under the cursor");
  assert.match(controls, /waitForGameObjectTemplate\(entry,\s*object\.guid\)[\s\S]{0,800}?applyHoverCursor\(/,
    "a localized query answer must repaint a stationary hover without waiting for pointermove");
  assert.match(controls, /function scheduleHoverWorldRefresh\([\s\S]{0,500}?setTimeout[\s\S]{0,300}?applyHoverCursor\(/,
    "a stationary hover must refresh when world state changes");
  assert.match(controls, /export function clearHeldKeys\(\)[\s\S]{0,250}?clearHoverCursor\(\)/,
    "a world replacement must not leave the previous world's tooltip or inline cursor behind");
  assert.doesNotMatch(controls, /return\s+template\?\.name\s*\|\|\s*gameObjectLabel\(object\)/,
    "a debug gameobject-entry label must not masquerade as a localized server name");
  // 4.04: through the shared tooltip's cursor mode (ui/Tooltip.ts), not a div of its own.
  assert.match(controls, /showTooltipAtPoint\(OBJECT_TIP, worldObjectTooltip\.content, point\.clientX, point\.clientY\)/,
    "the resolved hover name is painted in a cursor-following tooltip");
  assert.match(controls, /clearWorldObjectTooltip\(\)/,
    "leaving an object or starting a camera drag must remove the hover tooltip");
});

test("the first GO click waits once for its template, then revalidates the live object", async () => {
  const [npc, world] = await Promise.all([
    read("src/browser/ui/Npc.ts"),
    read("src/world/WorldClient.ts"),
  ]);

  assert.match(world, /waitForGameObjectTemplate\(entry:\s*number,\s*guid:\s*bigint\)/,
    "a click must have a lifecycle-owned way to await the query it just started");
  assert.match(world, /#settleGameObjectTemplateWaiters\(entry,[^)]*template/,
    "SMSG_GAMEOBJECT_QUERY_RESPONSE must release every matching one-shot waiter");
  assert.match(world, /#cancelGameObjectTemplateWaiters\(guid\)/,
    "destroying a GO must retire its deferred intent");
  assert.match(world, /#settleAllGameObjectTemplateWaiters\(\)/,
    "closing or replacing a world must not retain deferred clicks");
  assert.match(world, /#cancelStaleGameObjectTemplateWaiters\(\)/,
    "UPDATE_OUT_OF_RANGE must retire a deferred click just like SMSG_DESTROY_OBJECT");
  assert.match(world, /state\.objects\.get\(guid\)\s*!==\s*waiter\.object/,
    "a guid reused for a fresh object generation must never inherit the old click");
  assert.match(npc, /pendingGameObjectInteractions/,
    "two impatient clicks before one query response still produce only one interaction");
  assert.match(npc, /waitForGameObjectTemplate\(entry,\s*guid\)/);
  assert.match(npc, /current\s*!==\s*intent\.object|currentEntry\s*!==\s*entry/,
    "the response is ignored if that guid has been destroyed or reused, even for the same entry");
  assert.match(npc, /gameObjectAction\(world,\s*current,/,
    "range, type, Point and flags are evaluated again after the template arrives");
  assert.doesNotMatch(npc, /onGameObjectsChanged\s*=/,
    "deferred interaction must not steal the renderer/UI's legacy single callback");
});

test("all WotLK vendor title flags route both right-click and the target button", async () => {
  const [protocol, npc, frames] = await Promise.all([
    read("src/world/NpcProtocol.ts"),
    read("src/browser/ui/Npc.ts"),
    read("src/browser/ui/Frames.ts"),
  ]);
  assert.match(protocol, /NPC_FLAGS_VENDOR_MASK\s*=\s*0x0*0[fF]80/,
    "generic, ammo, food, poison and reagent vendor flags occupy bits 0x80..0x800");
  assert.match(npc, /npcFlags\s*&\s*NPC_FLAGS_VENDOR_MASK/);
  assert.match(frames, /npcFlags\s*&\s*NPC_FLAGS_VENDOR_MASK/);
});

test("the target interact button is visible for every native neutral NPC service", async () => {
  const [protocol, frames] = await Promise.all([
    read("src/world/NpcProtocol.ts"),
    read("src/browser/ui/Frames.ts"),
  ]);
  assert.match(protocol, /NPC_FLAGS_INTERACTION_MASK[\s\S]{0,260}?NPC_FLAGS_VENDOR_MASK/);
  assert.match(frames, /npcFlags\s*&\s*NPC_FLAGS_INTERACTION_MASK/,
    "flight masters, auctioneers, battleground masters, stable masters and mail NPCs need the same visible interact affordance as gossip NPCs");
  assert.doesNotMatch(frames, /\(npcFlags\s*&\s*0x0*03\)\s*===\s*0/,
    "gossip and quest bits alone do not describe all NPCs the interact dispatcher supports");
});

test("the GO name tooltip stays a compact label under the native skin", async () => {
  const css = (await read("src/browser/style.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gs)]
    .filter(([, selector]) => selector.split(",").some((part) =>
      part.trim() === "body.native-wow-ui .ui-tooltip.world-object-tooltip"))
    .at(-1)?.[2] ?? "";
  assert.match(rule, /min-width:\s*0/);
  assert.match(rule, /width:\s*max-content/);
  assert.match(rule, /max-width:\s*min\([^;]*100vw/);
  assert.match(rule, /overflow:\s*visible/,
    "a one-line object name must not inherit the rich tooltip scrollbox");
  assert.match(rule, /white-space:\s*normal/);
});

test("technical game objects never enter the pick stack ahead of an interactive object", async () => {
  const scene = await read("src/browser/SimpleScene.ts");

  assert.match(scene, /interactiveGameObjectType/,
    "the scene must know which GO types have a client interaction path");
  assert.match(scene,
    /if\s*\(interactiveGameObjectType\(type\)\s*&&\s*\(flags\s*&\s*GO_FLAG_NOT_SELECTABLE\)\s*===\s*0\)[^{]*\{[\s\S]{0,240}?this\.#hits\.push/,
    "unsupported collision helpers must be rejected before they can hide a usable GO behind them in the hit stack");
});

test("NPC service replies belong to the current request and Escape retires the shared service", async () => {
  const [world, windows] = await Promise.all([
    read("src/world/WorldClient.ts"),
    read("src/browser/ui/Windows.ts"),
  ]);

  assert.match(world, /#pendingGossipGuid/);
  assert.match(world, /SMSG_GOSSIP_MESSAGE[\s\S]{0,260}?gossip\.guid\s*!==\s*this\.#pendingGossipGuid[\s\S]{0,120}?return\s+true/,
    "an old gossip response must not replace the newly requested NPC");
  assert.match(world, /#pendingVendorGuid/);
  assert.match(world, /SMSG_LIST_INVENTORY[\s\S]{0,260}?vendor\.guid\s*!==\s*this\.#pendingVendorGuid[\s\S]{0,120}?return\s+true/,
    "an old vendor inventory must not replace the newly requested vendor");
  assert.match(world, /#pendingTaxiActivationMenu/);
  assert.match(world, /SMSG_ACTIVATETAXIREPLY[\s\S]{0,320}?this\.taxiMenu\s*!==\s*menu[\s\S]{0,80}?return\s+true/,
    "a reply to a closed flight request must not close a later flight map");
  assert.match(world, /#pendingTabardSaveGuid/);
  assert.match(world, /MSG_SAVE_GUILD_EMBLEM[\s\S]{0,220}?this\.#pendingTabardSaveGuid\s*!==\s*this\.tabardVendorGuid[\s\S]{0,80}?return\s+true/,
    "an unsolicited or retired emblem result must not repaint another tabard editor");
  assert.match(windows, /export function closeGameWindows\(\)[\s\S]{0,180}?closeNpcServiceWindow\(\)/,
    "Escape must cancel the same shared NPC lifecycle as its close button");
  assert.match(world, /closeNpcServices\(\)[\s\S]{0,180}?this\.closeGossip\(\)[\s\S]{0,180}?this\.#pendingTrainerGuid\s*=\s*undefined/,
    "switching NPCs must retire both the current gossip page and an in-flight trainer response");
});

test("a selected gossip option may open any server-authored NPC service for that same GUID", async () => {
  const world = await read("src/world/WorldClient.ts");

  assert.match(world,
    /selectGossipOption\([\s\S]{0,420}?this\.#pendingGossipServiceGuid\s*=\s*gossip\.guid/,
    "gossip option icons are decorative; the selected NPC GUID must authorize the service packet that follows");
  for (const opcode of [
    "SMSG_QUESTGIVER_QUEST_LIST",
    "SMSG_LIST_INVENTORY",
    "SMSG_TRAINER_LIST",
    "SMSG_SHOWTAXINODES",
    "SMSG_BATTLEFIELD_LIST",
    "MSG_TABARDVENDOR_ACTIVATE",
    "MSG_AUCTION_HELLO",
    "SMSG_SHOW_BANK",
    "MSG_LIST_STABLED_PETS",
    "SMSG_SHOW_MAILBOX",
  ]) {
    assert.match(world, new RegExp(`${opcode}[\\s\\S]{0,650}?pendingGossipServiceGuid`),
      `${opcode} must accept the currently selected gossip NPC as well as a direct request`);
  }
  assert.match(world, /#consumeGossipService\([\s\S]{0,320}?this\.gossip\s*=\s*undefined[\s\S]{0,100}?this\.onGossipChanged\?\.\(\)/,
    "the replaced gossip page must close before the service window is painted");
  assert.match(world, /SMSG_NPC_TEXT_UPDATE[\s\S]{0,600}?this\.gossip\?\.textId\s*===\s*text\.id[\s\S]{0,80}?this\.onGossipChanged\?\.\(\)/,
    "late text from the replaced gossip page must not hide the shared service that followed it");
  assert.match(world, /SMSG_SHOW_MAILBOX[\s\S]{0,520}?CMSG_GET_MAIL_LIST[\s\S]{0,100}?buildGetMailList\(mailboxGuid\)/,
    "a mailbox opened by a gossip option must fetch its letters just like a directly clicked mailbox");
});

test("a character switch or exit retires the previous session's world subscriptions", async () => {
  const enterWorld = await read("src/browser/app/EnterWorld.ts");
  const login = await read("src/browser/app/Login.ts");
  // The realm connection outlives a character while every subscription below is per character:
  // a direct `world.events.on(` here would stack one more handler per switch and deliver every
  // packet to every past session's panels. All of them must flow through the session helpers,
  // which record the unsubscribe for the next entry or logout.
  assert.equal((enterWorld.match(/world\.events\.on\(/g) ?? []).length, 0,
    "enterWorld must subscribe through the session helper so re-entry retires the old session");
  assert.equal((enterWorld.match(/game\.store\?\.events\.on\(/g) ?? []).length, 0,
    "store bindings ride the same session for the same reason");
  assert.match(enterWorld, /const generation = entryLifecycle\.begin\(\);/,
    "the next entry must retire the previous session before subscribing its own");
  assert.match(enterWorld, /entryLifecycle\.track\(bus\.on\(name, listener\)\)/,
    "the session helpers must record their unsubscribes");
  assert.match(enterWorld, /export function retireEnterWorldSession\(\): void \{\s*entryLifecycle\.retire\(\);/);
  assert.match(login, /export function resetWorldUi\(\): void \{\s*retireEnterWorldSession\(\);\s*game\.store\?\.detach\(\);/,
    "logout must retire the old event bus before dropping the store");
});
