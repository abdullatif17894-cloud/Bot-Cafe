// Claude tool definitions + execution for CafeBot.
// Menu data is the single source of truth for both tools.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getOrCreateSession, updateSession, resetSession } = require('./orderState');
const { readOrders, writeOrders } = require('./ordersStorage');

const MENU_PATH = path.join(__dirname, '..', 'data', 'menu.json');
const MENU_DATA = JSON.parse(fs.readFileSync(MENU_PATH, 'utf8'));

const PROMOTIONS_PATH = path.join(__dirname, '..', 'data', 'promotions.json');
const PROMOTIONS_DATA = JSON.parse(fs.readFileSync(PROMOTIONS_PATH, 'utf8'));

// Simple, flat tax rate + delivery fee config (see README.md notes).
const PRICING_PATH = path.join(__dirname, '..', 'data', 'pricing.json');
const PRICING_DATA = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));

// Orders are saved via ordersStorage.js — Upstash Redis on Vercel,
// data/orders.json locally. See ordersStorage.js for details.

const TOOLS = [
  {
    name: 'getMenu',
    description:
      "Get the café's current menu. Returns only active (available) items, " +
      'each with id, name, category, description, price, sizes, options, and allergens.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'addItemToCart',
    description:
      "Add one menu item to the customer's order. Validates the item, size, and options " +
      'against the real menu. If a required size is missing, or an invalid size/option is ' +
      'given, this tool does NOT add the item — it returns what is missing so you can ask ' +
      'the customer. Never guess a size or option on the customer\'s behalf.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: {
          type: 'string',
          description: 'The menu item id (from getMenu).',
        },
        quantity: {
          type: 'integer',
          minimum: 1,
          description: 'How many of this item to add. Defaults to 1 if omitted.',
        },
        size: {
          type: 'string',
          description: 'The chosen size. Required for items that have a "sizes" list.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Chosen add-ons/customizations for this item, if any.',
        },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'modifyItem',
    description:
      'Change the quantity, size, and/or options of an item already in the order. ' +
      'Identify the item with itemIndex — its 0-based position in the order (the item ' +
      'just added by addItemToCart is at index cartItemCount - 1 from that tool\'s result). ' +
      'Only include the fields that are changing; anything omitted stays the same. Changes ' +
      'are validated against the real menu the same way addItemToCart validates them — if a ' +
      'requested size or option is invalid, this tool does NOT apply the change and returns ' +
      'what is wrong so you can ask the customer instead of guessing.',
    input_schema: {
      type: 'object',
      properties: {
        itemIndex: {
          type: 'integer',
          minimum: 0,
          description: "0-based position of the item in the customer's current order.",
        },
        quantity: {
          type: 'integer',
          minimum: 1,
          description: 'New quantity, if changing it.',
        },
        size: {
          type: 'string',
          description: 'New size, if changing it. Must be one of the item\'s valid sizes.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'New full list of options, if changing them (replaces the existing list).',
        },
      },
      required: ['itemIndex'],
    },
  },
  {
    name: 'removeItem',
    description:
      "Remove an item from the customer's order, or reduce its quantity. Identify the item " +
      "with itemIndex — its 0-based position in the order. Omit quantity to remove the whole " +
      "item; provide quantity to remove only that many units (if it's less than the current " +
      "quantity, the item stays with the remainder). Note: removing an item shifts the " +
      "itemIndex of every item after it down by one — re-check indices from the latest tool " +
      "result before making another change.",
    input_schema: {
      type: 'object',
      properties: {
        itemIndex: {
          type: 'integer',
          minimum: 0,
          description: "0-based position of the item in the customer's current order.",
        },
        quantity: {
          type: 'integer',
          minimum: 1,
          description: 'How many units to remove. Omit to remove the entire item.',
        },
      },
      required: ['itemIndex'],
    },
  },
  {
    name: 'viewCart',
    description:
      "Get a concise, itemized summary of the customer's current order — each item's name, " +
      'quantity, size, and options. Does not include prices or totals. Use this when the ' +
      'customer asks what is in their order/cart, or before confirming changes.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'recommendItems',
    description:
      "Suggest up to 2 relevant, real menu items that pair well with what's already in the " +
      "customer's order (for example, a pastry alongside a coffee, or a drink alongside food). " +
      'Only returns real items from the menu that are available, not already in the cart, and ' +
      "not previously declined by the customer this session. Returns an empty list if there's " +
      'nothing in the order yet, or nothing left to relevantly suggest — in that case, do not ' +
      'offer a recommendation. Never mention or suggest any item this tool does not return.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'declineRecommendation',
    description:
      'Record that the customer declined one or more previously suggested items, so those ' +
      'items are not suggested again this session. Call this as soon as the customer says no ' +
      'thanks, or otherwise indicates they are not interested in a recommendation you just made.',
    input_schema: {
      type: 'object',
      properties: {
        itemIds: {
          type: 'array',
          items: { type: 'string' },
          description: "The menu item id(s) the customer declined, from the recommendation you just offered.",
        },
      },
      required: ['itemIds'],
    },
  },
  {
    name: 'applyPromotion',
    description:
      "Check or apply real, currently active promotions from the café's promotions data. Call " +
      'with no promotionId to see which active promotions currently qualify for the order ' +
      '(based on category, minimum order value, day, and time) — these are suggestions only, ' +
      'not yet applied. Call again with a specific promotionId to apply it, but only once the ' +
      "customer agrees; this tool re-checks that the promotion is real, active, and its " +
      'eligibility rules are still satisfied, and rejects it with a reason otherwise. Never ' +
      'apply, mention, or accept a discount code that is not in the promotions data — CafeBot ' +
      'must not invent or honor unrecognized codes.',
    input_schema: {
      type: 'object',
      properties: {
        promotionId: {
          type: 'string',
          description:
            'The id of a specific promotion to apply (from a prior check). Omit to see which ' +
            'active promotions currently qualify.',
        },
      },
    },
  },
  {
    name: 'setPickupDetails',
    description:
      "Collect or check the customer's pickup details before checkout: their name (required) " +
      'and an optional pickup time. Call with no arguments first to see what is already known ' +
      "and what is still missing — only ask the customer for fields the tool reports as " +
      'missing, never re-ask for something already on file. Call again with name and/or ' +
      'pickupTime once the customer provides them; each call only updates the fields you send, ' +
      'so partial updates are fine.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "Customer's name for the pickup order.",
        },
        pickupTime: {
          type: 'string',
          description:
            'Requested pickup time, if the customer gives one (e.g. "5:30pm", "in 20 minutes"). ' +
            'Always optional — never ask twice or push for one if the customer has no preference.',
        },
      },
    },
  },
  {
    name: 'setDeliveryDetails',
    description:
      "Collect or check the customer's delivery details before checkout: name, phone number, " +
      'and full delivery address (all required), plus apartment/unit number and delivery ' +
      'instructions (both optional, only if applicable). Call with no arguments first to see ' +
      'what is already known and what is still missing — only ask the customer for fields the ' +
      'tool reports as missing, and never guess or invent any of these on their behalf. Call ' +
      'again with whichever fields the customer provides; each call only updates the fields you ' +
      'send, so partial updates are fine.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "Customer's name for the delivery order.",
        },
        phone: {
          type: 'string',
          description: "Customer's phone number, for delivery contact.",
        },
        address: {
          type: 'string',
          description: 'Full delivery street address.',
        },
        apartmentUnit: {
          type: 'string',
          description: 'Apartment or unit number, if applicable. Optional.',
        },
        deliveryInstructions: {
          type: 'string',
          description:
            'Delivery instructions, e.g. a gate code or where to leave the order. Optional.',
        },
      },
    },
  },
  {
    name: 'calculateOrderTotal',
    description:
      "Compute the customer's order total — deterministically, from real menu prices and " +
      'quantities in the cart, any currently valid active promotion, tax, and (for delivery ' +
      'orders) the delivery fee. Never estimate, calculate, or state a total yourself — always ' +
      'call this tool and quote its numbers exactly. Call it whenever the customer asks for ' +
      'their total or a price breakdown, and before presenting the order for final confirmation.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'getOrderSummary',
    description:
      'Generate a complete, structured order summary before checkout: items with quantities ' +
      'and customizations, fulfillment details (pickup or delivery, with everything collected ' +
      'so far), any currently valid promotion, and the full price breakdown and total — all ' +
      'pulled directly from real order state, never invented. Also reports what is still ' +
      "missing before checkout can proceed (via missingForCheckout). Use this to present the " +
      'final summary and ask the customer to confirm before finalizing.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'finalizeOrder',
    description:
      "Finalize and save the customer's order — but ONLY after you have presented the full " +
      'summary (via getOrderSummary) and the customer has explicitly confirmed it. Pass ' +
      'confirmed: true and customerReply with the exact words the customer used; this tool ' +
      'independently checks that reply for a clear, unambiguous confirmation and refuses to ' +
      'finalize on anything hesitant, vague, a question, or a no — even if you believe it was a ' +
      'yes. It also refuses if any required information is still missing. Never call this ' +
      'before presenting the summary and asking for confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        confirmed: {
          type: 'boolean',
          description:
            'Set to true only when you judge the customer explicitly confirmed the order. ' +
            'This tool double-checks customerReply regardless of this value.',
        },
        customerReply: {
          type: 'string',
          description:
            "The customer's exact words in response to the final summary and confirmation " +
            'question — not your paraphrase of it.',
        },
      },
      required: ['confirmed', 'customerReply'],
    },
  },
  {
    name: 'confirmDeliveryAddress',
    description:
      'Record that the customer has explicitly confirmed the full delivery address is correct, ' +
      'after you have read it back to them (street address plus apartment/unit, if any) using ' +
      "the exact values from setDeliveryDetails's result — never from memory or a guess. Only " +
      'call this after the customer clearly says the address is correct. If they give a ' +
      'correction instead, do not call this — call setDeliveryDetails with the corrected value(s) ' +
      'instead, then read the address back again and ask for confirmation once more.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

function getMenuTool() {
  return MENU_DATA.items.filter((item) => item.available);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function addItemToCartTool(input, sessionId) {
  const { itemId, quantity, size, options } = input || {};

  const menuItem = MENU_DATA.items.find((item) => item.id === itemId);
  if (!menuItem) {
    return { success: false, error: `No menu item found with id "${itemId}".` };
  }
  if (!menuItem.available) {
    return { success: false, error: `${menuItem.name} is currently unavailable.` };
  }

  // Size is required whenever the item defines sizes — never assume one.
  if (menuItem.sizes && menuItem.sizes.length > 0) {
    if (!size || !menuItem.sizes.includes(size)) {
      return {
        success: false,
        needsInput: 'size',
        validSizes: menuItem.sizes,
        message: `A size is required for ${menuItem.name}. Ask the customer to choose from: ${menuItem.sizes.join(', ')}.`,
      };
    }
  }

  // Options are optional, but anything provided must be a real option for this item.
  const providedOptions = Array.isArray(options) ? options : [];
  const invalidOptions = providedOptions.filter((opt) => !menuItem.options.includes(opt));
  if (invalidOptions.length > 0) {
    return {
      success: false,
      needsInput: 'options',
      validOptions: menuItem.options,
      message:
        `"${invalidOptions.join(', ')}" ${invalidOptions.length > 1 ? 'are' : 'is'} not a valid ` +
        `option for ${menuItem.name}. Valid options: ${menuItem.options.length ? menuItem.options.join(', ') : 'none'}.`,
    };
  }

  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
    return { success: false, error: 'quantity must be a whole number of 1 or more.' };
  }
  const qty = quantity === undefined ? 1 : quantity;
  const unitPrice = menuItem.price;
  const lineTotal = round2(unitPrice * qty);

  const lineItem = {
    itemId: menuItem.id,
    name: menuItem.name,
    quantity: qty,
    size: size || null,
    options: providedOptions,
    unitPrice,
    lineTotal,
  };

  const order = getOrCreateSession(sessionId);
  const updatedItems = [...order.items, lineItem];
  const newTotal = round2(updatedItems.reduce((sum, li) => sum + li.lineTotal, 0));
  const updatedOrder = updateSession(sessionId, { items: updatedItems, total: newTotal });

  return {
    success: true,
    addedItem: lineItem,
    cartItemCount: updatedOrder.items.length,
    orderTotal: updatedOrder.total,
  };
}

function modifyItemTool(input, sessionId) {
  const { itemIndex, quantity, size, options } = input || {};

  if (!Number.isInteger(itemIndex) || itemIndex < 0) {
    return { success: false, error: 'itemIndex must be a valid position in the order.' };
  }

  const order = getOrCreateSession(sessionId);
  const existingItem = order.items[itemIndex];
  if (!existingItem) {
    return {
      success: false,
      error: `There is no item at position ${itemIndex} in the current order (order has ${order.items.length} item(s)).`,
    };
  }

  const menuItem = MENU_DATA.items.find((item) => item.id === existingItem.itemId);
  if (!menuItem) {
    return { success: false, error: `Could not find menu data for "${existingItem.itemId}".` };
  }

  if (quantity === undefined && size === undefined && options === undefined) {
    return { success: false, error: 'No changes specified. Provide a new quantity, size, or options.' };
  }

  // Validate size, if a change was requested.
  let nextSize = existingItem.size;
  if (size !== undefined) {
    if (!menuItem.sizes || menuItem.sizes.length === 0) {
      return { success: false, error: `${menuItem.name} does not have size options.` };
    }
    if (!menuItem.sizes.includes(size)) {
      return {
        success: false,
        needsInput: 'size',
        validSizes: menuItem.sizes,
        message: `"${size}" is not a valid size for ${menuItem.name}. Ask the customer to choose from: ${menuItem.sizes.join(', ')}.`,
      };
    }
    nextSize = size;
  }

  // Validate options, if a change was requested.
  let nextOptions = existingItem.options;
  if (options !== undefined) {
    const providedOptions = Array.isArray(options) ? options : [];
    const invalidOptions = providedOptions.filter((opt) => !menuItem.options.includes(opt));
    if (invalidOptions.length > 0) {
      return {
        success: false,
        needsInput: 'options',
        validOptions: menuItem.options,
        message:
          `"${invalidOptions.join(', ')}" ${invalidOptions.length > 1 ? 'are' : 'is'} not a valid ` +
          `option for ${menuItem.name}. Valid options: ${menuItem.options.length ? menuItem.options.join(', ') : 'none'}.`,
      };
    }
    nextOptions = providedOptions;
  }

  // Validate quantity, if a change was requested.
  let nextQuantity = existingItem.quantity;
  if (quantity !== undefined) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { success: false, error: 'quantity must be a whole number of 1 or more.' };
    }
    nextQuantity = quantity;
  }

  const updatedItem = {
    ...existingItem,
    quantity: nextQuantity,
    size: nextSize,
    options: nextOptions,
    lineTotal: round2(existingItem.unitPrice * nextQuantity),
  };

  const updatedItems = order.items.map((item, idx) => (idx === itemIndex ? updatedItem : item));
  const newTotal = round2(updatedItems.reduce((sum, li) => sum + li.lineTotal, 0));
  const updatedOrder = updateSession(sessionId, { items: updatedItems, total: newTotal });

  return {
    success: true,
    updatedItem,
    itemIndex,
    cartItemCount: updatedOrder.items.length,
    orderTotal: updatedOrder.total,
  };
}

