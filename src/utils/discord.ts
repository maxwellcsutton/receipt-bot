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

// Maps normalized aliases to canonical restaurant names.
// Keys must be lowercase for case-insensitive matching.
const RESTAURANT_ALIASES: Record<string, string> = {
  // T Kebob
  tk: "T Kebob",
  tkebab: "T Kebob",
  "t kebab": "T Kebob",
  "t kebob": "T Kebob",
  // SunNongDan
  snd: "SunNongDan",
  // BCD
  bcd: "BCD",
  // Chubby Cattle
  chubby: "Chubby Cattle",
  "chubby cattle": "Chubby Cattle",
};

export function extractRestaurantName(content: string, botId: string): string {
  // Remove mentions and trim
  const name = content.replace(/<@!?\d+>/g, "").trim();

  if (!name) return "Receipt";

  const canonical = RESTAURANT_ALIASES[name.toLowerCase()];
  return canonical ?? name;
}

import { Guild } from "discord.js";

export type DisplayNameResolver = (userId: string) => string;

export async function buildDisplayNameResolver(
  guild: Guild,
  userIds: string[],
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
  contentType: string | null,
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  if (!contentType) return null;
  const type = contentType.toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return "image/jpeg";
  if (type.includes("png")) return "image/png";
  if (type.includes("gif")) return "image/gif";
  if (type.includes("webp")) return "image/webp";
  return null;
}

import { ThreadChannel } from 'discord.js';

/**
 * Removes a user from a thread.
 * @param thread - The thread channel to remove the user from.
 * @param userId - The ID of the user to remove.
 * @returns A promise that resolves when the user is removed.
 */
export async function removeUserFromThread(thread: ThreadChannel, userId: string): Promise<void> {
  try {
    await thread.members.remove(userId);
    console.log(`User ${userId} removed from thread ${thread.name}`);
  } catch (error) {
    console.error(`Failed to remove user ${userId} from thread ${thread.name}:`, error);
    throw error;
  }
}
