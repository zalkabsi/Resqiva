/** Converts an editable available quantity back to total on-hand stock. */
export function quantityOnHandFromAvailable(available: number, reserved: number, sold: number): number {
  const quantities = [available, reserved, sold];
  if (!quantities.every((quantity) => Number.isSafeInteger(quantity) && quantity >= 0)) {
    throw new RangeError("Available, reserved, and sold quantities must be non-negative safe integers.");
  }
  const onHand = available + reserved + sold;
  if (!Number.isSafeInteger(onHand)) throw new RangeError("The total on-hand quantity is too large.");
  return onHand;
}