function removeItemTool(input, sessionId) {
  const { itemIndex, quantity } = input || {};

  if (!Number.isInteger(itemIndex) || itemIndex < 0) {
    return { success: false, error: 'itemIndex must be a valid position in the order.' };
  }

  const order = getOrCreateSession(sessionId);
  const existingItem = order.items[itemIndex];
  if (!existingItem) {
    return {
      success: false,
      error: `There is no item at position ${itemIndex} in the current order (order has ${order.items.length} item(s)).`,
    };
  }

  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
    return { success: false, error: 'quantity must be a whole number of 1 or more.' };
  }

  const qtyToRemove = quantity === undefined ? existingItem.quantity : quantity;

  if (qtyToRemove >= existingItem.quantity) {
    // Remove the whole line item.
    const updatedItems = order.items.filter((_, idx) => idx !== itemIndex);
    const newTotal = round2(updatedItems.reduce((sum, li) => sum + li.lineTotal, 0));
    const updatedOrder = updateSession(sessionId, { items: updatedItems, total: newTotal });

    return {
      success: true,
      action: 'removed',
      removedItem: {
        itemId: existingItem.itemId,
        name: existingItem.name,
        quantity: existingItem.quantity,
        size: existingItem.size,
        options: existingItem.options,
      },
      cartItemCount: updatedOrder.items.length,
      orderTotal: updatedOrder.total,
    };
  }

  // Reduce the quantity, keep the line item.
  const remainingQuantity = existingItem.quantity - qtyToRemove;
  const updatedItem = {
    ...existingItem,
    quantity: remainingQuantity,
    lineTotal: round2(existingItem.unitPrice * remainingQuantity),
  };
  const updatedItems = order.items.map((item, idx) => (idx === itemIndex ? updatedItem : item));
  const newTotal = round2(updatedItems.reduce((sum, li) => sum + li.lineTotal, 0));
  const updatedOrder = updateSession(sessionId, { items: updatedItems, total: newTotal });

  return {
    success: true,
    action: 'reduced',
    updatedItem,
    quantityRemoved: qtyToRemove,
    itemIndex,
    cartItemCount: updatedOrder.items.length,
    orderTotal: updatedOrder.total,
  };
}

