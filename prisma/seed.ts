import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to seed the Resqiva demo database.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

type ProductSeed = {
  sku: string;
  name: string;
  brand?: string;
  category: string;
  description: string;
  ingredients: string[];
  allergens: string[];
  allergenStatus: "VERIFIED" | "PARTIAL" | "UNKNOWN";
  dietaryTags: string[];
  discountedPriceCents: number;
  originalPriceCents: number;
  quantity: number;
  expiresInDays: number | null;
  expirationType: "USE_BY" | "SELL_BY" | "BEST_BEFORE" | "EXPIRATION" | "UNKNOWN";
  lotNote?: string;
};

type MerchantSeed = {
  merchant: { slug: string; name: string; description: string };
  store: { slug: string; name: string; city: string; pickupAddress: string };
  userEmail: string;
  products: ProductSeed[];
};

const vegetarian = ["VEGETARIAN"];
const vegan = ["VEGETARIAN", "VEGAN"];
const glutenFree = ["GLUTEN_FREE"];
const seeds: MerchantSeed[] = [
  {
    merchant: {
      slug: "fictional-green-basket",
      name: "Fictional Demo Merchant — Green Basket",
      description: "Invented merchant used only for the Resqiva demonstration.",
    },
    store: {
      slug: "demo-green-basket-riyadh",
      name: "DEMO — Green Basket Market",
      city: "Riyadh (demo)",
      pickupAddress: "Fictional pickup point A — demonstration only",
    },
    userEmail: "merchant.green@example.invalid",
    products: [
      { sku: "DEMO-A-TOMATO", name: "Ripe tomatoes", category: "produce", description: "Fresh tomatoes approaching their best-before date.", ingredients: ["tomato"], allergens: [], allergenStatus: "VERIFIED", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 189, originalPriceCents: 329, quantity: 8, expiresInDays: 3, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-A-SPINACH", name: "Baby spinach", category: "produce", description: "Washed baby spinach, surplus pack.", ingredients: ["spinach"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 249, originalPriceCents: 399, quantity: 4, expiresInDays: 2, expirationType: "USE_BY" },
      { sku: "DEMO-A-MUSHROOM", name: "Cremini mushrooms", category: "vegetable", description: "Cremini mushrooms for quick weeknight meals.", ingredients: ["mushroom"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 179, originalPriceCents: 299, quantity: 6, expiresInDays: 4, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-A-PEPPER", name: "Red bell peppers", category: "vegetable", description: "Sweet red peppers from the produce aisle.", ingredients: ["bell pepper"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 159, originalPriceCents: 279, quantity: 7, expiresInDays: 5, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-A-CARROT", name: "Carrots", category: "vegetable", description: "Loose carrots, priced per pack.", ingredients: ["carrot"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 99, originalPriceCents: 169, quantity: 10, expiresInDays: 6, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-A-ONION", name: "Yellow onions", category: "vegetable", description: "Yellow onions for soups and skillet meals.", ingredients: ["onion"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 89, originalPriceCents: 149, quantity: 9, expiresInDays: 10, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-A-GARLIC", name: "Garlic bulb", category: "vegetable", description: "Whole garlic bulb.", ingredients: ["garlic"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 59, originalPriceCents: 99, quantity: 12, expiresInDays: 14, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-A-ZUCCHINI", name: "Zucchini", category: "vegetable", description: "Zucchini for roasting or pasta.", ingredients: ["zucchini"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 129, originalPriceCents: 219, quantity: 5, expiresInDays: 3, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-A-LEMON", name: "Lemons", category: "fruit", description: "Lemons sold as a two-count bag.", ingredients: ["lemon"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 99, originalPriceCents: 179, quantity: 6, expiresInDays: 8, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-A-POTATO", name: "Red potatoes", category: "produce", description: "Red potatoes for roasting.", ingredients: ["potato"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 199, originalPriceCents: 349, quantity: 5, expiresInDays: 12, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-A-EGGS", name: "Large eggs", category: "dairy", description: "A dozen large eggs.", ingredients: ["egg"], allergens: ["eggs"], allergenStatus: "VERIFIED", dietaryTags: [...vegetarian, ...glutenFree], discountedPriceCents: 299, originalPriceCents: 429, quantity: 4, expiresInDays: 12, expirationType: "USE_BY" },
      { sku: "DEMO-A-MILK", name: "Whole milk", category: "dairy", description: "One litre whole milk.", ingredients: ["milk"], allergens: ["milk"], allergenStatus: "VERIFIED", dietaryTags: [...vegetarian, ...glutenFree], discountedPriceCents: 199, originalPriceCents: 279, quantity: 3, expiresInDays: 5, expirationType: "USE_BY" },
      { sku: "DEMO-A-CHICKPEAS", name: "Canned chickpeas", category: "protein", description: "Drained weight 240 g; pantry-stable surplus.", ingredients: ["chickpea", "water", "salt"], allergens: [], allergenStatus: "VERIFIED", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 99, originalPriceCents: 159, quantity: 8, expiresInDays: 365, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-A-RICE", name: "Basmati rice", category: "grain", description: "One kilogram bag of basmati rice.", ingredients: ["rice"], allergens: [], allergenStatus: "VERIFIED", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 399, originalPriceCents: 599, quantity: 7, expiresInDays: 200, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-A-CHICKEN", name: "Chicken thighs", category: "meat", description: "Chilled boneless chicken thighs.", ingredients: ["chicken"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...glutenFree, "HALAL"], discountedPriceCents: 549, originalPriceCents: 899, quantity: 3, expiresInDays: 2, expirationType: "USE_BY" },
    ],
  },
  {
    merchant: {
      slug: "fictional-market-lane",
      name: "Fictional Demo Merchant — Market Lane",
      description: "Invented neighborhood grocer for reproducible demo data.",
    },
    store: {
      slug: "demo-market-lane-riyadh",
      name: "DEMO — Market Lane Pantry",
      city: "Riyadh (demo)",
      pickupAddress: "Fictional pickup point B — demonstration only",
    },
    userEmail: "merchant.marketlane@example.invalid",
    products: [
      { sku: "DEMO-B-PASTA", name: "Penne pasta", category: "grain", description: "Dry durum wheat penne.", ingredients: ["durum wheat semolina"], allergens: ["wheat"], allergenStatus: "VERIFIED", dietaryTags: [...vegetarian], discountedPriceCents: 179, originalPriceCents: 279, quantity: 8, expiresInDays: 300, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-B-TOMATO-CAN", name: "Chopped tomatoes", category: "pantry", description: "Canned chopped tomatoes for sauce.", ingredients: ["tomato", "tomato juice", "salt"], allergens: [], allergenStatus: "VERIFIED", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 129, originalPriceCents: 199, quantity: 0, expiresInDays: 300, expirationType: "BEST_BEFORE", lotNote: "Stock-shortage scenario: this lot is intentionally out of stock." },
      { sku: "DEMO-B-BROCCOLI", name: "Broccoli crowns", category: "vegetable", description: "Fresh broccoli crowns.", ingredients: ["broccoli"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 199, originalPriceCents: 329, quantity: 4, expiresInDays: 3, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-B-MOZZARELLA", name: "Mozzarella", category: "dairy", description: "Fresh mozzarella ball.", ingredients: ["milk", "salt", "cultures"], allergens: ["milk"], allergenStatus: "VERIFIED", dietaryTags: [...vegetarian, ...glutenFree], discountedPriceCents: 249, originalPriceCents: 399, quantity: 3, expiresInDays: 4, expirationType: "USE_BY" },
      { sku: "DEMO-B-PARMESAN", name: "Grated Parmesan", category: "dairy", description: "Grated hard cheese.", ingredients: ["milk", "salt", "cultures"], allergens: ["milk"], allergenStatus: "VERIFIED", dietaryTags: [...vegetarian, ...glutenFree], discountedPriceCents: 199, originalPriceCents: 299, quantity: 5, expiresInDays: 30, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-B-TORTILLA", name: "Wheat tortillas", category: "grain", description: "Six-count soft wheat tortillas.", ingredients: ["wheat flour", "water", "vegetable oil"], allergens: ["wheat"], allergenStatus: "VERIFIED", dietaryTags: [...vegetarian], discountedPriceCents: 179, originalPriceCents: 279, quantity: 5, expiresInDays: 8, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-B-BLACKBEAN", name: "Black beans", category: "protein", description: "Canned black beans.", ingredients: ["black beans", "water", "salt"], allergens: [], allergenStatus: "VERIFIED", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 99, originalPriceCents: 159, quantity: 7, expiresInDays: 360, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-B-AVOCADO", name: "Avocados", category: "fruit", description: "Two ripe avocados.", ingredients: ["avocado"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 199, originalPriceCents: 329, quantity: 4, expiresInDays: 2, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-B-CHICKEN", name: "Chicken breast", category: "meat", description: "Chilled chicken breast portions.", ingredients: ["chicken"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...glutenFree, "HALAL"], discountedPriceCents: 599, originalPriceCents: 949, quantity: 3, expiresInDays: 2, expirationType: "USE_BY" },
      { sku: "DEMO-B-SWEETPOTATO", name: "Sweet potatoes", category: "vegetable", description: "Sweet potatoes, one kilogram bag.", ingredients: ["sweet potato"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 229, originalPriceCents: 379, quantity: 5, expiresInDays: 10, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-B-YOGURT", name: "Plain yogurt", category: "dairy", description: "Plain whole-milk yogurt.", ingredients: ["milk", "cultures"], allergens: ["milk"], allergenStatus: "VERIFIED", dietaryTags: [...vegetarian, ...glutenFree], discountedPriceCents: 179, originalPriceCents: 269, quantity: 4, expiresInDays: 5, expirationType: "USE_BY" },
      { sku: "DEMO-B-FETA", name: "Feta cheese", category: "dairy", description: "Feta cheese in brine.", ingredients: ["milk", "salt", "cultures"], allergens: ["milk"], allergenStatus: "VERIFIED", dietaryTags: [...vegetarian, ...glutenFree], discountedPriceCents: 249, originalPriceCents: 389, quantity: 2, expiresInDays: 8, expirationType: "USE_BY" },
      { sku: "DEMO-B-PEANUT", name: "Peanut butter", category: "pantry", description: "Smooth peanut butter; allergen warning is authoritative for this fictional label.", ingredients: ["peanuts", "salt"], allergens: ["peanuts"], allergenStatus: "VERIFIED", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 299, originalPriceCents: 449, quantity: 3, expiresInDays: 180, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-B-OATS", name: "Rolled oats", category: "grain", description: "Rolled oats; gluten cross-contact status not verified.", ingredients: ["oats"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan], discountedPriceCents: 229, originalPriceCents: 359, quantity: 6, expiresInDays: 240, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-B-LENTIL", name: "Brown lentils", category: "protein", description: "Dry brown lentils.", ingredients: ["lentil"], allergens: [], allergenStatus: "VERIFIED", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 269, originalPriceCents: 399, quantity: 6, expiresInDays: 240, expirationType: "BEST_BEFORE" },
    ],
  },
  {
    merchant: {
      slug: "fictional-corner-harvest",
      name: "Fictional Demo Merchant — Corner Harvest",
      description: "Fictional independent shop; no real business is represented.",
    },
    store: {
      slug: "demo-corner-harvest-riyadh",
      name: "DEMO — Corner Harvest Foods",
      city: "Riyadh (demo)",
      pickupAddress: "Fictional pickup point C — demonstration only",
    },
    userEmail: "merchant.cornerharvest@example.invalid",
    products: [
      { sku: "DEMO-C-TOFU", name: "Firm tofu", category: "protein", description: "Firm tofu for stir-fries; only one surplus pack remains.", ingredients: ["soybeans", "water", "coagulant"], allergens: ["soy"], allergenStatus: "VERIFIED", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 249, originalPriceCents: 399, quantity: 1, expiresInDays: 3, expirationType: "USE_BY", lotNote: "Stock-shortage scenario: quantity is intentionally limited to one." },
      { sku: "DEMO-C-COCONUT", name: "Coconut milk", category: "pantry", description: "Canned coconut milk.", ingredients: ["coconut", "water"], allergens: ["tree nuts"], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 179, originalPriceCents: 279, quantity: 5, expiresInDays: 300, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-C-SALMON", name: "Salmon fillet", category: "seafood", description: "Chilled salmon fillet portions.", ingredients: ["salmon"], allergens: ["fish"], allergenStatus: "VERIFIED", dietaryTags: [...glutenFree], discountedPriceCents: 699, originalPriceCents: 1099, quantity: 2, expiresInDays: 2, expirationType: "USE_BY" },
      { sku: "DEMO-C-PEAS", name: "Frozen green peas", category: "vegetable", description: "Frozen green peas.", ingredients: ["green peas"], allergens: [], allergenStatus: "VERIFIED", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 179, originalPriceCents: 279, quantity: 6, expiresInDays: 300, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-C-QUINOA", name: "Quinoa", category: "grain", description: "Quinoa grain, one kilogram bag.", ingredients: ["quinoa"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 399, originalPriceCents: 599, quantity: 4, expiresInDays: 200, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-C-CUCUMBER", name: "Cucumbers", category: "vegetable", description: "Two cucumbers from the produce counter.", ingredients: ["cucumber"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 119, originalPriceCents: 199, quantity: 6, expiresInDays: 3, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-C-CILANTRO", name: "Fresh cilantro", category: "produce", description: "Bunch of fresh cilantro.", ingredients: ["cilantro"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 79, originalPriceCents: 129, quantity: 4, expiresInDays: 2, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-C-HUMMUS", name: "Classic hummus", category: "pantry", description: "Prepared hummus with tahini.", ingredients: ["chickpea", "tahini", "lemon", "garlic"], allergens: ["sesame"], allergenStatus: "VERIFIED", dietaryTags: [...vegan], discountedPriceCents: 199, originalPriceCents: 319, quantity: 3, expiresInDays: 4, expirationType: "USE_BY" },
      { sku: "DEMO-C-TAHINI", name: "Tahini", category: "pantry", description: "Sesame paste in a sealed jar.", ingredients: ["sesame"], allergens: ["sesame"], allergenStatus: "VERIFIED", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 279, originalPriceCents: 429, quantity: 4, expiresInDays: 160, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-C-APPLE", name: "Apples", category: "fruit", description: "Bag of crisp apples.", ingredients: ["apple"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 249, originalPriceCents: 399, quantity: 5, expiresInDays: 8, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-C-BANANA", name: "Bananas", category: "fruit", description: "Ripe bananas for snacks or baking.", ingredients: ["banana"], allergens: [], allergenStatus: "PARTIAL", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 99, originalPriceCents: 159, quantity: 5, expiresInDays: 2, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-C-ALMONDMILK", name: "Unsweetened almond drink", category: "dairy-alternative", description: "Chilled almond drink.", ingredients: ["water", "almonds"], allergens: ["tree nuts"], allergenStatus: "VERIFIED", dietaryTags: [...vegan, ...glutenFree], discountedPriceCents: 199, originalPriceCents: 299, quantity: 4, expiresInDays: 6, expirationType: "USE_BY" },
      { sku: "DEMO-C-SALADMIX", name: "Bagged salad mix", category: "produce", description: "Packaged mixed greens. Allergen and cross-contact metadata were not supplied in this fictional record.", ingredients: [], allergens: [], allergenStatus: "UNKNOWN", dietaryTags: [], discountedPriceCents: 159, originalPriceCents: 249, quantity: 2, expiresInDays: 2, expirationType: "USE_BY", lotNote: "Unknown allergen data: do not describe as allergen-free or safe for restricted diets." },
      { sku: "DEMO-C-BREAD", name: "Country white bread", category: "grain", description: "Sliced wheat bread.", ingredients: ["wheat flour", "water", "yeast", "salt"], allergens: ["wheat"], allergenStatus: "VERIFIED", dietaryTags: [...vegetarian], discountedPriceCents: 169, originalPriceCents: 269, quantity: 4, expiresInDays: 4, expirationType: "BEST_BEFORE" },
      { sku: "DEMO-C-SHRIMP", name: "Frozen shrimp", category: "seafood", description: "Frozen peeled shrimp.", ingredients: ["shrimp"], allergens: ["shellfish"], allergenStatus: "VERIFIED", dietaryTags: [...glutenFree], discountedPriceCents: 549, originalPriceCents: 849, quantity: 3, expiresInDays: 200, expirationType: "BEST_BEFORE" },
    ],
  },
];

const recipes = [
  {
    slug: "tomato-chickpea-rice",
    title: "Tomato chickpea rice",
    description: "A flexible one-pan rice meal with chickpeas and fresh or canned tomato.",
    cuisine: "Mediterranean-inspired",
    servings: 2,
    dietaryTags: [...vegan, ...glutenFree],
    pantryStaples: ["olive oil", "salt", "black pepper", "water"],
    instructions: ["Rinse rice and simmer until nearly tender.", "Add diced tomato, drained chickpeas, and seasoning.", "Cook until the rice is tender and serve warm."],
    requirements: [
      { key: "rice", label: "Rice", category: "grain", quantity: 0.12, unit: "kg" },
      { key: "chickpea", label: "Chickpeas", category: "protein", quantity: 0.12, unit: "kg" },
      { key: "tomato", label: "Tomato", category: "vegetable", quantity: 0.15, unit: "kg" },
    ],
  },
  {
    slug: "vegetable-egg-skillet",
    title: "Vegetable and egg skillet",
    description: "A quick skillet meal built from available vegetables and eggs.",
    cuisine: "Home-style",
    servings: 2,
    dietaryTags: [...vegetarian, ...glutenFree],
    pantryStaples: ["olive oil", "salt", "black pepper"],
    instructions: ["Chop the vegetables into bite-size pieces.", "Cook vegetables in a lightly oiled skillet until tender.", "Add beaten eggs and cook through before serving."],
    requirements: [
      { key: "egg", label: "Eggs", category: "dairy", quantity: 1, unit: "egg" },
      { key: "vegetable", label: "Mixed vegetables", category: "vegetable", quantity: 0.15, unit: "kg" },
    ],
  },
  {
    slug: "chicken-zucchini-rice",
    title: "Chicken and zucchini rice bowl",
    description: "A simple bowl with chicken, zucchini, and a grain side.",
    cuisine: "Home-style",
    servings: 2,
    dietaryTags: [...glutenFree, "HALAL"],
    pantryStaples: ["oil", "salt", "black pepper"],
    instructions: ["Cook the rice according to its package directions.", "Cook chicken thoroughly in a skillet.", "Add sliced zucchini and cook until tender; serve over rice."],
    requirements: [
      { key: "chicken", label: "Chicken", category: "meat", quantity: 0.18, unit: "kg" },
      { key: "zucchini", label: "Zucchini", category: "vegetable", quantity: 0.12, unit: "kg" },
      { key: "rice", label: "Rice", category: "grain", quantity: 0.1, unit: "kg" },
    ],
  },
  {
    slug: "tomato-mozzarella-pasta",
    title: "Tomato and mozzarella pasta",
    description: "Pasta tossed with tomato and mozzarella; use only where dairy is allowed.",
    cuisine: "Italian-inspired",
    servings: 2,
    dietaryTags: [...vegetarian],
    pantryStaples: ["olive oil", "salt", "black pepper"],
    instructions: ["Boil pasta until just tender.", "Warm diced tomatoes with seasoning.", "Combine and finish with mozzarella."],
    requirements: [
      { key: "pasta", label: "Pasta", category: "grain", quantity: 0.12, unit: "kg" },
      { key: "tomato", label: "Tomatoes", category: "vegetable", quantity: 0.15, unit: "kg" },
      { key: "mozzarella", label: "Mozzarella", category: "dairy", quantity: 0.06, unit: "kg" },
    ],
  },
  {
    slug: "tofu-vegetable-stir-fry",
    title: "Tofu and vegetable stir-fry",
    description: "A flexible tofu stir-fry; soy allergy is an explicit exclusion.",
    cuisine: "East Asian-inspired",
    servings: 2,
    dietaryTags: [...vegan, ...glutenFree],
    pantryStaples: ["neutral oil", "garlic", "ginger"],
    instructions: ["Press and cube the tofu.", "Brown tofu in a hot pan; remove briefly.", "Stir-fry available vegetables, return tofu to the pan, and serve over rice."],
    requirements: [
      { key: "tofu", label: "Tofu", category: "protein", quantity: 0.15, unit: "kg" },
      { key: "vegetable", label: "Mixed vegetables", category: "vegetable", quantity: 0.15, unit: "kg" },
      { key: "rice", label: "Rice", category: "grain", quantity: 0.1, unit: "kg" },
    ],
  },
  {
    slug: "salmon-quinoa-bowl",
    title: "Salmon and quinoa bowl",
    description: "A fish bowl with quinoa and vegetables; fish allergy is an explicit exclusion.",
    cuisine: "Home-style",
    servings: 2,
    dietaryTags: [...glutenFree],
    pantryStaples: ["olive oil", "lemon", "salt", "black pepper"],
    instructions: ["Rinse and cook quinoa.", "Cook salmon to a safe internal temperature.", "Serve with cooked vegetables and lemon."],
    requirements: [
      { key: "salmon", label: "Salmon", category: "seafood", quantity: 0.16, unit: "kg" },
      { key: "quinoa", label: "Quinoa", category: "grain", quantity: 0.1, unit: "kg" },
      { key: "vegetable", label: "Mixed vegetables", category: "vegetable", quantity: 0.12, unit: "kg" },
    ],
  },
];

const startOfTodayUtc = new Date();
startOfTodayUtc.setUTCHours(0, 0, 0, 0);
const plusDays = (days: number, hour = 0, minute = 0) =>
  new Date(startOfTodayUtc.getTime() + days * 86_400_000 + hour * 3_600_000 + minute * 60_000);

async function seed() {
  const demoCustomer = await prisma.user.upsert({
    where: { email: "shopper@demo.resqiva.invalid" },
    update: { displayName: "Demo Shopper", role: "CUSTOMER", isDemo: true },
    create: { email: "shopper@demo.resqiva.invalid", displayName: "Demo Shopper", role: "CUSTOMER", isDemo: true },
  });

  const records = new Map<string, { merchantId: string; storeId: string; ownerId: string }>();
  for (const [merchantIndex, group] of seeds.entries()) {
    const merchant = await prisma.merchant.upsert({
      where: { slug: group.merchant.slug },
      update: { name: group.merchant.name, description: group.merchant.description, isDemo: true },
      create: { ...group.merchant, isDemo: true },
    });
    const store = await prisma.store.upsert({
      where: { slug: group.store.slug },
      update: {
        merchantId: merchant.id,
        name: group.store.name,
        city: group.store.city,
        pickupAddress: group.store.pickupAddress,
        currency: "USD",
        timezone: "Asia/Riyadh",
        isDemo: true,
      },
      create: {
        ...group.store,
        merchantId: merchant.id,
        currency: "USD",
        timezone: "Asia/Riyadh",
        isDemo: true,
      },
    });
    const owner = await prisma.user.upsert({
      where: { email: group.userEmail },
      update: { displayName: `Demo Merchant ${merchantIndex + 1}`, role: "MERCHANT_ADMIN", isDemo: true },
      create: {
        email: group.userEmail,
        displayName: `Demo Merchant ${merchantIndex + 1}`,
        role: "MERCHANT_ADMIN",
        isDemo: true,
      },
    });
    await prisma.merchantMember.upsert({
      where: { merchantId_userId: { merchantId: merchant.id, userId: owner.id } },
      update: { role: "MERCHANT_ADMIN" },
      create: { merchantId: merchant.id, userId: owner.id, role: "MERCHANT_ADMIN" },
    });
    records.set(group.store.slug, { merchantId: merchant.id, storeId: store.id, ownerId: owner.id });

    for (const [productIndex, item] of group.products.entries()) {
      const product = await prisma.product.upsert({
        where: { sku: item.sku },
        update: {
          merchantId: merchant.id,
          name: item.name,
          brand: item.brand,
          category: item.category,
          description: item.description,
          ingredients: item.ingredients,
          knownAllergens: item.allergens,
          allergenDataStatus: item.allergenStatus,
          dietaryTags: item.dietaryTags,
          isDemo: true,
          isActive: true,
        },
        create: {
          sku: item.sku,
          name: item.name,
          brand: item.brand,
          category: item.category,
          description: item.description,
          ingredients: item.ingredients,
          knownAllergens: item.allergens,
          allergenDataStatus: item.allergenStatus,
          dietaryTags: item.dietaryTags,
          merchantId: merchant.id,
          isDemo: true,
          isActive: true,
        },
      });
      const lotCode = `DEMO-${merchantIndex + 1}-${String(productIndex + 1).padStart(2, "0")}`;
      const expiresAt = item.expiresInDays === null ? null : plusDays(item.expiresInDays, 23, 59);
      await prisma.inventoryLot.upsert({
        where: {
          storeId_productId_lotCode: {
            storeId: store.id,
            productId: product.id,
            lotCode,
          },
        },
        update: {
          quantityOnHand: item.quantity,
          quantityReserved: 0,
          quantitySold: 0,
          discountedPriceCents: item.discountedPriceCents,
          originalPriceCents: item.originalPriceCents,
          currency: "USD",
          expiresAt,
          expirationType: item.expirationType,
          sellable: item.expiresInDays !== null && item.expiresInDays >= 0,
          notes: item.lotNote ?? "Fictional surplus inventory for the Resqiva demo.",
        },
        create: {
          storeId: store.id,
          productId: product.id,
          lotCode,
          quantityOnHand: item.quantity,
          discountedPriceCents: item.discountedPriceCents,
          originalPriceCents: item.originalPriceCents,
          currency: "USD",
          expiresAt,
          expirationType: item.expirationType,
          sellable: item.expiresInDays !== null && item.expiresInDays >= 0,
          notes: item.lotNote ?? "Fictional surplus inventory for the Resqiva demo.",
        },
      });
    }

    for (const [windowIndex, [day, startHour, endHour]] of [
      [1, 11, 13],
      [1, 17, 19],
      [2, 11, 13],
      [2, 17, 19],
    ].entries()) {
      const windowKey = `${group.store.slug}-${day}-${startHour}-${windowIndex}`;
      await prisma.pickupWindow.upsert({
        where: { windowKey },
        update: {
          startsAt: plusDays(day, startHour),
          endsAt: plusDays(day, endHour),
          lastReservationAt: plusDays(day, startHour - 1, 30),
          capacityUnits: 100,
          reservedUnits: 0,
          active: true,
        },
        create: {
          storeId: store.id,
          windowKey,
          startsAt: plusDays(day, startHour),
          endsAt: plusDays(day, endHour),
          lastReservationAt: plusDays(day, startHour - 1, 30),
          capacityUnits: 100,
          active: true,
        },
      });
    }
  }

  for (const recipeSeed of recipes) {
    const recipe = await prisma.recipeTemplate.upsert({
      where: { slug: recipeSeed.slug },
      update: {
        title: recipeSeed.title,
        description: recipeSeed.description,
        cuisine: recipeSeed.cuisine,
        defaultServings: recipeSeed.servings,
        dietaryTags: recipeSeed.dietaryTags,
        instructions: recipeSeed.instructions,
        pantryStaples: recipeSeed.pantryStaples,
        isActive: true,
      },
      create: {
        slug: recipeSeed.slug,
        title: recipeSeed.title,
        description: recipeSeed.description,
        cuisine: recipeSeed.cuisine,
        defaultServings: recipeSeed.servings,
        dietaryTags: recipeSeed.dietaryTags,
        instructions: recipeSeed.instructions,
        pantryStaples: recipeSeed.pantryStaples,
        isActive: true,
      },
    });
    await prisma.recipeRequirement.deleteMany({ where: { recipeId: recipe.id } });
    await prisma.recipeRequirement.createMany({
      data: recipeSeed.requirements.map((requirement) => ({
        recipeId: recipe.id,
        ingredientKey: requirement.key,
        label: requirement.label,
        category: requirement.category,
        quantityPerServing: requirement.quantity,
        unit: requirement.unit,
        required: true,
        pantryStaple: false,
      })),
    });
  }

  console.info(
    `Seeded ${seeds.length} fictional demo merchants, ${seeds.length} stores, ${seeds.reduce((total, merchant) => total + merchant.products.length, 0)} inventory products, and ${recipes.length} recipe templates. Demo shopper id: ${demoCustomer.id}`,
  );
}

seed()
  .catch((error: unknown) => {
    console.error("Resqiva demo seed failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
