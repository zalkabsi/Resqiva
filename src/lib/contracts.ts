export type DietaryTag =
  | "VEGETARIAN"
  | "VEGAN"
  | "GLUTEN_FREE"
  | "DAIRY_FREE"
  | "HALAL"
  | "LOW_SODIUM";

export interface PlannerPreferences {
  budgetCents: number;
  servings: number;
  mealCount: number;
  exclusions: string[];
  allergies: string[];
  preferredIngredients: string[];
  avoidIngredients: string[];
  pickupDate: string;
  storeId?: string;
  sourceText: string;
}

export interface InventoryProduct {
  id: string;
  storeId: string;
  name: string;
  category: string;
  priceCents: number;
  originalPriceCents: number;
  quantityAvailable: number;
  allergens: string[];
  dietaryTags: string[];
  ingredients: string[];
  expiresAt: string | null;
  pickupStart: string;
  pickupEnd: string;
}

export interface PlannedItem {
  inventoryId: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  originalUnitPriceCents: number;
}

export interface PlannedMeal {
  title: string;
  servings: number;
  itemNames: string[];
  pantryStaples: string[];
  instructions: string[];
}

export interface PlannedBundle {
  id: string;
  storeId: string;
  storeName: string;
  items: PlannedItem[];
  meals: PlannedMeal[];
  totalCents: number;
  originalTotalCents: number;
  savingsCents: number;
  verifiedSurplusUnits: number;
  pickupStart: string;
  pickupEnd: string;
  explanation: string;
}