function viewCartTool(sessionId) {
  const order = getOrCreateSession(sessionId);

  const items = order.items.map((item, itemIndex) => ({
    itemIndex,
    itemId: item.itemId,
    name: item.name,
    quantity: item.quantity,
    size: item.size,
    options: item.options,
  }));

  return {
    success: true,
    itemCount: items.length,
    items,
  };
}

// Simple category-based relevance heuristic: a coffee/tea drink pairs well
// with a pastry/food item and vice versa. Used only to rank real menu items
// — never to invent one.
const CATEGORY_COMPLEMENTS = {
  Coffee: ['Pastries', 'Food'],
  Tea: ['Pastries', 'Food'],
  Pastries: ['Coffee', 'Tea'],
  Food: ['Coffee', 'Tea'],
};

function recommendItemsTool(sessionId) {
  const order = getOrCreateSession(sessionId);

  if (order.items.length === 0) {
    return {
      success: true,
      recommendations: [],
      message: 'No items in the order yet — nothing to base a recommendation on.',
    };
  }

  const cartItemIds = new Set(order.items.map((li) => li.itemId));
  const declinedIds = new Set((order.recommendations && order.recommendations.declined) || []);

  const cartCategories = new Set(
    order.items
      .map((li) => {
        const menuItem = MENU_DATA.items.find((item) => item.id === li.itemId);
        return menuItem ? menuItem.category : null;
      })
      .filter(Boolean)
  );

  const candidates = MENU_DATA.items.filter(
    (item) => item.available && !cartItemIds.has(item.id) && !declinedIds.has(item.id)
  );

  const complementaryCategories = new Set();
  cartCategories.forEach((cat) => {
    (CATEGORY_COMPLEMENTS[cat] || []).forEach((c) => complementaryCategories.add(c));
  });

  const complementary = candidates.filter((item) => complementaryCategories.has(item.category));
  const fallback = candidates.filter((item) => !complementaryCategories.has(item.category));
  const picked = [...complementary, ...fallback].slice(0, 2);

  return {
    success: true,
    recommendations: picked.map((item) => ({
      itemId: item.id,
      name: item.name,
      category: item.category,
      description: item.description,
      price: item.price,
    })),
  };
}

