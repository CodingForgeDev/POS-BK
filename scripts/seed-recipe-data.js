/**
 * BOM-style recipes: quantity consumed per 1 sold unit of each menu product.
 * Inventory `name` strings MUST match rows from `seed-inventory-from-menu.js` (run that seed first).
 *
 * Quantity basis (web / industry norms — rounded for POS demo):
 * - Pizza mozzarella by size (~10" / ~12" / ~14"): ~110g / ~140g / ~220g (housevivid.com, pizza portion guides).
 * - Pizza sauce (tomato): roughly half the cheese weight by mass for thin NY-style spread.
 * - Burger cheese slice: ~28–35g → 0.03 kg; patty counted as 1 pc.
 * - Espresso beans: ~7–9g per single shot → 0.007 kg.
 * - Milk drinks: 150–220 ml milk per 12–16 oz latte/cappuccino range.
 */

const { MENU } = require("./seed-menu-data");

/** @typedef {{ inventoryName: string; quantityPerUnit: number }} RecipeLine */

function lines(...pairs) {
  /** @type {RecipeLine[]} */
  const out = [];
  for (let i = 0; i < pairs.length; i += 2) {
    out.push({ inventoryName: pairs[i], quantityPerUnit: pairs[i + 1] });
  }
  return out;
}

/** Personal / Regular / Large — cheese & sauce scale (kg, dough always 1 ball). */
const PZ = {
  P: { moz: 0.11, sauce: 0.055, dough: 1, oregano: 0.002, basil: 4, pep: 10 },
  R: { moz: 0.14, sauce: 0.075, dough: 1, oregano: 0.0025, basil: 6, pep: 16 },
  L: { moz: 0.22, sauce: 0.105, dough: 1, oregano: 0.003, basil: 8, pep: 24 },
};

function pizzaMargherita(size) {
  const s = PZ[size];
  return lines(
    "Pizza Dough",
    s.dough,
    "Tomato",
    s.sauce,
    "Mozzarella",
    s.moz,
    "Basil",
    s.basil,
    "Oregano",
    s.oregano
  );
}

function pizzaPepperoni(size) {
  const s = PZ[size];
  return lines(
    "Pizza Dough",
    s.dough,
    "Tomato",
    s.sauce,
    "Mozzarella",
    s.moz,
    "Pepperoni",
    s.pep,
    "Oregano",
    s.oregano
  );
}

function pizzaBbqChicken(size) {
  const s = PZ[size];
  const onion = size === "P" ? 0.06 : size === "R" ? 0.08 : 0.1;
  const ch = 1;
  return lines(
    "Pizza Dough",
    s.dough,
    "BBQ Sauce",
    s.sauce,
    "Chicken",
    ch,
    "Onion",
    onion,
    "Mozzarella",
    s.moz,
    "Oregano",
    s.oregano
  );
}

function pizzaFajita(size) {
  const s = PZ[size];
  const tom = size === "P" ? 0.045 : size === "R" ? 0.06 : 0.08;
  const cap = size === "P" ? 0.07 : size === "R" ? 0.09 : 0.12;
  const on = size === "P" ? 0.05 : size === "R" ? 0.07 : 0.09;
  return lines(
    "Pizza Dough",
    s.dough,
    "Tomato",
    tom,
    "Hot Sauce",
    0.02,
    "Chicken",
    1,
    "Capsicum",
    cap,
    "Onion",
    on,
    "Mozzarella",
    s.moz,
    "Oregano",
    s.oregano
  );
}

function pizzaVeggie(size) {
  const s = PZ[size];
  const mush = size === "P" ? 0.05 : size === "R" ? 0.07 : 0.1;
  const oli = size === "P" ? 0.03 : size === "R" ? 0.04 : 0.055;
  const on = size === "P" ? 0.04 : size === "R" ? 0.055 : 0.075;
  const cap = size === "P" ? 0.05 : size === "R" ? 0.07 : 0.095;
  return lines(
    "Pizza Dough",
    s.dough,
    "Tomato",
    s.sauce,
    "Mozzarella",
    s.moz,
    "Mushroom",
    mush,
    "Olives",
    oli,
    "Onion",
    on,
    "Capsicum",
    cap,
    "Oregano",
    s.oregano
  );
}

