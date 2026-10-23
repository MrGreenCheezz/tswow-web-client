/**
 * 24.10 (7.50): the name the lamp catalog (`LightTemplateCatalog.ts`) files its persistent record under
 * where no gateway publishes a visual generation: the bench (`bench/lookdev.mjs --light-catalog`), so a
 * second run with the same browser profile is a second session. Kept apart so the bench page can set it
 * without importing the catalog.
 */
export interface LightCatalogGeneration {
  readonly origin: string;
  readonly generation: string;
}

let override: LightCatalogGeneration | undefined;

export function overrideLightCatalogGeneration(value: LightCatalogGeneration | undefined): void {
  override = value;
}

export function lightCatalogGenerationOverride(): LightCatalogGeneration | undefined {
  return override;
}