function declineRecommendationTool(input, sessionId) {
  const { itemIds } = input || {};
  const providedIds = Array.isArray(itemIds) ? itemIds : [];

  if (providedIds.length === 0) {
    return { success: false, error: 'itemIds is required and must be a non-empty array.' };
  }

  const validIds = providedIds.filter((id) => MENU_DATA.items.some((item) => item.id === id));
  if (validIds.length === 0) {
    return { success: false, error: 'None of the provided itemIds match a real menu item.' };
  }

  const order = getOrCreateSession(sessionId);
  const existingDeclined = (order.recommendations && order.recommendations.declined) || [];
  const mergedDeclined = Array.from(new Set([...existingDeclined, ...validIds]));

  const updatedOrder = updateSession(sessionId, {
    recommendations: { declined: mergedDeclined },
  });

  return {
    success: true,
    declinedItemIds: validIds,
    allDeclined: updatedOrder.recommendations.declined,
  };
}

// Checks a promotion's day/time window against the given moment. Uses the
// server's local time zone (this app has no per-customer time zone data).
function isPromotionTimeEligible(promotion, now) {
  const eligibility = promotion.eligibility || {};

  if (Array.isArray(eligibility.validDays) && eligibility.validDays.length > 0) {
    const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
    if (!eligibility.validDays.includes(dayName)) {
      return {
        eligible: false,
        reason: `${promotion.name} is only valid on ${eligibility.validDays.join(', ')}.`,
      };
    }
  }

  if (eligibility.validHours) {
    const [startStr, endStr] = eligibility.validHours.split('-');
    const toMinutes = (hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (nowMinutes < toMinutes(startStr) || nowMinutes >= toMinutes(endStr)) {
      return {
        eligible: false,
        reason: `${promotion.name} is only valid between ${eligibility.validHours}.`,
      };
    }
  }

  return { eligible: true };
}

// Evaluates whether a promotion currently qualifies for this order, and if
// so, how much it discounts. Only ever reasons about real promotions.json
// entries — never invents a promotion or a discount amount.
function evaluatePromotion(promotion, order) {
  if (!promotion.active) {
    return { eligible: false, reason: `${promotion.name} is not currently active.` };
  }

  const eligibility = promotion.eligibility || {};

  if (eligibility.requiresVerification) {
    return {
      eligible: false,
      reason:
        `${promotion.name} requires ${eligibility.requiresVerification} verification in ` +
        'person — CafeBot cannot apply it through chat.',
    };
  }

  const timeCheck = isPromotionTimeEligible(promotion, new Date());
  if (!timeCheck.eligible) {
    return timeCheck;
  }

  const categories = Array.isArray(eligibility.appliesToCategories) ? eligibility.appliesToCategories : [];
  const qualifyingItems = order.items.filter((li) => {
    const menuItem = MENU_DATA.items.find((item) => item.id === li.itemId);
    return menuItem && categories.includes(menuItem.category);
  });

  if (categories.length > 0 && qualifyingItems.length === 0) {
    return {
      eligible: false,
      reason: `${promotion.name} applies to ${categories.join('/')} items, and there are none in the current order.`,
    };
  }

  if (eligibility.minOrderValue != null && order.total < eligibility.minOrderValue) {
    return {
      eligible: false,
      reason: `${promotion.name} requires a minimum order of $${eligibility.minOrderValue.toFixed(2)}.`,
    };
  }

  let discountAmount = 0;
  if (promotion.discountType === 'percentage') {
    const eligibleSubtotal = round2(qualifyingItems.reduce((sum, li) => sum + li.lineTotal, 0));
    discountAmount = round2(eligibleSubtotal * (promotion.discountValue / 100));
  } else if (promotion.discountType === 'buy_one_get_one') {
    const units = [];
    qualifyingItems.forEach((li) => {
      for (let i = 0; i < li.quantity; i++) {
        units.push(li.unitPrice);
      }
    });
    units.sort((a, b) => b - a);
    let freeValue = 0;
    for (let i = 1; i < units.length; i += 2) {
      freeValue += units[i] * (promotion.discountValue / 100);
    }
    discountAmount = round2(freeValue);
  } else {
    return { eligible: false, reason: `${promotion.name} uses an unsupported discount type.` };
  }

  if (discountAmount <= 0) {
    return {
      eligible: false,
      reason: `${promotion.name} doesn't currently discount anything in this order (for a BOGO deal, at least two qualifying items are needed).`,
    };
  }

  return { eligible: true, discountAmount, qualifyingItemCount: qualifyingItems.length };
}

function applyPromotionTool(input, sessionId) {
  const { promotionId } = input || {};
  const order = getOrCreateSession(sessionId);

  if (promotionId !== undefined) {
    if (typeof promotionId !== 'string' || !promotionId.trim()) {
      return { success: false, error: 'promotionId must be a non-empty string.' };
    }

    const promotion = PROMOTIONS_DATA.promotions.find((p) => p.id === promotionId);
    if (!promotion) {
      return {
        success: false,
        error: `"${promotionId}" is not a recognized promotion. CafeBot cannot apply a discount code that isn't in the café's real promotions.`,
      };
    }

    const evaluation = evaluatePromotion(promotion, order);
    if (!evaluation.eligible) {
      return { success: false, promotionId: promotion.id, name: promotion.name, reason: evaluation.reason };
    }

    const updatedOrder = updateSession(sessionId, {
      discount: { promotionId: promotion.id, amount: evaluation.discountAmount },
    });

    return {
      success: true,
      applied: {
        promotionId: promotion.id,
        name: promotion.name,
        discountAmount: evaluation.discountAmount,
      },
      orderTotal: updatedOrder.total,
      discountedTotal: round2(updatedOrder.total - evaluation.discountAmount),
    };
  }

  // No promotionId given: report which active promotions currently qualify,
  // as suggestions only — nothing is applied.
  const eligiblePromotions = PROMOTIONS_DATA.promotions
    .filter((p) => p.active)
    .map((p) => ({ promotion: p, evaluation: evaluatePromotion(p, order) }))
    .filter((r) => r.evaluation.eligible)
    .map((r) => ({
      promotionId: r.promotion.id,
      name: r.promotion.name,
      rule: r.promotion.rule,
      estimatedDiscount: r.evaluation.discountAmount,
    }));

  return {
    success: true,
    eligiblePromotions,
    message:
      eligiblePromotions.length > 0
        ? 'These active promotions currently qualify — offer them to the customer, do not apply automatically.'
        : 'No active promotions currently qualify for this order.',
  };
}

// Deterministic order total: real item prices/quantities (order.total, kept
// in sync by the cart tools) plus a fresh re-check of any applied promotion
// (never trusting a stale stored amount — the cart may have changed since it
// was applied) plus the simple flat tax rate and delivery fee. The language
// model never computes any of this itself; it only ever reports these
// numbers back to the customer.
function calculateOrderTotalTool(sessionId) {
  const order = getOrCreateSession(sessionId);

  const subtotal = round2(order.total);

  let discountAmount = 0;
  let appliedPromotion = null;
  if (order.discount && order.discount.promotionId) {
    const promotion = PROMOTIONS_DATA.promotions.find((p) => p.id === order.discount.promotionId);
    const evaluation = promotion ? evaluatePromotion(promotion, order) : { eligible: false };
    if (promotion && evaluation.eligible) {
      discountAmount = evaluation.discountAmount;
      appliedPromotion = { promotionId: promotion.id, name: promotion.name };
    }
  }

  const discountedSubtotal = round2(Math.max(subtotal - discountAmount, 0));
  const taxRate = PRICING_DATA.taxRate;
  const tax = round2(discountedSubtotal * taxRate);
  const deliveryFee = order.orderType === 'delivery' ? round2(PRICING_DATA.deliveryFee) : 0;
  const grandTotal = round2(discountedSubtotal + tax + deliveryFee);

  return {
    success: true,
    itemCount: order.items.length,
    subtotal,
    appliedPromotion,
    discountAmount,
    taxRate,
    tax,
    orderType: order.orderType,
    deliveryFee,
    grandTotal,
  };
}

function setPickupDetailsTool(input, sessionId) {
  const { name, pickupTime } = input || {};

  const hasNameUpdate = name !== undefined;
  const hasTimeUpdate = pickupTime !== undefined;

  if (hasNameUpdate && (typeof name !== 'string' || !name.trim())) {
    return { success: false, error: 'name must be a non-empty string.' };
  }
  if (hasTimeUpdate && (typeof pickupTime !== 'string' || !pickupTime.trim())) {
    return { success: false, error: 'pickupTime must be a non-empty string, or omit it entirely.' };
  }

  let order = getOrCreateSession(sessionId);

  if (hasNameUpdate || hasTimeUpdate) {
    const updates = { orderType: 'pickup' };
    if (hasNameUpdate) {
      updates.customer = { ...order.customer, name: name.trim() };
    }
    if (hasTimeUpdate) {
      updates.pickupTime = pickupTime.trim();
    }
    order = updateSession(sessionId, updates);
  }

  const missing = [];
  if (!order.customer.name) {
    missing.push('name');
  }

  return {
    success: true,
    orderType: order.orderType,
    name: order.customer.name,
    pickupTime: order.pickupTime,
    missing,
    readyForCheckout: missing.length === 0,
  };
}

function setDeliveryDetailsTool(input, sessionId) {
  const { name, phone, address, apartmentUnit, deliveryInstructions } = input || {};

  const fieldsToValidate = { name, phone, address, apartmentUnit, deliveryInstructions };
  for (const [key, value] of Object.entries(fieldsToValidate)) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      return { success: false, error: `${key} must be a non-empty string, or omit it entirely.` };
    }
  }

  let order = getOrCreateSession(sessionId);

  const hasAnyUpdate = [name, phone, address, apartmentUnit, deliveryInstructions].some(
    (v) => v !== undefined
  );

  if (hasAnyUpdate) {
    const updates = { orderType: 'delivery' };

    if (name !== undefined || phone !== undefined) {
      updates.customer = {
        ...order.customer,
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(phone !== undefined ? { phone: phone.trim() } : {}),
      };
    }

    if (address !== undefined || apartmentUnit !== undefined || deliveryInstructions !== undefined) {
      // Changing the address or apartment/unit invalidates any prior
      // readback confirmation — it must be re-confirmed with the new value.
      const addressChanged = address !== undefined || apartmentUnit !== undefined;
      updates.delivery = {
        ...order.delivery,
        ...(address !== undefined ? { address: address.trim() } : {}),
        ...(apartmentUnit !== undefined ? { apartmentUnit: apartmentUnit.trim() } : {}),
        ...(deliveryInstructions !== undefined ? { instructions: deliveryInstructions.trim() } : {}),
        ...(addressChanged ? { addressConfirmed: false } : {}),
      };
    }

    order = updateSession(sessionId, updates);
  }

  const missing = [];
  if (!order.customer.name) missing.push('name');
  if (!order.customer.phone) missing.push('phone');
  if (!order.delivery.address) missing.push('address');

  return {
    success: true,
    orderType: order.orderType,
    name: order.customer.name,
    phone: order.customer.phone,
    address: order.delivery.address,
    apartmentUnit: order.delivery.apartmentUnit,
    deliveryInstructions: order.delivery.instructions,
    addressConfirmed: order.delivery.addressConfirmed,
    missing,
    readyForCheckout: missing.length === 0 && order.delivery.addressConfirmed === true,
  };
}

