import { describe, expect, it } from "vitest";
import { quantityOnHandFromAvailable } from "@/lib/quantity-on-hand";

describe("quantityOnHandFromAvailable", () => {
  it("preserves reserved and sold units when setting available stock", () => {
    expect(quantityOnHandFromAvailable(4, 3, 2)).toBe(9);
  });

  it("rejects negative or non-integer quantities", () => {
    expect(() => quantityOnHandFromAvailable(-1, 0, 0)).toThrow(RangeError);
    expect(() => quantityOnHandFromAvailable(1, 0.5, 0)).toThrow(RangeError);
  });
});
