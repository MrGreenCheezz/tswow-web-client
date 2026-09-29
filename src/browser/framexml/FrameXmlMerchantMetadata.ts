import type { ItemMetadata } from "../ItemMetadata.js";
import type { VendorInventory } from "../../world/VendorProtocol.js";
import type { VendorCost } from "../../gateway/VendorCostMetadata.js";

/** The part of the item-template row that can affect a MerchantFrame presentation. */
export interface FrameXmlMerchantItemTemplate {
  readonly name?: string;
  readonly stackable?: number;
}

/** The deliberately small cache surface needed by the merchant owner. */
export interface FrameXmlMerchantMetadataCache {
  get(entry: number): ItemMetadata | undefined;
  load(entries: readonly number[]): Promise<boolean>;
}

export interface FrameXmlMerchantMetadataCoordinatorOptions {
  /** The current world vendor; identity is used to discard a late response for an old list. */
  vendor(): VendorInventory | undefined;
  itemMetadata(): FrameXmlMerchantMetadataCache | undefined;
  itemTemplate(entry: number): FrameXmlMerchantItemTemplate | undefined;
  /** The already-loaded ItemExtendedCost row; a missing row never fabricates a price. */
  costFor?(id: number): VendorCost | undefined;
  /** Called after an HTTP response changed the cache; the owner decides whether to repaint. */
  onMetadataLoaded(): void;
}

export interface FrameXmlMerchantMetadataRefresh {
  /** Whether the relevant presentation fields differ from the previous refresh. */
  readonly changed: boolean;
  /** Stable signature of vendor rows, costs and their visible metadata. */
  readonly signature: string;
}

export interface FrameXmlMerchantMetadataCoordinator {
  /** Refresh the signature and, for a vendor refresh, start one bounded metadata prefetch. */
  refresh(reason?: "vendor" | "metadata"): FrameXmlMerchantMetadataRefresh;
  /** Forget the old list/request when the vendor closes. */
  reset(): void;
}

/**
 * Coordinates merchant item metadata without putting network work in a synchronous C API.
 *
 * Both ordinary and extended-cost rows enter this state machine. Once the cost DBC arrives, its
 * turn-in items are prefetched as well. HTTP completion and the wire QUERY_CACHE_CHANGED callback can both call
 * `refresh("metadata")`; the signature makes the second path a no-op.
 */
export function createFrameXmlMerchantMetadataCoordinator(
  options: FrameXmlMerchantMetadataCoordinatorOptions,
): FrameXmlMerchantMetadataCoordinator {
  let request = "";
  let presentation = "";

  const referencedEntries = (vendor: VendorInventory): number[] => [...new Set(vendor.items.flatMap((item) => [
    item.itemId,
    ...(options.costFor?.(item.extendedCost)?.items.map((cost) => cost.entry) ?? []),
  ]))];

  const metadataShape = (entry: number, metadata: FrameXmlMerchantMetadataCache | undefined): string => {
    const value = metadata?.get(entry);
    const template = options.itemTemplate(entry);
    return [entry, value?.name ?? template?.name ?? "", value?.displayId ?? "",
      value?.iconId ?? "", value?.stackable ?? template?.stackable ?? ""].join(":");
  };

  const signatureOf = (
    vendor: VendorInventory,
    metadata: FrameXmlMerchantMetadataCache | undefined,
  ): string => vendor.items.map((item) => {
    const cost = item.extendedCost > 0 ? options.costFor?.(item.extendedCost) : undefined;
    return [
      metadataShape(item.itemId, metadata), item.extendedCost,
      cost?.honor ?? "", cost?.arena ?? "", cost?.arenaBracket ?? "", cost?.rating ?? "",
      ...(cost?.items.map((required) => `${required.count}:${metadataShape(required.entry, metadata)}`) ?? []),
    ].join(":");
  }).join("|");

  const prefetch = (vendor: VendorInventory, metadata: FrameXmlMerchantMetadataCache): void => {
    const unresolved = referencedEntries(vendor)
      .filter((itemId) => !metadata.get(itemId));
    if (unresolved.length === 0) {
      request = "";
      return;
    }
    const nextRequest = `${vendor.guid.toString()}:${unresolved.join(",")}`;
    if (nextRequest === request) return;
    request = nextRequest;
    void metadata.load(unresolved).then((changed) => {
      // ItemMetadataClient's HTTP path intentionally does not invoke its attached wire callback.
      // Re-enter through the outer owner only for a successful response and the same vendor list.
      if (changed && options.vendor() === vendor) options.onMetadataLoaded();
    }).catch(() => {
      // A failed prefetch is not a presentation edge and must not recurse into the owner.
      if (request === nextRequest) request = "";
    });
  };

  return {
    refresh(reason = "vendor"): FrameXmlMerchantMetadataRefresh {
      const vendor = options.vendor();
      if (!vendor) {
        const changed = presentation !== "";
        presentation = "";
        request = "";
        return { changed, signature: "" };
      }
      const next = signatureOf(vendor, options.itemMetadata());
      const changed = next !== presentation;
      presentation = next;
      if (reason === "vendor") {
        const metadata = options.itemMetadata();
        if (metadata) prefetch(vendor, metadata);
      }
      return { changed, signature: next };
    },
    reset(): void {
      request = "";
      presentation = "";
    },
  };
}