function confirmDeliveryAddressTool(sessionId) {
  const order = getOrCreateSession(sessionId);

  if (!order.delivery.address) {
    return {
      success: false,
      error: 'There is no delivery address on file yet — collect one with setDeliveryDetails first.',
    };
  }

  const updatedOrder = updateSession(sessionId, {
    delivery: { ...order.delivery, addressConfirmed: true },
  });

  return {
    success: true,
    address: updatedOrder.delivery.address,
    apartmentUnit: updatedOrder.delivery.apartmentUnit,
    addressConfirmed: true,
  };
}

// Composes the existing, already-deterministic tools (viewCart,
// calculateOrderTotal, and the status-check mode of setPickupDetails /
// setDeliveryDetails) into one structured summary. Nothing here recomputes
// business logic on its own, so there is no risk of drifting from the
// numbers those tools report elsewhere.
function getOrderSummaryTool(sessionId) {
  const order = getOrCreateSession(sessionId);
  const cart = viewCartTool(sessionId);
  const totals = calculateOrderTotalTool(sessionId);

  const missingForCheckout = [];
  if (cart.itemCount === 0) {
    missingForCheckout.push('items');
  }

  let fulfillment = { type: order.orderType };

  if (order.orderType === 'pickup') {
    const pickupStatus = setPickupDetailsTool({}, sessionId);
    fulfillment = {
      type: 'pickup',
      name: pickupStatus.name,
      pickupTime: pickupStatus.pickupTime,
    };
    missingForCheckout.push(...pickupStatus.missing);
  } else if (order.orderType === 'delivery') {
    const deliveryStatus = setDeliveryDetailsTool({}, sessionId);
    fulfillment = {
      type: 'delivery',
      name: deliveryStatus.name,
      phone: deliveryStatus.phone,
      address: deliveryStatus.address,
      apartmentUnit: deliveryStatus.apartmentUnit,
      deliveryInstructions: deliveryStatus.deliveryInstructions,
      addressConfirmed: deliveryStatus.addressConfirmed,
    };
    missingForCheckout.push(...deliveryStatus.missing);
    if (deliveryStatus.address && !deliveryStatus.addressConfirmed) {
      missingForCheckout.push('addressConfirmation');
    }
  } else {
    missingForCheckout.push('orderType');
  }

  return {
    success: true,
    items: cart.items,
    itemCount: cart.itemCount,
    fulfillment,
    promotion: totals.appliedPromotion,
    pricing: {
      subtotal: totals.subtotal,
      discountAmount: totals.discountAmount,
      taxRate: totals.taxRate,
      tax: totals.tax,
      deliveryFee: totals.deliveryFee,
      grandTotal: totals.grandTotal,
    },
    missingForCheckout,
    readyForCheckout: missingForCheckout.length === 0,
  };
}

