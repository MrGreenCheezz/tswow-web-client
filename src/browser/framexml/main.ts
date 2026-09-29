import "../glue/glue.css";
import { gatewayOrigin as defaultGatewayOrigin, clientLocale } from "../Environment.js";
import { createHttpFileProvider } from "../glue/GlueLoader.js";
import { GLUE_LOGICAL_HEIGHT, glueViewportMetrics } from "../glue/GlueRuntime.js";
import { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { FrameXmlFontLoader } from "../ui/framexml_compat/FrameXmlFonts.js";
import { FrameXmlTextureCache } from "../ui/framexml_compat/FrameXmlTextures.js";
import { frontDoorGatewayOrigin } from "../glue/FrontDoor.js";
import { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } from "./FrameXmlBoot.js";
import { FRAMEXML_VERTICAL_TOC } from "./FrameXmlCorpus.js";
import { CannedWorldSeam } from "./CannedWorldSeam.js";
import { formatFrameXmlInventory } from "./FrameXmlInventory.js";
import { installFrameXmlGameMenuButtons } from "./FrameXmlGameMenuOwner.js";
import { FRAMEXML_CANNED_LFD_PLAYER_GUID } from "./FrameXmlLfdCanned.js";
import { installFrameXmlLfdToggle } from "./FrameXmlLfdOwner.js";
import { createFrameXmlFriendsOwner, installFrameXmlFriendsRoutes } from "./FrameXmlFriendsOwner.js";
import { installFrameXmlLootAdapters } from "./FrameXmlLootOwner.js";
import { installFrameXmlPopupsAdapters } from "./FrameXmlPopupsOwner.js";
import { FRAMEXML_CANNED_POPUP_SCENES } from "./FrameXmlPopupsCanned.js";
import { frameXmlCannedTradeItem } from "./FrameXmlTradeCanned.js";
import { createLazyFrameXmlTradeSkillOwner } from "./FrameXmlTradeSkillOwner.js";
import { FRAMEXML_CANNED_BLACKSMITHING, FRAMEXML_CANNED_ENCHANTING } from "./FrameXmlTradeSkillCanned.js";
import { TRADE_STATUS_TRADE_ACCEPT } from "../../world/TradeProtocol.js";
import { createFrameXmlNpcWindows } from "./FrameXmlGossipNpcWindows.js";
import { FRAMEXML_CANNED_ARENA_LIST, FRAMEXML_CANNED_GUILD_LIST } from "./FrameXmlPetitionCanned.js";
import { createLazyFrameXmlAuctionOwner } from "./FrameXmlAuctionOwner.js";
import { createLazyFrameXmlSocketOwner } from "./FrameXmlSocketOwner.js";
import { createLazyFrameXmlInspectOwner } from "./FrameXmlInspectOwner.js";
import { routeFrameXmlInspectUnit } from "./FrameXmlInspectMount.js";
import { CANNED_INSPECT_TARGET } from "./FrameXmlInspectCanned.js";
import { createLazyFrameXmlBarberOwner } from "./FrameXmlBarberOwner.js";
import { createLazyFrameXmlAchievementOwner, installFrameXmlAchievementHostGlobals } from "./FrameXmlAchievementOwner.js";
import { createLazyFrameXmlGuildBankOwner } from "./FrameXmlGuildBankOwner.js";
import { mountFrameXmlMacroBindingWindows } from "./FrameXmlMacroBindingMount.js";
import { openFrameXmlMacro } from "./FrameXmlMacroController.js";
import { openFrameXmlKeyBindings } from "./FrameXmlBindingController.js";
import { installFrameXmlCalendarRoutes, mountFrameXmlCalendar } from "./FrameXmlCalendarOwner.js";
import { openFrameXmlCalendar, toggleFrameXmlCalendar } from "./FrameXmlCalendarController.js";
import { isolateFrameXmlPreviewBindings } from "./FrameXmlBinding.js";
import { frameXmlOptionsPreview, openFrameXmlOptionsPreview } from "./FrameXmlOptionsPreview.js";
import { mountFrameXmlRaidGrid } from "./FrameXmlRaidLod.js";
import { frameXmlCannedRaid } from "./FrameXmlRaidLodCanned.js";

/**
 * `framexml.html` — the dev entry for the in-world interface.
 *
 * A fourth page beside `glue.html`, and deliberately *only* a dev entry: nothing in the client
 * imports it, nothing links to it, and it does not touch the game app. F1's deliverable was the
 * inventory it prints; Wave 13's bounded vertical is the thing underneath it — a measured
 * PlayerFrame, cast bar and MainMenuBar/MultiBar set with a real player seam, plus the twelve
 * action buttons, counts and cooldown sweeps from a canned world.
 *
 * It reuses the glue stage verbatim — the same `#glue-host`/`#glue-stage` box, the same stylesheet,
 * the same 768-unit coordinate system — because that system is a measurement about this client
 * (`GlueRuntime.ts`), not a property of the glue screens, and UIParent is anchored the same way.
 *
 * Query parameters:
 *   `?toc=vertical`       load the bounded vertical — 41 files, 1,272 KiB, 890 widgets, 26 Lua chunks
 *   `?seam=none`          F2's neutral world instead of the canned one
 *   `?file=UIParent.lua`  load one file (and what it includes) instead of the whole TOC
 *   `?gateway=…`          the gateway, in any of the spellings `FrontDoor.ts` accepts
 *   `?render=0`           skip the DOM mount; measure only
 *   `?textures=0`         do not fetch the pictures (see below)
 *   `?exercise=0`         stop after the TOC walk, without session events
 *   `?trainer=1`          open the real load-on-demand Blizzard_TrainerUI against the canned seam
 *   `?merchant=1`         open the stock MerchantFrame against the canned vendor
 *   `?gamemenu=1`         open the stock GameMenuFrame with the WebClient adapters and extras
 *   `?lfd=1`              open the stock LFDParentFrame on the canned catalog's specific list;
 *                         `?lfd=queued` also queues (minimap eye + LFDSearchStatus), `?lfd=proposal`
 *                         raises the ready popup, `?lfd=rolecheck` the role-check popup
 *   `?friends=1`          the stock FriendsFrame on the canned friends list; `?friends=ignore|who|guild|
 *                         channel|raid` another tab (`who` answers the canned /who), and
 *                         `?friends=detail|info|log|control|raidinfo` a guild or raid popup
 *   `?loot=1`             the stock LootFrame on the canned level-60 corpse (money, a stack, a
 *                         locked roll slot, three pages); `?loot=roll` two GroupLootFrames instead,
 *                         `?loot=all` both, `?loot=bind` the corpse plus the LOOT_BIND popup of its
 *                         bind-on-pickup item, `?loot=master` the master looter's candidate list
 *   `?popup=party,summon` the stock confirmations over the canned world, one scene per name
 *                         (FRAMEXML_CANNED_POPUP_SCENES: party, duel, outofbounds, death, corpse,
 *                         resurrect, sickness, summon, guild, arena, trade, camp, quit, readycheck,
 *                         xploss)
 *   `?mail=1`             the stock MailFrame on the canned mailbox's four letters; `?mail=open` also
 *                         opens the first letter, `?mail=invoice` the auction win, `?mail=send` the
 *                         send tab with a potion stack attached
 *   `?trade=1`            the stock TradeFrame with the canned partner's offer and one own item;
 *                         `?trade=accept` also shows the partner's accept highlight
 *   `?tradeskill=1`       the load-on-demand TradeSkillFrame on the canned Blacksmithing, through the
 *                         world mount's lazy owner; `?tradeskill=makeable` ticks «Есть материалы»,
 *                         `enchanting` opens the canned Enchanting, `target` also presses «Зачаровать»
 *   `?npc=gossip`         the NPC windows, gated and published as the world mount does: `gossip` the
 *                         canned innkeeper's GossipFrame, `confirm` its paid row's GOSSIP_CONFIRM,
 *                         `bank` the stock BankFrame, `taxi` TaxiFrame at Stormwind with a route
 *                         hovered, `itemtext` a two-page book, `plaque` a stone plaque, `tabard` the
 *                         guild master's TabardFrame, `guildregistrar`/`arenaregistrar` the charter
 *                         vendors, `banner` PVPBannerFrame for a carried 2v2 charter, `petition` a charter,
 *                         `stable` the stable master's PetStableFrame (`stablebuy` also its purchase dialog)
 *   `?auction=1`          the stock AuctionFrame, Blizzard_AuctionUI loaded on demand by the world mount's
 *                         lazy owner, over the canned house after a search; `?auction=bids` the Bids tab,
 *                         `auctions` the Auctions tab, `sell` a linen stack in the sell slot, `multisell`
 *                         a three-stack post held at 1/3 on AuctionProgressFrame
 *   `?socket=1`           the stock ItemSocketingFrame (Blizzard_ItemSocketingUI on demand, the world mount's
 *                         lazy owner) on the canned helm; `?socket=staged` a ruby staged in the red socket
 *   `?inspect=1`          the stock InspectFrame (Blizzard_InspectUI on demand) on the canned friendly mage,
 *                         answered; `?inspect=talents` the talent tab, `?inspect=pvp` the PvP tab
 *   `?barber=1`           the stock BarberShopFrame (Blizzard_BarbershopUI on demand) on the canned tauren
 *                         chair; `?barber=changed` a new horn style and facial hair, priced
 *   `?achievement=1`      the stock AchievementFrame (Blizzard_AchievementUI and AlertFrames.xml on demand,
 *                         the world mount's lazy owner) on the canned achievements' summary; `general`
 *                         General with a progress-bar row selected, `explore` Elwynn Forest's areas, `stats`
 *                         the Deaths statistics, `compare` party1's comparison, `track` a quest count in the
 *                         WatchFrame, `toast` the earned-achievement alert alone
 *   `?macros=1`           the stock MacroFrame, Blizzard_MacroUI loaded on demand by the world mount's
 *                         owner, over the canned macros; `?macros=character` the character tab,
 *                         `?macros=new` the icon popup of a new macro
 *   `?keybindings=1`      the stock KeyBindingFrame (Blizzard_BindingUI on demand) over this client's
 *                         key table; `?keybindings=capture` with MOVEFORWARD's first key selected
 *   `?calendar=1`         the stock CalendarFrame (Blizzard_Calendar on demand) opened by the clock's
 *                         GameTimeFrame, over the canned month; `?calendar=event` the pending raid
 *                         invitation, `create` a new event on the day after tomorrow, `holiday` the
 *                         Children's Week around today, `menu` an event's context menu
 *   `?guildbank=1`        the stock GuildBankFrame, Blizzard_GuildBankUI loaded on demand by the world
 *                         mount's lazy owner, over the canned guild's vault; `?guildbank=log` the item
 *                         log, `moneylog` the money log, `info` the tab text, `buy` the next tab's price,
 *                         `popup` the tab icon picker, `held` a stack on the cursor (its slot locked)
 *   `?raidgrid=1`         the canned ten-player raid, and the Raid tab's group grid (Blizzard_RaidUI) loaded
 *                         on demand by the world mount's lazy owner; with `?friends=raid` the tab shows it
 *   `?options=video`      the stock options chain, loaded late by the world mount's lazy owner over a
 *                         page-local settings model: `video`, `audio`, `interface` or `webclient` (the
 *                         «WebClient» category); `:<panel frame name>` selects a panel, e.g.
 *                         `?options=interface:InterfaceOptionsActionBarsPanel`
 *
 * **Pictures follow the TOC.** Pictures are on by default for the bounded vertical and off for the
 * whole corpus, whose unbounded texture load previously saturated the page; `?textures=` overrides
 * either way. The renderer batches screen/tick mutations (10–12→1 on a screen switch, 3–4→1 on a
 * steady tick) and skips hidden subtrees, so the measured `applyFrame` count is 3,298→42 (login),
 * 3,298→41 (charselect) and 3,298→256 (charcreate), with fake-corpus wall time ~13–37 ms→~7–17 ms.
 */

const host = document.getElementById("glue-host");
const stage = document.getElementById("glue-stage");
const report = document.getElementById("framexml-report");

function say(text: string): void {
  if (report) report.textContent = text;
}

function flag(parameters: URLSearchParams, name: string, fallback: boolean): boolean {
  const value = parameters.get(name);
  if (value === null) return fallback;
  return !/^(?:0|false|no|off)$/i.test(value.trim());
}

async function main(): Promise<void> {
  if (!host || !stage) return;
  const parameters = new URL(window.location.href).searchParams;
  const origin = frontDoorGatewayOrigin(window.location.search) ?? defaultGatewayOrigin(window.location);
  const vertical = (parameters.get("toc") ?? "").trim().toLowerCase() === "vertical";
  const wantSeam = (parameters.get("seam") ?? "canned").trim().toLowerCase() !== "none";
  const trainerRequested = flag(parameters, "trainer", false);
  const merchantRequested = flag(parameters, "merchant", false);
  const gameMenuRequested = flag(parameters, "gamemenu", false);
  const lfdMode = (parameters.get("lfd") ?? "").trim().toLowerCase();
  const lfdRequested = lfdMode !== "" && !/^(?:0|false|no|off)$/.test(lfdMode);
  const friendsMode = (parameters.get("friends") ?? "").trim().toLowerCase();
  const friendsRequested = friendsMode !== "" && !/^(?:0|false|no|off)$/.test(friendsMode);
  const lootMode = (parameters.get("loot") ?? "").trim().toLowerCase();
  const lootRequested = lootMode !== "" && !/^(?:0|false|no|off)$/.test(lootMode);
  const popupScenes = (parameters.get("popup") ?? "").split(",").map((scene) => scene.trim().toLowerCase())
    .filter((scene) => scene in FRAMEXML_CANNED_POPUP_SCENES);
  const mailMode = (parameters.get("mail") ?? "").trim().toLowerCase();
  const mailRequested = mailMode !== "" && !/^(?:0|false|no|off)$/.test(mailMode);
  const tradeMode = (parameters.get("trade") ?? "").trim().toLowerCase();
  const tradeRequested = tradeMode !== "" && !/^(?:0|false|no|off)$/.test(tradeMode);

  // The stage is laid out in UI units and scaled uniformly, exactly as `Bootstrap.ts` does it.
  const fit = (): void => {
    const metrics = glueViewportMetrics(
      host.clientWidth || window.innerWidth,
      host.clientHeight || window.innerHeight,
    );
    stage.style.width = `${metrics.virtualWidth}px`;
    stage.style.height = `${GLUE_LOGICAL_HEIGHT}px`;
    stage.style.transform = `scale(${metrics.scale})`;
    stage.style.transformOrigin = "top left";
  };
  fit();
  window.addEventListener("resize", fit);

  // Before the canned seam's binding model reads the table: a key bound here stays in this page.
  isolateFrameXmlPreviewBindings();
  // `?options=` puts a page-local settings model behind the canned world's CVars (FrameXmlOptionsPreview.ts).
  const optionsPreview = frameXmlOptionsPreview(parameters);
  const seam = wantSeam ? optionsPreview?.seam() ?? new CannedWorldSeam() : undefined;
  const boot = new FrameXmlBoot({
    provider: createHttpFileProvider({ gatewayOrigin: origin }),
    locale: clientLocale(),
    only: parameters.get("file"),
    exercise: flag(parameters, "exercise", true),
    ...(vertical ? { subset: FRAMEXML_VERTICAL_TOC } : {}),
    ...(vertical ? { exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS } : {}),
    ...(seam ? { seam } : {}),
    screen: () => ({
      width: Math.round(glueViewportMetrics(
        host.clientWidth || window.innerWidth,
        host.clientHeight || window.innerHeight,
      ).virtualWidth),
      height: GLUE_LOGICAL_HEIGHT,
    }),
    lua: {
      // Not console-only: the browser run has to be comparable with the node one, and the node one
      // reads this list rather than scraping a console.
      onError: (message) => console.error("[framexml lua]", message),
      onPrint: (message) => console.info("[framexml print]", message),
    },
  });

  say("Чтение корпуса...");
  const inventory = await boot.load();
  // The world mount installs these after load too; the preview logs what the native owner would do.
  if (gameMenuRequested) {
    installFrameXmlGameMenuButtons(boot, {
      video: () => console.info("[framexml gamemenu] video"),
      sound: () => console.info("[framexml gamemenu] sound"),
      interface: () => console.info("[framexml gamemenu] interface"),
      keybindings: () => console.info("[framexml gamemenu] keybindings"),
      macros: () => console.info("[framexml gamemenu] macros"),
      diagnostics: () => console.info("[framexml gamemenu] diagnostics"),
      resetLayout: () => console.info("[framexml gamemenu] resetLayout"),
      toggle: () => console.info("[framexml gamemenu] toggle"),
    });
  }
  if (lfdRequested) {
    installFrameXmlLfdToggle(boot, () => console.info("[framexml lfd] toggle"));
  }
  if (friendsRequested) {
    installFrameXmlFriendsRoutes(boot, {
      toggle: (tab) => console.info("[framexml friends] toggle", tab),
      open: (tab) => console.info("[framexml friends] open", tab),
    });
  }
  if (popupScenes.length > 0) installFrameXmlPopupsAdapters(boot);
  if (lootRequested) installFrameXmlLootAdapters(boot);
  say(formatFrameXmlInventory(inventory, 30));
  console.info(formatFrameXmlInventory(inventory, 40));

  let renderer: FrameXmlDomRenderer | undefined;
  if (flag(parameters, "render", true)) {
    const clientFileUrl = (path: string): string => {
      const url = new URL("/client/file", origin);
      url.searchParams.set("path", path.replaceAll("/", "\\"));
      return url.href;
    };
    const textureUrl = (path: string): string => {
      const url = new URL("/texture", origin);
      url.searchParams.set("path", path.replaceAll("/", "\\"));
      return url.href;
    };
    const textures = flag(parameters, "textures", vertical)
      ? new FrameXmlTextureCache({
        resolve: textureUrl,
        // Drawn on the frames holding the picture, as the world mount does (`pictureArrived`).
        onChange: (path, kind) => { if (renderer) renderer.pictureArrived(path, kind); else boot.bridge.touch(); },
      })
      : undefined;
    const fonts = new FrameXmlFontLoader({ resolve: clientFileUrl });
    renderer = new FrameXmlDomRenderer(stage, {
      bridge: boot.bridge,
      ...(textures ? { textures, textureResolver: textureUrl } : {}),
      fontResolver: clientFileUrl,
      // The renderer's sweep and the corpus' `GetTime()` have to be the same clock, or a cooldown
      // that started «now» would be drawn as finished.
      clock: boot.pump.now,
      // The in-world root, as `UIParent.xml` declares it; a frame Lua created with no parent
      // belongs inside it, the same way `GlueParent` works on the glue page.
      createdRootParent: "UIParent",
      fontLoader: (file, family) => {
        void fonts.load(file, family).then(() => { if (renderer) renderer.fontArrived(); else boot.bridge.touch(); });
      },
    });
    renderer.registerFonts(boot.bridge.fontStyles);
    renderer.mount(boot.roots);
  }

  if (merchantRequested) {
    if (!seam || !renderer || !boot.bridge.getFrame("MerchantFrame")) {
      throw new Error("MerchantFrame preview requires the vertical corpus, renderer and canned seam");
    }
    seam.openMerchant();
    renderer.sync();
    if (!boot.bridge.isVisible(boot.bridge.getFrame("MerchantFrame")!)) {
      throw new Error("MerchantFrame preview did not open");
    }
  }

  if (gameMenuRequested) {
    if (!renderer || !boot.bridge.getFrame("GameMenuFrame")) {
      throw new Error("GameMenuFrame preview requires the vertical corpus and renderer");
    }
    boot.vm.executeReported("ShowUIPanel(GameMenuFrame)", "@framexml-preview/gamemenu");
    renderer.sync();
    if (!boot.bridge.isVisible(boot.bridge.getFrame("GameMenuFrame")!)) throw new Error("GameMenuFrame preview did not open");
  }

  if (lfdRequested) {
    const parent = boot.bridge.getFrame("LFDParentFrame");
    if (!seam || !renderer || !parent) throw new Error("LFDParentFrame preview requires the vertical corpus, renderer and canned seam");
    // The published route: stock popups own the prompts, as they do in the world once gated.
    seam.lfd.popupsOwned = true;
    const world = seam.lfdWorld;
    boot.vm.executeReported(`ShowUIPanel(LFDParentFrame) LFDQueueFrame_SetType("specific")`, "@framexml-preview/lfd");
    if (lfdMode === "queued") world.queue([258 | (6 << 24)], 95);
    if (lfdMode === "proposal") world.propose(40 | (1 << 24));
    if (lfdMode === "rolecheck") world.startRoleCheck(FRAMEXML_CANNED_LFD_PLAYER_GUID, [40 | (1 << 24)]);
    renderer.sync();
    if (!boot.bridge.isVisible(parent)) throw new Error("LFDParentFrame preview did not open");
  }

  // The QZ lane's preview: the canned ten-player raid, and the world mount's own lazy Blizzard_RaidUI
  // owner, which loads at once because the player is already in a raid (RaidFrame's PLAYER_LOGIN rule).
  const raidGridMode = (parameters.get("raidgrid") ?? "").trim().toLowerCase();
  if (raidGridMode !== "" && !/^(?:0|false|no|off)$/.test(raidGridMode) && seam && renderer) {
    frameXmlCannedRaid(seam.socialWorld);
    const mounted = mountFrameXmlRaidGrid(seam, boot, renderer);
    await mounted?.owner.settled();
    stage.dataset.raidGridPreview = mounted?.owner.state ?? "absent";
  }

  if (friendsRequested) {
    const frame = boot.bridge.getFrame("FriendsFrame");
    if (!seam || !renderer || !frame) throw new Error("FriendsFrame preview requires the vertical corpus, renderer and canned seam");
    // The published route: `/who` answers reach the stock tab, as they do in the world once gated.
    seam.friends.owned = true;
    const owner = createFrameXmlFriendsOwner(boot, frame);
    const guildPopup = ["detail", "info", "log", "control"].includes(friendsMode);
    const tab = guildPopup ? "guild" : friendsMode === "raidinfo" ? "raid"
      : (["ignore", "who", "guild", "channel", "raid"] as const).find((name) => name === friendsMode) ?? "friends";
    owner.show(tab);
    // The canned server answers ShowFriends/GuildRoster a microtask later; the popups need its roster.
    await Promise.resolve();
    seam.friends.tick();
    if (tab === "who") seam.socialWorld.answerWho();
    const popup: Readonly<Record<string, string>> = {
      detail: `GuildFrameButton4:Click("LeftButton")`,
      info: "ToggleGuildInfoFrame()",
      log: "ToggleGuildEventLog() GuildEventLog_Update()",
      control: `GuildFrameControlButton:Click("LeftButton")`,
      raidinfo: `RaidFrameRaidInfoButton:Click("LeftButton")`,
    };
    const script = popup[friendsMode];
    if (script) boot.vm.executeReported(script, "@framexml-preview/friends");
    renderer.sync();
    if (!boot.bridge.isVisible(frame)) throw new Error("FriendsFrame preview did not open");
  }

  if (popupScenes.length > 0) {
    if (!seam || !renderer) throw new Error("the popup preview requires the vertical corpus, renderer and canned seam");
    // The published route: the stock dialogs own the confirmations, as they do once gated.
    seam.popups.popupsOwned = true;
    for (const scene of popupScenes) FRAMEXML_CANNED_POPUP_SCENES[scene]?.(seam.popupsWorld);
    seam.popups.tick();
    renderer.sync();
  }

  if (lootRequested) {
    if (!seam || !renderer || !boot.bridge.getFrame("LootFrame")) {
      throw new Error("the loot preview requires the vertical corpus, renderer and canned seam");
    }
    // The published route (FrameXmlLootOwner.publishFrameXmlLootMount without the native repaint).
    seam.loot.useGlobalStrings((name) => boot.vm.globalString(name));
    seam.loot.owned = true;
    const world = seam.lootWorld;
    if (lootMode !== "roll") world.openCorpse({ master: lootMode === "master" });
    if (lootMode === "roll" || lootMode === "all") world.startRolls();
    seam.loot.tick();
    // Slot 6 is the bind-on-pickup helm; slot 5 (page 2, button 2) a master looter's shard.
    if (lootMode === "bind") boot.vm.executeReported("LootSlot(6)", "@framexml-preview/loot");
    if (lootMode === "master") {
      boot.vm.executeReported(`LootFrame_PageDown() LootButton_OnClick(LootButton2, "LeftButton")`, "@framexml-preview/loot");
    }
    seam.loot.tick();
    renderer.sync();
  }

  if (mailRequested || tradeRequested) {
    if (!seam || !renderer || !boot.bridge.getFrame("MailFrame") || !boot.bridge.getFrame("TradeFrame")) {
      throw new Error("the mail/trade preview requires the vertical corpus, renderer and canned seam");
    }
    // The world mount's bag gate points a missing InterfaceOptionsFrame at a hidden stand-in, because
    // OpenBackpack's IsOptionFrameOpen() reads it unconditionally (MAIL_SHOW opens the backpack).
    boot.vm.executeReported(`if not InterfaceOptionsFrame then InterfaceOptionsFrame = CreateFrame("Frame") InterfaceOptionsFrame:Hide() end`,
      "@framexml-preview/mail");
  }
  if (mailRequested && seam && renderer) {
    // The published route: the model owns the mailbox as it does once the world mount has gated it.
    seam.mail.owned = true;
    seam.mailWorld.open();
    if (mailMode === "open") boot.vm.executeReported("MailItem1Button:Click()", "@framexml-preview/mail");
    if (mailMode === "invoice") boot.vm.executeReported("MailItem2Button:Click()", "@framexml-preview/mail");
    if (mailMode === "send") {
      boot.vm.executeReported("MailFrameTab_OnClick(nil, 2)", "@framexml-preview/mail");
      seam.mailWorld.cursor = { guid: 0x4000_0001n, bag: 255, slot: 23 };
      boot.vm.executeReported(`SendMailAttachment1:Click() SendMailNameEditBox:SetText("Алистра")
        SendMailBodyEditBox:SetText("Зелья к четвергу.") SendMailFrame_CanSend()`, "@framexml-preview/mail");
    }
    renderer.sync();
  }
  if (tradeRequested && seam && renderer) {
    seam.trade.owned = true;
    const world = seam.tradeWorld;
    world.open();
    world.partnerOffers(12_345, [frameXmlCannedTradeItem(0, 2589, 20), frameXmlCannedTradeItem(1, 4306, 10)]);
    world.cursor = { guid: 0x4000_0001n, bag: 255, slot: 23 };
    boot.vm.executeReported("TradePlayerItem1ItemButton:Click()", "@framexml-preview/trade");
    if (tradeMode === "accept") world.status(TRADE_STATUS_TRADE_ACCEPT);
    renderer.sync();
  }
  // The NPC windows (NPC lane): gated and published exactly as the world mount does it.
  const npcMode = (parameters.get("npc") ?? "").trim().toLowerCase();
  if (npcMode && seam && renderer) {
    const npcWindows = createFrameXmlNpcWindows(seam, boot, renderer);
    console.info("[framexml npc] gates", JSON.stringify(npcWindows.gates));
    npcWindows.publish();
    if (npcMode === "gossip" || npcMode === "confirm") seam.npc.gossip.world.talk();
    if (npcMode === "confirm") boot.vm.executeReported("GossipTitleButton8:Click()", "@framexml-preview/npc");
    if (npcMode === "bank") {
      seam.setBankSlotPrice(0, 1000);
      seam.openBankFrame();
    }
    if (npcMode === "taxi") {
      seam.npc.taxi.world.open();
      boot.vm.executeReported("TaxiNodeOnButtonEnter(TaxiButton6)", "@framexml-preview/npc");
    }
    if (npcMode === "itemtext" || npcMode === "plaque") seam.npc.itemText.world.open(npcMode === "plaque" ? "object" : "item");
    // The charter windows over the canned guild master, arena organizer and charter (FrameXmlPetitionCanned.ts).
    const charters = seam.npc.charters.world;
    if (npcMode === "tabard") charters.openTabard();
    if (npcMode === "guildregistrar") charters.openList(FRAMEXML_CANNED_GUILD_LIST);
    if (npcMode === "arenaregistrar" || npcMode === "banner") {
      charters.carried = [{ guid: 0x4000000000000777n, entry: 23560 }];
      charters.openList(FRAMEXML_CANNED_ARENA_LIST);
      if (npcMode === "banner") boot.vm.executeReported("ArenaRegistrarButton4:Click()", "@framexml-preview/npc");
    }
    if (npcMode === "petition") charters.showCharter();
    // The stable over the canned stable master (FrameXmlStableCanned.ts).
    if (npcMode === "stable" || npcMode === "stablebuy") seam.npc.stable.world.open();
    if (npcMode === "stablebuy") boot.vm.executeReported("PetStablePurchaseButton:Click()", "@framexml-preview/npc");
    renderer.sync();
  }
  // The stock auction house (AUC lane): the add-on loads on the canned hello exactly as the world mount's owner loads it.
  const auctionMode = (parameters.get("auction") ?? "").trim().toLowerCase();
  if (auctionMode && !/^(?:0|false|no|off)$/.test(auctionMode) && seam && renderer) {
    const run = (code: string): void => { boot.vm.executeReported(code, "@framexml-preview/auction"); };
    const settle = async (): Promise<void> => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };
    const owner = createLazyFrameXmlAuctionOwner(seam, boot, renderer, { hide() {}, show() {} },
      (reason) => console.warn("[framexml auction]", reason));
    const world = seam.auctionWorld;
    world.autoAnswer = true;
    world.open();
    await owner.settled;
    await settle();
    run("AuctionFrameBrowse_Search()");
    await settle();
    if (auctionMode === "bids") run("AuctionFrameTab_OnClick(AuctionFrameTab2) BidButton_OnClick(BidButton2)");
    if (auctionMode === "auctions" || auctionMode === "sell" || auctionMode === "multisell") run("AuctionFrameTab_OnClick(AuctionFrameTab3)");
    if (auctionMode === "sell" || auctionMode === "multisell") {
      world.cursor = { guid: 0x4000_0101n, bag: 255, slot: 23 };
      run("AuctionsItemButton:Click()");
    }
    if (auctionMode === "multisell") {
      world.autoAnswer = false;
      run("AuctionsStackSizeEntry:SetNumber(10) AuctionsNumStacksEntry:SetNumber(3) AuctionsFrameAuctions_ValidateAuction() AuctionsCreateAuctionButton:Click()");
      world.answer(0, 0, 3200);
    }
    if (auctionMode === "1") run("BrowseButton_OnClick(BrowseButton4)");
    renderer.sync();
  }
  // The INS lane's three load-on-demand windows, through the same lazy owners the world mount publishes.
  const socketMode = (parameters.get("socket") ?? "").trim().toLowerCase();
  if (socketMode && !/^(?:0|false|no|off)$/.test(socketMode) && seam && renderer) {
    const owner = createLazyFrameXmlSocketOwner(seam, boot, renderer, { open() {} },
      (reason) => console.warn("[framexml socket]", reason));
    boot.vm.executeReported("SocketInventoryItem(1)", "@framexml-preview/socket");
    await owner.settled;
    if (socketMode === "staged") {
      seam.socketWorld.cursor = 0x4000_0101n;
      boot.vm.executeReported("ItemSocketingSocket2:Click()", "@framexml-preview/socket");
    }
    stage.dataset.socketPreview = owner.loaded ? "loaded" : owner.failed ? "failed" : "pending";
    renderer.sync();
  }
  const inspectMode = (parameters.get("inspect") ?? "").trim().toLowerCase();
  if (inspectMode && !/^(?:0|false|no|off)$/.test(inspectMode) && seam && renderer) {
    seam.setTarget(CANNED_INSPECT_TARGET);
    const owner = createLazyFrameXmlInspectOwner(seam, boot, renderer, () => {},
      (reason) => console.warn("[framexml inspect]", reason));
    routeFrameXmlInspectUnit(boot, owner);
    boot.vm.executeReported('InspectUnit("target")', "@framexml-preview/inspect");
    await owner.settled;
    seam.inspectWorld.answer();
    if (inspectMode === "talents") boot.vm.executeReported("InspectFrameTab3:Click()", "@framexml-preview/inspect");
    if (inspectMode === "pvp") {
      boot.vm.executeReported("InspectFrameTab2:Click()", "@framexml-preview/inspect");
      seam.inspectWorld.answerHonor();
    }
    stage.dataset.inspectPreview = owner.loaded ? "loaded" : owner.failed ? "failed" : "pending";
    renderer.sync();
  }
  const barberMode = (parameters.get("barber") ?? "").trim().toLowerCase();
  if (barberMode && !/^(?:0|false|no|off)$/.test(barberMode) && seam && renderer) {
    const owner = createLazyFrameXmlBarberOwner(seam, boot, renderer, { hide() {}, show() {} }, () => Promise.resolve(),
      (reason) => console.warn("[framexml barber]", reason));
    seam.barberWorld.sit();
    await owner.settled;
    if (barberMode === "changed") {
      boot.vm.executeReported("BarberShopFrameSelector1Next:Click() BarberShopFrameSelector3Next:Click()", "@framexml-preview/barber");
    }
    stage.dataset.barberPreview = owner.ownsShop() ? "owned" : owner.failed ? "failed" : "pending";
    renderer.sync();
  }
  // The stock achievement window (ACH lane): the canned catalog, AlertFrames.xml and the add-on load
  // through the world mount's lazy owner; stock's own ToggleAchievementFrame/InspectAchievements reach it.
  const achievementMode = (parameters.get("achievement") ?? "").trim().toLowerCase();
  if (achievementMode && !/^(?:0|false|no|off)$/.test(achievementMode) && seam && renderer) {
    const run = (code: string): void => { boot.vm.executeReported(code, "@framexml-preview/achievement"); };
    const owner = createLazyFrameXmlAchievementOwner(seam, boot, renderer, {
      onFailure: (reason) => console.warn("[framexml achievements]", reason),
    });
    installFrameXmlAchievementHostGlobals(boot, {
      toggle: (stats) => { owner.toggle(stats); }, load: () => { owner.begin(); }, compare: (unit) => { owner.compare(unit); },
    });
    if (achievementMode === "toast") seam.achievementWorld.earn(8);
    else if (achievementMode === "compare") owner.compare("party1");
    else owner.toggle(achievementMode === "stats");
    await owner.settled;
    // The canned inspect answer lands a microtask after the comparison's query.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const category = (id: number): void => run(`for _, b in ipairs(AchievementFrameCategoriesContainer.buttons) do
      if b:IsShown() and b.categoryID == ${id} then AchievementCategoryButton_OnClick(b) break end end`);
    const row = (id: number): void => run(`for _, b in ipairs(AchievementFrameAchievementsContainer.buttons) do
      if b:IsShown() and b.id == ${id} then AchievementButton_OnClick(b, true) break end end`);
    if (achievementMode === "general") { category(92); row(16); }
    if (achievementMode === "explore") { category(97); category(14777); row(776); }
    if (achievementMode === "stats") category(122);
    if (achievementMode === "compare") category(92);
    if (achievementMode === "track") { category(96); run("AchievementButton_ToggleTracking(503)"); }
    renderer.sync();
    stage.dataset.achievementPreview = owner.failed ? "failed" : boot.bridge.getFrame("AchievementFrame")?.visible ? "open" : "closed";
  }
  // The stock guild bank (GBK lane): the add-on loads on the canned vault's first list, as the world mount's owner loads it.
  const guildBankMode = (parameters.get("guildbank") ?? "").trim().toLowerCase();
  if (guildBankMode && !/^(?:0|false|no|off)$/.test(guildBankMode) && seam && renderer) {
    const run = (code: string): void => { boot.vm.executeReported(code, "@framexml-preview/guildbank"); };
    const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
    const owner = createLazyFrameXmlGuildBankOwner(seam, boot, renderer, { hide() {}, show() {} },
      (reason) => console.warn("[framexml guild bank]", reason));
    const world = seam.guildBankWorld;
    world.autoAnswer = true;
    world.open();
    seam.guildBank.tick();
    await owner.settled;
    await settle();
    const tabs: Readonly<Record<string, string>> = { log: "GuildBankFrameTab2", moneylog: "GuildBankFrameTab3", info: "GuildBankFrameTab4" };
    const tab = tabs[guildBankMode];
    if (tab) run(`GuildBankFrameTab_OnClick(${tab}, ${tab.slice(-1)})`);
    if (guildBankMode === "buy") run("GuildBankTab3Button:Click()");
    if (guildBankMode === "popup") run("GuildBankTab2Button:Click('RightButton')");
    if (guildBankMode === "held") run("GuildBankColumn1Button4:Click('LeftButton')");
    await settle();
    renderer.sync();
  }

  let trainerPreview = "disabled";
  if (trainerRequested) {
    if (!seam || !renderer) {
      trainerPreview = "unavailable";
    } else {
      seam.openTrainer();
      const addon = await boot.loadAddon("Blizzard_TrainerUI");
      if (!addon.ok) throw new Error(addon.message);
      renderer.addRoots(addon.roots);
      // The stock root is parented into UIParent, so the LoD delta can legitimately have no roots.
      renderer.sync();
      const root = boot.bridge.getFrame("ClassTrainerFrame");
      const show = boot.vm.globalFunction("ClassTrainerFrame_Show");
      if (!root || !show) {
        if (show) boot.vm.release(show);
        throw new Error("Blizzard_TrainerUI preview gate is incomplete");
      }
      const before = boot.errorCount;
      const diagnosticsBefore = boot.bridge.diagnostics.length;
      try {
        boot.bridge.Show(root);
        if (boot.errorCount > before || boot.bridge.diagnostics.length > diagnosticsBefore) {
          throw new Error("Blizzard_TrainerUI preview OnShow reported an error");
        }
        boot.vm.call(show, [], 0);
        if (boot.errorCount > before || boot.bridge.diagnostics.length > diagnosticsBefore) {
          // GlueLua records handled Lua failures instead of throwing them. A preview must not report
          // a visible trainer after such a failed stock call, so undo the probe before propagating.
          throw new Error("Blizzard_TrainerUI preview raised a Lua error");
        }
      } catch (error) {
        try { boot.bridge.Hide(root); } catch { /* preserve the original preview failure */ }
        throw error;
      } finally {
        boot.vm.release(show);
      }
      renderer.sync();
      if (!boot.bridge.isVisible(root)) throw new Error("Blizzard_TrainerUI preview did not open");
      trainerPreview = addon.status;
    }
  }
  const publishTrainerPreview = (): void => {
    if (!trainerRequested) return;
    stage.dataset.trainerPreview = trainerPreview;
    stage.dataset.trainerVisible = String(boot.bridge.getFrame("ClassTrainerFrame")?.visible === true);
    stage.dataset.trainerBuyRequests = seam ? seam.trainerBuyRequests.join(",") : "";
  };
  publishTrainerPreview();

  // The TSK lane's preview: the same lazy owner the world mount publishes, with no native window
  // behind it; the add-on loads, the gate runs, and the canned line opens through TRADE_SKILL_SHOW.
  const tradeSkillMode = (parameters.get("tradeskill") ?? "").trim().toLowerCase();
  if (tradeSkillMode !== "" && !/^(?:0|false|no|off)$/.test(tradeSkillMode) && seam && renderer) {
    let failed = false;
    const owner = createLazyFrameXmlTradeSkillOwner({
      seam, boot, renderer, native: { open: () => true, stepAside: () => {} },
      onFailure: () => { failed = true; },
    });
    const enchanting = tradeSkillMode === "enchanting" || tradeSkillMode === "target";
    owner.open(enchanting ? FRAMEXML_CANNED_ENCHANTING : FRAMEXML_CANNED_BLACKSMITHING);
    const root = (): boolean => boot.bridge.getFrame("TradeSkillFrame")?.visible === true;
    // Up to 30 s: the four files and the gate took 3-20 s here with other work on the machine.
    for (let wait = 0; wait < 3000 && !root() && !failed; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (tradeSkillMode === "makeable") {
      boot.vm.executeReported("TradeSkillFrameAvailableFilterCheckButton:Click()", "@framexml-preview/tradeskill");
    }
    if (tradeSkillMode === "target") boot.vm.executeReported("TradeSkillCreateButton:Click()", "@framexml-preview/tradeskill");
    seam.tradeSkill.tick();
    renderer.sync();
    stage.dataset.tradeSkillPreview = failed ? "failed" : root() ? "open" : "closed";
  }

  // The MAC lane's preview: the world mount's own publication of the two load-on-demand windows;
  // `?macros=` opens MacroFrame (`character` its second tab, `new` the icon popup), `?keybindings=`
  // KeyBindingFrame (`capture` with MOVEFORWARD's first key waiting for a press).
  const macroMode = (parameters.get("macros") ?? "").trim().toLowerCase();
  const bindingMode = (parameters.get("keybindings") ?? "").trim().toLowerCase();
  const wanted = (mode: string): boolean => mode !== "" && !/^(?:0|false|no|off)$/.test(mode);
  if ((wanted(macroMode) || wanted(bindingMode)) && seam && renderer) {
    const nativeOpens: string[] = [];
    mountFrameXmlMacroBindingWindows(seam, boot, renderer, {
      openMacros: () => { if (!openFrameXmlMacro()) nativeOpens.push("macros"); },
      openNativeMacros: () => { nativeOpens.push("macros"); },
      openNativeKeyBindings: () => { nativeOpens.push("keybindings"); },
    }).publish();
    const shown = (name: string): boolean => boot.bridge.getFrame(name)?.visible === true;
    const wait = async (name: string): Promise<void> => {
      for (let tick = 0; tick < 300 && !shown(name) && nativeOpens.length === 0; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const run = (code: string): void => { boot.vm.executeReported(code, "@framexml-preview/macros"); };
    if (wanted(macroMode)) {
      openFrameXmlMacro();
      await wait("MacroFrame");
      if (macroMode === "character") run("MacroFrameTab2:Click()");
      if (macroMode === "new") run("MacroNewButton:Click()");
      stage.dataset.macroPreview = shown("MacroFrame") ? "open" : nativeOpens.includes("macros") ? "native" : "closed";
    }
    if (wanted(bindingMode)) {
      openFrameXmlKeyBindings();
      await wait("KeyBindingFrame");
      if (bindingMode === "capture") run("KeyBindingFrameBinding2Key1Button:Click()");
      stage.dataset.keyBindingPreview = shown("KeyBindingFrame") ? "open" : nativeOpens.includes("keybindings") ? "native" : "closed";
    }
    renderer.sync();
  }

  // The OPT lane's preview: the options chain loaded late by the world mount's lazy owner, over a
  // settings model kept in this page; `frameXmlOptionsWrites()` lists what the controls wrote.
  if (optionsPreview && seam && renderer) {
    stage.dataset.optionsPreview = await openFrameXmlOptionsPreview(boot, renderer, optionsPreview);
    Object.defineProperty(window, "frameXmlOptionsWrites", {
      configurable: true,
      value: () => optionsPreview.writes.map(([id, value]) => [id, value]),
    });
  }

  // The CAL lane's preview: GameTimeFrame's click reaches the world mount's own route and lazy owner.
  const calendarMode = (parameters.get("calendar") ?? "").trim().toLowerCase();
  if (calendarMode !== "" && !/^(?:0|false|no|off)$/.test(calendarMode) && seam && renderer) {
    let nativeCalendar = false;
    installFrameXmlCalendarRoutes(boot, {
      toggle: () => { if (!toggleFrameXmlCalendar()) nativeCalendar = true; },
      open: () => { if (!openFrameXmlCalendar()) nativeCalendar = true; },
    });
    mountFrameXmlCalendar(seam, boot, renderer, { openNative: () => { nativeCalendar = true; } }).publish();
    const calendarShown = (): boolean => boot.bridge.getFrame("CalendarFrame")?.visible === true;
    const run = (code: string): void => { boot.vm.executeReported(code, "@framexml-preview/calendar"); };
    const settle = async (): Promise<void> => { for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 10)); };
    run("GameTimeFrame_OnClick(GameTimeFrame)");
    for (let tick = 0; tick < 300 && !calendarShown() && !nativeCalendar; tick += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await settle();
    // The day button whose events include `title`, and the event button showing it.
    const clickEvent = (title: string, button: string): void => run(`
      for index = 1, 42 do
        local day = _G["CalendarDayButton" .. index]
        for slot = 1, 4 do
          local event = _G[day:GetName() .. "EventButton" .. slot]
          if event:IsShown() and event.eventIndex and CalendarGetDayEvent(day.monthOffset, day.day, event.eventIndex) == ${JSON.stringify(title)} then
            CalendarDayEventButton_OnClick(event, "${button}")
            return
          end
        end
      end`);
    if (calendarMode === "event") clickEvent("Наксрамас 25", "LeftButton");
    if (calendarMode === "holiday") clickEvent("Детская неделя", "LeftButton");
    if (calendarMode === "menu") clickEvent("Мертвые копи", "RightButton");
    if (calendarMode === "create") run(`
      local _, month, today = CalendarGetDate()
      for index = 1, 42 do
        local day = _G["CalendarDayButton" .. index]
        if day.monthOffset == 0 and day.day == today + 2 then
          CalendarDayButton_OnClick(day, "RightButton")
          CalendarDayContextMenu_CreateEvent()
          -- A clicked menu row hides its menu (UIMenuButton_OnClick); this call skips the click.
          CalendarContextMenu_Hide()
          return
        end
      end`);
    await settle();
    renderer.sync();
    stage.dataset.calendarPreview = calendarShown() ? "open" : nativeCalendar ? "native" : "closed";
  }

  /**
   * The frame loop, and the two things it is for.
   *
   * `bridge.tick` is what `ActionButton_OnUpdate` needs — the range indicator and the attack flash
   * — and it costs nothing on a frame where nothing mutated, because the bridge only notifies its
   * listeners when a dispatch actually changed something. `renderer.tickCooldowns` is the sweep,
   * and it walks only the Cooldown widgets rather than the whole tree.
   *
   * Deliberately *not* started when there is no seam: with F2's neutral world nothing moves, and a
   * census page should not be spending a frame budget on proving it.
   */
  let frames = 0;
  if (seam) {
    let previous = boot.pump.now();
    const step = (): void => {
      const now = boot.pump.now();
      const elapsed = Math.min(0.25, Math.max(0, now - previous));
      previous = now;
      frames += 1;
      // One render transaction for the seam's events and the OnUpdate walk, as the world mount's
      // step does: unbatched, each canned UNIT_HEALTH/UNIT_RAGE became a sync of its own.
      boot.bridge.runInMutationBatch(() => {
        seam.tick(now);
        boot.bridge.tick(elapsed);
      });
      renderer?.tickCooldowns(now);
      publishTrainerPreview();
      window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  }

  // Published for the browser smoke, the same contract `glueDiagnostics` has: the acceptance checks
  // read the numbers out of the live page instead of being told what they should be.
  Object.defineProperty(window, "frameXmlDiagnostics", {
    configurable: true,
    value: () => ({
      ...inventory,
      live: {
        frames,
        now: boot.pump.now(),
        cooldownWidgets: renderer?.cooldownCount ?? 0,
        cooldownsRunning: renderer?.tickCooldowns() ?? 0,
        trainerPreview,
        trainerVisible: boot.bridge.getFrame("ClassTrainerFrame")?.visible === true,
        trainerBuyRequests: seam ? [...seam.trainerBuyRequests] : [],
        merchantVisible: boot.bridge.getFrame("MerchantFrame")?.visible === true,
        merchantRows: seam?.merchantNumItems() ?? 0,
        merchantBuyRequests: seam ? [...seam.merchantBuyRequests] : [],
        gameMenuVisible: boot.bridge.getFrame("GameMenuFrame")?.visible === true,
        lfdVisible: boot.bridge.getFrame("LFDParentFrame")?.visible === true,
        lfdCalls: seam ? seam.lfdWorld.calls.map((call) => call.kind) : [],
        friendsVisible: boot.bridge.getFrame("FriendsFrame")?.visible === true,
        socialCalls: seam ? seam.socialWorld.calls.map((call) => call.kind) : [],
        popupsVisible: [1, 2, 3, 4].filter((index) => boot.bridge.getFrame(`StaticPopup${index}`)?.visible === true)
          .map((index) => `StaticPopup${index}: ${boot.bridge.getFrame(`StaticPopup${index}Text`)?.text ?? ""}`),
        readyCheckVisible: boot.bridge.getFrame("ReadyCheckFrame")?.visible === true,
        popupCalls: seam ? seam.popupsWorld.calls.map((call) => call.kind) : [],
      },
    }),
  });
  // A named handle on the bar for the acceptance check: clicking a button is how the whole
  // secure-attribute chain is proved, and a screenshot cannot press one.
  Object.defineProperty(window, "frameXmlClick", {
    configurable: true,
    value: (name: string) => {
      const frame = boot.bridge.getFrame(name);
      return frame ? boot.bridge.Click(frame, "LeftButton", false) : false;
    },
  });
}

void main().catch((error: unknown) => {
  console.error("[framexml] корпус не загрузился", error);
  say(`Не удалось загрузить интерфейс: ${String(error)}`);
});
