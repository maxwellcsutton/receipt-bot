import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { ParsedReceipt, LineItem } from "./types.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20241022";

// Haiku 4.5 pricing (per token)
const COST_PER_INPUT_TOKEN = 0.80 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 4.00 / 1_000_000;

const ITEM_SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const },
    unit_price: { type: "number" as const },
  },
  required: ["name", "unit_price"] as const,
  additionalProperties: false,
};

const RECEIPT_SCHEMA = {
  type: "object" as const,
  properties: {
    items: {
      type: "array" as const,
      items: ITEM_SCHEMA,
    },
    subtotal: { type: "number" as const },
    tax: { type: "number" as const },
    tip: { type: ["number", "null"] as const },
    total: { type: "number" as const },
  },
  required: ["items", "subtotal", "tax", "tip", "total"] as const,
  additionalProperties: false,
};

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
            text: `Extract all line items from this receipt as individual units.

CRITICAL RULE: If an item has quantity > 1, list it as SEPARATE entries — one entry per unit.
Example: "3x Mild Spicy Lamb $40.50" → three items: {"name":"Mild Spicy Lamb","unit_price":13.50}, {"name":"Mild Spicy Lamb","unit_price":13.50}, {"name":"Mild Spicy Lamb","unit_price":13.50}
Never use a quantity field — every item in your response must represent exactly one unit.

Also extract:
- subtotal: sum of all item prices before tax and tip
- tax: tax amount (0 if none)
- tip: tip amount (null if not shown on receipt)
- total: final total on receipt

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

  const rawParsed = JSON.parse(jsonStr) as {
    items: { name: string; unit_price: number }[];
    subtotal: number;
    tax: number;
    tip: number | null;
    total: number;
  };

  // Convert to ParsedReceipt format (each item is already quantity=1)
  const parsed: ParsedReceipt = {
    items: rawParsed.items.map((item) => ({
      name: item.name,
      quantity: 1,
      unit_price: item.unit_price,
      total_price: item.unit_price,
    })),
    subtotal: rawParsed.subtotal,
    tax: rawParsed.tax,
    tip: rawParsed.tip,
    total: rawParsed.total,
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

  return parsed.items.map((item, i) => ({
    index: i + 1,
    name: item.name,
    unitPrice: item.unit_price,
    originalQuantity: 1,
    claimedByUserId: null,
  }));
}

export function validateReceipt(
  parsed: ParsedReceipt,
  items: LineItem[]
): string | null {
  const itemsSum = items.reduce((sum, item) => sum + item.unitPrice, 0);
  const diff = Math.abs(itemsSum - parsed.subtotal);
  if (diff > 0.5) {
    return `Warning: Item prices sum to $${itemsSum.toFixed(2)} but receipt subtotal is $${parsed.subtotal.toFixed(2)} (difference: $${diff.toFixed(2)}).`;
  }
  return null;
}