// Deterministic backstop against ambiguous "confirmations". The model is
// asked to only pass confirmed: true when it judges the reply affirmative,
// but this classifier independently re-checks the customer's literal words
// so a hedging, unclear, or negative reply can never slip through — even if
// the model got it wrong.
function classifyConfirmationReply(reply) {
  const normalized = reply.trim().toLowerCase().replace(/[!.]+$/g, '');

  if (!normalized) {
    return { affirmative: false, reason: 'An empty reply is not a confirmation.' };
  }
  if (normalized.endsWith('?')) {
    return { affirmative: false, reason: 'A question is not a confirmation.' };
  }

  const hasWord = (word) => new RegExp(`\\b${word}\\b`).test(normalized);

  const negativeWords = [
    'no', 'maybe', 'possibly', 'perhaps', 'hmm', 'idk', 'later', 'wait', 'stop', 'cancel', 'not',
  ];
  const negativePhrases = [
    'i guess', 'not sure', 'i think so', "i don't know", 'we will see', 'let me think',
    'not now', 'not yet', 'do not', 'hold on', "don't",
  ];

  if (negativeWords.some(hasWord) || negativePhrases.some((p) => normalized.includes(p))) {
    return {
      affirmative: false,
      reason: 'This reply reads as hesitant, ambiguous, or negative — not an explicit confirmation.',
    };
  }

  const affirmativeWords = ['yes', 'yep', 'yup', 'yeah', 'confirm', 'confirmed', 'correct', 'right', 'proceed'];
  const affirmativePhrases = [
    'place the order', 'place my order', 'place it', 'go ahead', 'looks good', 'sounds good',
    "that's right", 'that is right', "that's correct", 'that is correct',
  ];

  if (affirmativeWords.some(hasWord) || affirmativePhrases.some((p) => normalized.includes(p))) {
    return { affirmative: true };
  }

  return {
    affirmative: false,
    reason:
      'This reply does not clearly match an explicit confirmation — ask the customer to say ' +
      'yes/confirm, or to say what needs to change.',
  };
}

