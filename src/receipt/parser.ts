import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { ParsedReceipt, LineItem } from "./types.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const modelName = process.env.CLAUDE_MODEL || "claude-default";

const RECEIPT_SCHEMA = {
  type: "object" as const,
  properties: {
    items: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
          quantity: { type: "integer" as const },
          unit_price: { type: "number" as const },
          total_price: { type: "number" as const },
        },
        required: ["name", "quantity", "unit_price", "total_price"] as const,
        additionalProperties: false,
      },
    },
    subtotal: { type: "number" as const },
    tax: { type: "number" as const },
    tip: { type: ["number", "null"] as const },
    total: { type: "number" as const },
  },
  required: ["items", "subtotal", "tax", "tip", "total"] as const,
  additionalProperties: false,
};

export async function parseReceiptImage(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
): Promise<ParsedReceipt> {
  const response = await anthropic.messages.create({
    model: modelName,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: imageBase64,
            },
          },
          {
            type: "text",
            text: `Extract all line items from this receipt. For each item, provide the name, quantity, unit price (price per single item), and total price (quantity × unit price). Also extract the subtotal (sum of all items before tax/tip), tax amount, tip amount (null if no tip is shown), and the total. Return only the JSON — no commentary.  Use the following schema for the json response: ${JSON.stringify(RECEIPT_SCHEMA)}`,
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }

  // Extract JSON from the response (may be wrapped in markdown code block)
  let jsonStr = textBlock.text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  const parsed: ParsedReceipt = JSON.parse(jsonStr);
  return parsed;
}

export function expandLineItems(parsed: ParsedReceipt): LineItem[] {
  if (!Array.isArray(parsed.items)) {
    console.error("parsed.items is not an array:", parsed.items);
    throw new TypeError("parsed.items must be an array");
  }

  const items: LineItem[] = [];
  let index = 1;

  for (const item of parsed.items) {
    if (item.quantity > 1) {
      for (let i = 1; i <= item.quantity; i++) {
        items.push({
          index: index++,
          name: `${item.name} (${i} of ${item.quantity})`,
          unitPrice: item.unit_price,
          originalQuantity: item.quantity,
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

export function validateReceipt(
  parsed: ParsedReceipt,
  items: LineItem[],
): string | null {
  const itemsSum = items.reduce((sum, item) => sum + item.unitPrice, 0);
  const diff = Math.abs(itemsSum - parsed.subtotal);
  if (diff > 0.5) {
    return `Warning: Item prices sum to $${itemsSum.toFixed(2)} but receipt subtotal is $${parsed.subtotal.toFixed(2)} (difference: $${diff.toFixed(2)}).`;
  }
  return null;
}
