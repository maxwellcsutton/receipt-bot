export function parseItemNumbers(text: string): number[] {
  // Only accept individual numbers separated by commas or whitespace — no ranges
  const tokens = text.split(/[\s,]+/);
  const numbers: number[] = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const n = parseInt(token, 10);
      if (!numbers.includes(n)) numbers.push(n);
    }
  }
  return numbers.sort((a, b) => a - b);
}

export function extractRestaurantName(
  content: string,
  botId: string
): string {
  // Remove mentions and trim
  let name = content
    .replace(/<@!?\d+>/g, "")
    .trim();
  // If empty, use a default
  return name || "Receipt";
}

import { Guild } from "discord.js";

export type DisplayNameResolver = (userId: string) => string;

export async function buildDisplayNameResolver(
  guild: Guild,
  userIds: string[]
): Promise<DisplayNameResolver> {
  const nameMap = new Map<string, string>();
  for (const id of userIds) {
    try {
      const member = await guild.members.fetch(id);
      // displayName uses server nickname if set, otherwise global display name
      nameMap.set(id, member.displayName);
    } catch {
      nameMap.set(id, `<@${id}>`);
    }
  }
  return (userId: string) => nameMap.get(userId) ?? `<@${userId}>`;
}

export function getImageMediaType(
  contentType: string | null
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  if (!contentType) return null;
  const type = contentType.toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return "image/jpeg";
  if (type.includes("png")) return "image/png";
  if (type.includes("gif")) return "image/gif";
  if (type.includes("webp")) return "image/webp";
  return null;
}