async function finalizeOrderTool(input, sessionId) {
  const { confirmed, customerReply } = input || {};

  if (confirmed !== true) {
    return {
      success: false,
      finalized: false,
      error: 'Order not finalized: confirmed must be explicitly true, only after the customer clearly confirms.',
    };
  }

  if (typeof customerReply !== 'string' || !customerReply.trim()) {
    return {
      success: false,
      finalized: false,
      error: 'customerReply is required — the literal words the customer used to confirm.',
    };
  }

  const classification = classifyConfirmationReply(customerReply);
  if (!classification.affirmative) {
    return { success: false, finalized: false, error: classification.reason };
  }

  const summary = getOrderSummaryTool(sessionId);
  if (!summary.readyForCheckout) {
    return {
      success: false,
      finalized: false,
      error: 'Order cannot be finalized yet — information is still missing.',
      missingForCheckout: summary.missingForCheckout,
    };
  }

  const orderId = crypto.randomUUID();
  const confirmedAt = new Date().toISOString();
  const savedOrder = {
    orderId,
    status: 'NEW',
    confirmedAt,
    sessionId,
    items: summary.items,
    fulfillment: summary.fulfillment,
    promotion: summary.promotion,
    pricing: summary.pricing,
  };

  const existingOrders = await readOrders();
  existingOrders.push(savedOrder);
  await writeOrders(existingOrders);

  // The order is saved; this session is free to start a new one.
  resetSession(sessionId);

  return { success: true, finalized: true, orderId, confirmedAt, savedOrder };
}

