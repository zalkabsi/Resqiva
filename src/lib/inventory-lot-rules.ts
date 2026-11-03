export interface InventoryLotVersion {
  id: string;
  quantityOnHand: number;
  quantityReserved: number;
  quantitySold: number;
  discountedPriceCents: number;
  originalPriceCents: number;
  expiresAt: Date | null;
  sellable: boolean;
}

/** Optimistic-lock predicate covering every mutable field that a merchant can edit. */
export function inventoryLotVersionWhere(lot: InventoryLotVersion): InventoryLotVersion {
  return {
    id: lot.id,
    quantityOnHand: lot.quantityOnHand,
    quantityReserved: lot.quantityReserved,
    quantitySold: lot.quantitySold,
    discountedPriceCents: lot.discountedPriceCents,
    originalPriceCents: lot.originalPriceCents,
    expiresAt: lot.expiresAt,
    sellable: lot.sellable,
  };
}

export function quantityPreservesCommittedUnits(quantityOnHand: number, quantityReserved: number, quantitySold: number): boolean {
  return Number.isSafeInteger(quantityOnHand)
    && Number.isSafeInteger(quantityReserved)
    && Number.isSafeInteger(quantitySold)
    && quantityOnHand >= 0
    && quantityReserved >= 0
    && quantitySold >= 0
    && quantityOnHand >= quantityReserved + quantitySold;
}
