import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { ParsedReceipt, LineItem } from "./types.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20241022";

// Haiku 4.5 pricing (per token)
const COST_PER_INPUT_TOKEN = 0.80 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 4.00 / 1_000_000;

// Claude returns one entry per receipt line — quantity and line_total only.
// We handle division and expansion in code.
const RAW_ITEM_SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const },
    quantity: { type: "integer" as const },
    line_total: { type: "number" as const },
  },
  required: ["name", "quantity", "line_total"] as const,
  additionalProperties: false,
};

const RECEIPT_SCHEMA = {
  type: "object" as const,
  properties: {
    items: {
      type: "array" as const,
      items: RAW_ITEM_SCHEMA,
    },
    subtotal: { type: "number" as const },
    discount: { type: "number" as const },
    tax: { type: "number" as const },
    tip: { type: ["number", "null"] as const },
    total: { type: "number" as const },
  },
  required: ["items", "subtotal", "discount", "tax", "tip", "total"] as const,
  additionalProperties: false,
};

interface RawReceiptItem {
  name: string;
  quantity: number;
  line_total: number;
}

interface RawReceipt {
  items: RawReceiptItem[];
  subtotal: number;
  discount: number;
  tax: number;
  tip: number | null;
  total: number;
}

export interface ParseResult {
  parsed: ParsedReceipt;
  estimatedCostUsd: number;
}

// A line is treated as a modifier if its name starts with a configured modifier
// prefix (e.g. "add ", "extra ", "sub ") or if its line_total is $0 (free option
// lines are almost always modifiers). Indentation itself is handled by the Claude
// prompt — this guardrail only catches leaked cases with clear naming signals.
function looksLikeModifier(name: string): boolean {
  const n = name.trim().toLowerCase();
  return config.modifierPrefixes.some((p) => n.startsWith(p));
}

function rollUpModifiers(items: RawReceiptItem[]): RawReceiptItem[] {
  const result: RawReceiptItem[] = [];
  for (const item of items) {
    const isZero = item.line_total === 0;
    const isModifier = isZero || looksLikeModifier(item.name);
    if (isModifier && result.length > 0) {
      const parent = result[result.length - 1];
      parent.line_total = Math.round((parent.line_total + item.line_total) * 100) / 100;
      const suffix = item.name.trim();
      if (suffix && !parent.name.toLowerCase().includes(suffix.toLowerCase())) {
        parent.name = `${parent.name} + ${suffix}`;
      }
    } else {
      result.push({ ...item });
    }
  }
  return result;
}

export async function parseReceiptImage(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
  userHint?: string,
): Promise<ParseResult> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64 },
          },
          {
            type: "text",
            text: `${userHint ? `USER HINT (pay close attention): ${userHint}\n\n` : ""}Extract all line items from this receipt. For each line item output one entry with:
- name: the item name, stripped of any parenthetical numbers (e.g. "Mild Spicy Lamb Kebab(5)" → "Mild Spicy Lamb Kebab")
- quantity: the number in the LEFTMOST column of that line. This is the only source of truth for quantity. Numbers inside the item name (like the "(5)" or "(1)") are NOT the quantity — ignore them.
- line_total: the TOTAL price charged for this item (see MODIFIERS below)

MODIFIERS / ADD-ONS: Many receipts show modifiers, add-ons, options, or customizations INDENTED beneath a parent item (e.g. "Arrachera $2.16", "Add Guacamole $1.08", "Chile Guero $0.00" under a "Burrito" line). These are NOT separate items — they are upcharges or options that belong to the parent item. For each parent item:
- Sum the parent's base price with the prices of all its indented modifier lines to produce line_total
- Do NOT emit separate JSON entries for modifier/add-on lines
- Modifiers with $0.00 are free options — include them in the name if useful (e.g. "Burrito (Arrachera, Add Guacamole)"), but do not create separate entries

A line is a MODIFIER if it is visually indented under another item, starts with words like "Add", "Extra", "Side", or describes a sub-choice (meat type, temperature, side). A line is a PARENT item if it has its own quantity in the leftmost column.

Output one JSON object per PARENT receipt line — do not expand or split quantities, that will be handled separately.

Also extract subtotal, discount (0 if none), tax, tip (null if not on receipt), and total. Discount is any coupon, promo, or discount line that reduces the subtotal.

Return ONLY valid JSON matching this schema, no commentary:
${JSON.stringify(RECEIPT_SCHEMA)}`,
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }

  let jsonStr = textBlock.text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  const raw = JSON.parse(jsonStr) as RawReceipt;

  // Guardrail: detect modifier/add-on lines that Claude emitted as separate items
  // and roll their line_total into the preceding parent item.
  raw.items = rollUpModifiers(raw.items);

  const discount = raw.discount ?? 0;
  // Discount factor scales each item price proportionally so they sum to (subtotal - discount)
  const discountFactor = raw.subtotal > 0 && discount > 0
    ? (raw.subtotal - discount) / raw.subtotal
    : 1;

  const parsed: ParsedReceipt = {
    items: raw.items.map((item) => {
      const rawUnitPrice = item.line_total / item.quantity;
      const discountedUnitPrice = Math.round(rawUnitPrice * discountFactor * 100) / 100;
      return {
        name: item.name,
        quantity: item.quantity,
        unit_price: discountedUnitPrice,
        total_price: Math.round(item.line_total * discountFactor * 100) / 100,
      };
    }),
    subtotal: raw.subtotal,
    discount,
    tax: raw.tax,
    tip: raw.tip,
    total: raw.total,
  };

  const estimatedCostUsd =
    response.usage.input_tokens * COST_PER_INPUT_TOKEN +
    response.usage.output_tokens * COST_PER_OUTPUT_TOKEN;

  return { parsed, estimatedCostUsd };
}

export function expandLineItems(parsed: ParsedReceipt): LineItem[] {
  if (!Array.isArray(parsed.items)) {
    throw new TypeError("parsed.items must be an array");
  }

  const items: LineItem[] = [];
  let index = 1;

  for (const item of parsed.items) {
    const qty = item.quantity ?? 1;
    if (qty > 1) {
      for (let i = 1; i <= qty; i++) {
        items.push({
          index: index++,
          name: `${item.name} (${i} of ${qty})`,
          unitPrice: item.unit_price,
          originalQuantity: qty,
          claimedByUserId: null,
        });
      }
    } else {
      items.push({
        index: index++,
        name: item.name,
        unitPrice: item.unit_price,
        originalQuantity: 1,
        claimedByUserId: null,
      });
    }
  }

  return items;
}

export function subtotalItemsDiff(
  parsed: ParsedReceipt,
  items: LineItem[],
): number {
  const itemsSum = items.reduce((sum, item) => sum + item.unitPrice, 0);
  const effectiveSubtotal = parsed.subtotal - (parsed.discount ?? 0);
  return Math.abs(itemsSum - effectiveSubtotal);
}

export function validateReceipt(
  parsed: ParsedReceipt,
  items: LineItem[]
): string | null {
  const itemsSum = items.reduce((sum, item) => sum + item.unitPrice, 0);
  const effectiveSubtotal = parsed.subtotal - (parsed.discount ?? 0);
  const diff = Math.abs(itemsSum - effectiveSubtotal);
  if (diff > 0.5) {
    return `Warning: Item prices sum to $${itemsSum.toFixed(2)} but receipt subtotal is $${effectiveSubtotal.toFixed(2)} (difference: $${diff.toFixed(2)}).`;
  }
  return null;
}