async function executeTool(toolName, toolInput, sessionId) {
  if (toolName === 'getMenu') {
    return getMenuTool();
  }
  if (toolName === 'addItemToCart') {
    return addItemToCartTool(toolInput, sessionId);
  }
  if (toolName === 'modifyItem') {
    return modifyItemTool(toolInput, sessionId);
  }
  if (toolName === 'removeItem') {
    return removeItemTool(toolInput, sessionId);
  }
  if (toolName === 'viewCart') {
    return viewCartTool(sessionId);
  }
  if (toolName === 'recommendItems') {
    return recommendItemsTool(sessionId);
  }
  if (toolName === 'declineRecommendation') {
    return declineRecommendationTool(toolInput, sessionId);
  }
  if (toolName === 'applyPromotion') {
    return applyPromotionTool(toolInput, sessionId);
  }
  if (toolName === 'setPickupDetails') {
    return setPickupDetailsTool(toolInput, sessionId);
  }
  if (toolName === 'setDeliveryDetails') {
    return setDeliveryDetailsTool(toolInput, sessionId);
  }
  if (toolName === 'confirmDeliveryAddress') {
    return confirmDeliveryAddressTool(sessionId);
  }
  if (toolName === 'calculateOrderTotal') {
    return calculateOrderTotalTool(sessionId);
  }
  if (toolName === 'getOrderSummary') {
    return getOrderSummaryTool(sessionId);
  }
  if (toolName === 'finalizeOrder') {
    return await finalizeOrderTool(toolInput, sessionId);
  }
  throw new Error(`Unknown tool: ${toolName}`);
}

module.exports = { TOOLS, executeTool, MENU_DATA };
