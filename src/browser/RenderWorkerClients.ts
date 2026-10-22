/**
 * 22.10 ARC-2 S6b: the render worker's own resource clients — what app/EnterWorld.ts builds for the in-page renderer
 * and game/Loop.ts hands `draw`: terrain (and its heights), environment, splat, ground cover, liquids, transport
 * paths and horizon. One set per page world entry (RenderWorkerClientProtocol.ts `clients`), built from the same
 * gateway URL; dropped as the page drops its own (game/Context.ts `clearWorldContext` disposes these three).
 */

import { EnvironmentClient, TerrainClient } from "./Terrain.js";
import { TerrainSplatClient } from "./TerrainSplat.js";
import { GroundCoverClient } from "./GroundCover.js";
import { LiquidTextureClient } from "./Water.js";
import { TransportPathClient } from "./TransportPath.js";
import { HorizonClient } from "./Horizon.js";

export class RenderWorkerResourceClients {
  readonly terrain: TerrainClient;
  readonly environment: EnvironmentClient;
  readonly splat: TerrainSplatClient;
  readonly cover: GroundCoverClient;
  readonly liquids: LiquidTextureClient;
  readonly transportPaths: TransportPathClient;
  readonly horizon: HorizonClient;

  constructor(readonly key: number, url: string) {
    this.terrain = new TerrainClient(url);
    this.environment = new EnvironmentClient(url);
    this.splat = new TerrainSplatClient(url);
    this.cover = new GroundCoverClient(url);
    this.liquids = new LiquidTextureClient(url);
    this.transportPaths = new TransportPathClient(url);
    this.horizon = new HorizonClient(url);
  }

  dispose(): void {
    this.liquids.dispose();
    this.splat.dispose();
    this.environment.dispose();
  }
}
