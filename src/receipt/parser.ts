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

export async function parseReceiptImage(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
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
            text: `Extract all line items from this receipt. For each line item output one entry with:
- name: the item name, stripped of any parenthetical numbers (e.g. "Mild Spicy Lamb Kebab(5)" → "Mild Spicy Lamb Kebab")
- quantity: the number in the LEFTMOST column of that line. This is the only source of truth for quantity. Numbers inside the item name (like the "(5)" or "(1)") are NOT the quantity — ignore them.
- line_total: the price shown on the right for that line (the full amount for all units combined)

Output one JSON object per receipt line — do not expand or split quantities, that will be handled separately.

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