/**
 * @param {{ category: string; name: string }} m
 * @returns {RecipeLine[]}
 */
function recipeLinesFor(m) {
  const { category, name } = m;

  // ─── Burgers ───
  if (category === "Burgers") {
    if (name === "Classic Beef Burger") {
      return lines(
        "Burger Bun",
        1,
        "Beef Patty",
        1,
        "Lettuce",
        2,
        "Onion",
        0.02,
        "Pickles",
        0.012,
        "House Sauce",
        0.018
      );
    }
    if (name === "Cheese Beef Burger") {
      return lines(
        "Burger Bun",
        1,
        "Beef Patty",
        1,
        "Cheese",
        0.03,
        "Onion",
        0.025,
        "House Sauce",
        0.018
      );
    }
    if (name === "Double Cheese Beef Burger") {
      return lines(
        "Burger Bun",
        1,
        "Beef Patty",
        2,
        "Cheese",
        0.06,
        "Pickles",
        0.015,
        "House Sauce",
        0.02
      );
    }
    if (name === "Mushroom Swiss Beef Burger") {
      return lines(
        "Burger Bun",
        1,
        "Beef Patty",
        1,
        "Mushroom",
        0.07,
        "Swiss Cheese",
        0.032,
        "Mayonnaise",
        0.025
      );
    }
    if (name === "BBQ Beef Burger") {
      return lines(
        "Burger Bun",
        1,
        "Beef Patty",
        1,
        "BBQ Sauce",
        0.03,
        "Onion",
        0.1,
        "Breading Mix",
        0.04,
        "Cooking Oil",
        0.05,
        "Cheese",
        0.025,
        "Mayonnaise",
        0.015
      );
    }
    if (name === "Spicy Jalapeño Beef Burger") {
      return lines(
        "Burger Bun",
        1,
        "Beef Patty",
        1,
        "Pepper Jack Cheese",
        0.03,
        "Jalapeño",
        4,
        "Hot Sauce",
        0.018,
        "Mayonnaise",
        0.012,
        "Lettuce",
        2
      );
    }
  }

  // ─── Chicken Burgers ───
  if (category === "Chicken Burgers") {
    if (name === "Classic Crispy Chicken Burger") {
      return lines(
        "Burger Bun",
        1,
        "Chicken",
        1,
        "Lettuce",
        2,
        "Mayonnaise",
        0.02,
        "Pickles",
        0.012
      );
    }
    if (name === "Spicy Crispy Chicken Burger") {
      return lines(
        "Burger Bun",
        1,
        "Chicken",
        1,
        "Hot Sauce",
        0.02,
        "Jalapeño",
        3,
        "Cabbage (Slaw)",
        0.06
      );
    }
    if (name === "Chicken Cheese Burger") {
      return lines(
        "Burger Bun",
        1,
        "Chicken",
        1,
        "Cheese",
        0.03,
        "House Sauce",
        0.018,
        "Pickles",
        0.012
      );
    }
    if (name === "Grilled Chicken Burger") {
      return lines(
        "Burger Bun",
        1,
        "Chicken",
        1,
        "Lettuce",
        2,
        "Tomato",
        0.035,
        "Mayonnaise",
        0.018
      );
    }
    if (name === "Nashville Hot Chicken Burger") {
      return lines(
        "Burger Bun",
        1,
        "Chicken",
        1,
        "Hot Sauce",
        0.025,
        "Pickles",
        0.015,
        "Cabbage (Slaw)",
        0.07,
        "Mayonnaise",
        0.015
      );
    }
  }

  // ─── Pizza ───
  if (category === "Pizza") {
    if (name.startsWith("Margherita Pizza (Personal)")) return pizzaMargherita("P");
    if (name.startsWith("Margherita Pizza (Regular)")) return pizzaMargherita("R");
    if (name.startsWith("Margherita Pizza (Large)")) return pizzaMargherita("L");
    if (name.startsWith("Pepperoni Pizza (Personal)")) return pizzaPepperoni("P");
    if (name.startsWith("Pepperoni Pizza (Regular)")) return pizzaPepperoni("R");
    if (name.startsWith("Pepperoni Pizza (Large)")) return pizzaPepperoni("L");
    if (name.startsWith("BBQ Chicken Pizza (Personal)")) return pizzaBbqChicken("P");
    if (name.startsWith("BBQ Chicken Pizza (Regular)")) return pizzaBbqChicken("R");
    if (name.startsWith("BBQ Chicken Pizza (Large)")) return pizzaBbqChicken("L");
    if (name.startsWith("Fajita Pizza (Personal)")) return pizzaFajita("P");
    if (name.startsWith("Fajita Pizza (Regular)")) return pizzaFajita("R");
    if (name.startsWith("Fajita Pizza (Large)")) return pizzaFajita("L");
    if (name.startsWith("Veggie Supreme Pizza (Personal)")) return pizzaVeggie("P");
    if (name.startsWith("Veggie Supreme Pizza (Regular)")) return pizzaVeggie("R");
    if (name.startsWith("Veggie Supreme Pizza (Large)")) return pizzaVeggie("L");
  }

  // ─── Sandwiches & Subs ───
  if (category === "Sandwiches & Subs") {
    if (name === "Chicken Club Sandwich") {
      return lines(
        "Bread",
        2,
        "Chicken",
        1,
        "Egg",
        1,
        "Lettuce",
        2,
        "Tomato",
        0.04,
        "Mayonnaise",
        0.02
      );
    }
    if (name === "BBQ Chicken Sub (6 inch)") {
      return lines(
        "Sub Roll",
        1,
        "Chicken",
        1,
        "Cheese",
        0.04,
        "Onion",
        0.03,
        "Jalapeño",
        2,
        "BBQ Sauce",
        0.035
      );
    }
    if (name === "BBQ Chicken Sub (12 inch)") {
      return lines(
        "Sub Roll",
        2,
        "Chicken",
        2,
        "Cheese",
        0.08,
        "Onion",
        0.055,
        "Jalapeño",
        4,
        "BBQ Sauce",
        0.065
      );
    }
    if (name === "Beef Steak Sandwich") {
      return lines(
        "Bread",
        2,
        "Beef Steak Strips",
        0.18,
        "Onion",
        0.05,
        "Cheese",
        0.03,
        "House Sauce",
        0.022
      );
    }
  }

  // ─── Wraps ───
  if (category === "Wraps") {
    if (name === "Crispy Chicken Wrap") {
      return lines("Tortilla", 1, "Chicken", 1, "Lettuce", 2, "Mayonnaise", 0.018);
    }
    if (name === "Spicy Chicken Wrap") {
      return lines(
        "Tortilla",
        1,
        "Chicken",
        1,
        "Cabbage (Slaw)",
        0.07,
        "Jalapeño",
        3,
        "Hot Sauce",
        0.018
      );
    }
    if (name === "Grilled Chicken Wrap") {
      return lines(
        "Tortilla",
        1,
        "Chicken",
        1,
        "Capsicum",
        0.04,
        "Onion",
        0.03,
        "Mayonnaise",
        0.018
      );
    }
  }

  // ─── Fried Chicken ───
  if (category === "Fried Chicken") {
    if (name === "Fried Chicken (2 pcs)") {
      return lines("Chicken", 2, "Cooking Oil", 0.08, "Fry Seasoning", 0.012, "Breading Mix", 0.04);
    }
    if (name === "Fried Chicken (4 pcs)") {
      return lines("Chicken", 4, "Cooking Oil", 0.14, "Fry Seasoning", 0.022, "Breading Mix", 0.075);
    }
    if (name === "Fried Chicken (8 pcs)") {
      return lines("Chicken", 8, "Cooking Oil", 0.26, "Fry Seasoning", 0.04, "Breading Mix", 0.14);
    }
  }

  // ─── Wings ───
  if (category === "Wings") {
    if (name === "Baked Wings (6 pcs)") {
      return lines("Chicken Wings", 6, "Cooking Oil", 0.02, "Fry Seasoning", 0.012, "BBQ Sauce", 0.04);
    }
    if (name === "Baked Wings (12 pcs)") {
      return lines("Chicken Wings", 12, "Cooking Oil", 0.035, "Fry Seasoning", 0.022, "BBQ Sauce", 0.07);
    }
    if (name === "Crispy Fried Wings (6 pcs)") {
      return lines(
        "Chicken Wings",
        6,
        "Cooking Oil",
        0.09,
        "Breading Mix",
        0.05,
        "Fry Seasoning",
        0.015,
        "Hot Sauce",
        0.03
      );
    }
    if (name === "Crispy Fried Wings (12 pcs)") {
      return lines(
        "Chicken Wings",
        12,
        "Cooking Oil",
        0.16,
        "Breading Mix",
        0.09,
        "Fry Seasoning",
        0.028,
        "Hot Sauce",
        0.055
      );
    }
  }

  // ─── Sides ───
  if (category === "Sides") {
    if (name === "French Fries (Regular)") {
      return lines(
        "French Fries (Frozen)",
        0.18,
        "Cooking Oil",
        0.05,
        "Fry Seasoning",
        0.008
      );
    }
    if (name === "French Fries (Large)") {
      return lines(
        "French Fries (Frozen)",
        0.28,
        "Cooking Oil",
        0.07,
        "Fry Seasoning",
        0.012
      );
    }
    if (name === "Loaded Fries") {
      return lines(
        "French Fries (Frozen)",
        0.22,
        "Cheese Sauce (Prepared)",
        0.08,
        "Jalapeño",
        5,
        "Chicken",
        1,
        "Cooking Oil",
        0.04
      );
    }
    if (name === "Onion Rings") {
      return lines(
        "Onion",
        0.12,
        "Breading Mix",
        0.08,
        "Cooking Oil",
        0.07,
        "Fry Seasoning",
        0.008
      );
    }
    if (name === "Chicken Nuggets (6 pcs)") {
      return lines(
        "Chicken Nuggets (Frozen)",
        6,
        "Cooking Oil",
        0.06,
        "Breading Mix",
        0.04,
        "Fry Seasoning",
        0.008
      );
    }
    if (name === "Chicken Nuggets (12 pcs)") {
      return lines(
        "Chicken Nuggets (Frozen)",
        12,
        "Cooking Oil",
        0.11,
        "Breading Mix",
        0.075,
        "Fry Seasoning",
        0.014
      );
    }
    if (name === "Garlic Bread (4 pcs)") {
      return lines(
        "Bread",
        4,
        "Garlic",
        0.015,
        "Butter",
        0.04,
        "Dried Herbs",
        0.002
      );
    }
    if (name === "Mozzarella Sticks (6 pcs)") {
      return lines(
        "Mozzarella",
        0.14,
        "Breading Mix",
        0.06,
        "Cooking Oil",
        0.06,
        "Marinara Sauce",
        0.045
      );
    }
    if (name === "Coleslaw") {
      return lines("Cabbage (Slaw)", 0.15, "Mayonnaise", 0.04);
    }
  }

  // ─── Sauces & Dips (portion cup ~25–30g) ───
  if (category === "Sauces & Dips") {
    if (name === "Garlic Mayo Dip") return lines("Mayonnaise", 0.018, "Garlic", 0.004);
    if (name === "Spicy Mayo Dip") return lines("Mayonnaise", 0.02, "Hot Sauce", 0.008);
    if (name === "BBQ Dip") return lines("BBQ Sauce", 0.025);
    if (name === "Honey Mustard Dip") return lines("Mustard", 0.025);
    if (name === "Ranch Dip") return lines("Ranch Dressing", 0.025);
    if (name === "Hot Sauce Dip") return lines("Hot Sauce", 0.022);
    if (name === "Cheese Sauce Dip") return lines("Cheese Sauce (Prepared)", 0.028);
  }

  // ─── Salads ───
  if (category === "Salads") {
    if (name === "Chicken Caesar Salad") {
      return lines(
        "Lettuce",
        3,
        "Chicken",
        1,
        "Croutons",
        0.04,
        "Parmesan",
        0.02,
        "Caesar Dressing",
        0.045
      );
    }
    if (name === "Garden Salad") {
      return lines(
        "Mixed Salad Greens",
        0.28,
        "Olives",
        0.04,
        "Ranch Dressing",
        0.04
      );
    }
  }

  // ─── Desserts ───
  if (category === "Desserts") {
    if (name === "Chocolate Brownie") {
      return lines(
        "Brownie Mix",
        0.08,
        "Chocolate (Dessert)",
        0.025,
        "Cooking Oil",
        0.015
      );
    }
    if (name === "Molten Lava Cake") {
      return lines(
        "Cake Mix (Dessert)",
        0.1,
        "Chocolate (Dessert)",
        0.06,
        "Butter",
        0.04,
        "Cooking Oil",
        0.012
      );
    }
    if (name === "Cheesecake Slice") {
      return lines(
        "Cream Cheese",
        0.14,
        "Cookie Crumbs",
        0.04,
        "Sugar",
        0.025
      );
    }
    if (name === "Ice Cream Cup") {
      return lines("Ice Cream", 1, "Vanilla Syrup", 0.008);
    }
  }

  // ─── Beverages ───
  if (category === "Beverages") {
    if (name === "Mineral Water (500ml)") return lines("Mineral Water", 1);
    if (name === "Soft Drink (Can)") return lines("Soft Drink", 1);
    if (name === "Soft Drink (500ml)") return lines("Soft Drink", 1);
    if (name === "Fresh Lime") {
      return lines("Lime", 1, "Sugar", 0.05, "Water (Filtered)", 0.25);
    }
    if (name === "Mint Lemonade") {
      return lines(
        "Mint",
        5,
        "Lime",
        1,
        "Sugar",
        0.06,
        "Water (Filtered)",
        0.35
      );
    }
    if (name === "Iced Tea (Peach)") {
      return lines(
        "Iced Tea Base",
        0.28,
        "Peach Syrup",
        0.035,
        "Sugar",
        0.03
      );
    }
    if (name === "Iced Tea (Lemon)") {
      return lines(
        "Iced Tea Base",
        0.28,
        "Lemon Syrup",
        0.035,
        "Sugar",
        0.03
      );
    }
  }

  // ─── Shakes (~12–16 oz: milk + ice cream + flavor) ───
  if (category === "Shakes") {
    if (name === "Chocolate Shake") {
      return lines(
        "Milk",
        0.32,
        "Ice Cream",
        1,
        "Chocolate (Dessert)",
        0.055,
        "Sugar",
        0.035
      );
    }
    if (name === "Vanilla Shake") {
      return lines(
        "Milk",
        0.32,
        "Ice Cream",
        1,
        "Vanilla Syrup",
        0.045,
        "Sugar",
        0.03
      );
    }
    if (name === "Strawberry Shake") {
      return lines(
        "Milk",
        0.32,
        "Ice Cream",
        1,
        "Strawberry Syrup",
        0.045,
        "Sugar",
        0.03
      );
    }
    if (name === "Oreo Shake") {
      return lines(
        "Milk",
        0.32,
        "Ice Cream",
        1,
        "Cookie Crumbs",
        0.08,
        "Sugar",
        0.03
      );
    }
  }

  // ─── Coffee & Tea ───
  if (category === "Coffee & Tea") {
    if (name === "Espresso") return lines("Coffee Beans", 0.007);
    if (name === "Americano") {
      return lines("Coffee Beans", 0.007, "Water (Filtered)", 0.2);
    }
    if (name === "Cappuccino") {
      return lines("Coffee Beans", 0.007, "Milk", 0.15);
    }
    if (name === "Latte") {
      return lines("Coffee Beans", 0.007, "Milk", 0.22);
    }
    if (name === "Karak Chai") {
      return lines("Tea", 0.012, "Milk", 0.15, "Sugar", 0.03);
    }
  }

  return [];
}

function buildRecipes() {
  return MENU.map((m) => ({
    category: m.category,
    name: m.name,
    lines: recipeLinesFor(m),
  }));
}

module.exports = {
  MENU,
  buildRecipes,
  recipeLinesFor,
};
