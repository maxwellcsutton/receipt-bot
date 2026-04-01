import { EmbedBuilder } from "discord.js";
import { ReceiptSession, LineItem, UserTotal, SplitEntry } from "./types.js";
import { DisplayNameResolver } from "../utils/discord.js";

export function buildSummaryEmbed(
  session: ReceiptSession,
  items: LineItem[],
  userTotals: UserTotal[],
  payments: { userId: string; paid: boolean }[],
  splits: SplitEntry[],
  displayName: DisplayNameResolver
): EmbedBuilder {
  const paymentMap = new Map(payments.map((p) => [p.userId, p.paid]));
  const splitMap = new Map<number, SplitEntry[]>();
  for (const s of splits) {
    if (!splitMap.has(s.lineItemIndex)) splitMap.set(s.lineItemIndex, []);
    splitMap.get(s.lineItemIndex)!.push(s);
  }

  const unclaimed = items.filter((i) => !i.claimedByUserId);
  const allClaimed = unclaimed.length === 0;
  const allPaid =
    allClaimed && payments.length > 0 && payments.every((p) => p.paid);

  let color: number;
  if (allPaid) {
    color = 0x2ecc71; // green
  } else if (allClaimed) {
    color = 0xf1c40f; // yellow
  } else {
    color = 0xe74c3c; // red
  }

  const embed = new EmbedBuilder()
    .setTitle(`🧾 ${session.restaurantName}`)
    .setColor(color);

  // U+2800 braille blank: visually empty but not stripped by Discord embed rendering,
  // ensuring all item lines (including the first) are indented consistently.
  const INDENT = "\u2800";

  // Splits a list of lines into one or more embed fields, each within Discord's
  // 1024-character field value limit.
  function addChunkedFields(name: string, lines: string[]): void {
    const LIMIT = 1024;
    let chunk: string[] = [];
    let chunkLen = 0;
    let first = true;

    const flush = () => {
      if (chunk.length === 0) return;
      embed.addFields({
        name: first ? name : `${name} (cont.)`,
        value: chunk.join("\n"),
        inline: false,
      });
      first = false;
      chunk = [];
      chunkLen = 0;
    };

    for (const line of lines) {
      const lineLen = line.length + 1; // +1 for newline
      if (chunkLen + lineLen > LIMIT) flush();
      chunk.push(line);
      chunkLen += lineLen;
    }
    flush();
  }

  // Unclaimed section
  if (unclaimed.length > 0) {
    const lines = unclaimed.map(
      (i) => `${INDENT}**${i.index}.** ${i.name} — $${i.unitPrice.toFixed(2)}`
    );
    addChunkedFields("UNCLAIMED", lines);
  }

  // Claimed section per user
  if (userTotals.length > 0) {
    const claimedLines: string[] = [];
    for (const ut of userTotals) {
      const paid = paymentMap.get(ut.userId);
      const statusIcon = paid ? "✅ PAID" : "❌ UNPAID";
      const name = displayName(ut.userId);
      claimedLines.push(
        `**${name}** — $${ut.grandTotal.toFixed(2)} ${statusIcon}`
      );
      for (const item of ut.items) {
        const itemSplits = splitMap.get(item.index);
        let splitNote = "";
        if (itemSplits && itemSplits.length > 1) {
          const others = itemSplits
            .filter((s) => s.userId !== ut.userId)
            .map((s) => displayName(s.userId))
            .join(", ");
          splitNote = ` (split with ${others} — $${item.amount.toFixed(2)} each)`;
        }
        claimedLines.push(
          `${INDENT}**${item.index}.** ${item.name} — $${item.amount.toFixed(2)}${splitNote}`
        );
      }
      claimedLines.push("");
    }
    addChunkedFields("CLAIMED", claimedLines.slice(0, -1)); // trim trailing blank
  }

  // Footer with totals — compute dynamically so tip updates are reflected
  const tipAmount = session.tipAmount ?? 0;
  const tipStr = session.tipAmount !== null ? `$${tipAmount.toFixed(2)}` : "not set";
  const computedTotal = session.subtotal + session.taxAmount + tipAmount;
  embed.setFooter({
    text: `Subtotal: $${session.subtotal.toFixed(2)} | Tax: $${session.taxAmount.toFixed(2)} | Tip: ${tipStr} | Total: $${computedTotal.toFixed(2)}`,
  });

  return embed;
}

export function formatItemList(
  taggedUserIds: string[]
): string {
  const header = taggedUserIds.map((id) => `<@${id}>`).join(" ");
  const commands = [
    "**Commands:**",
    "`claim 1 3 5` — claim items by number",
    "`unclaim 1 3` — release claimed items",
    "`split 3 @user1 @user2` — split an item between users",
    "`tip 20%` or `tip 15.00` — set tip (primary user only)",
    "`tip 0` — skip tip",
    "`paid` — mark yourself as paid",
    "`unpaid` — mark yourself as unpaid",
    "`status` — show current claim status",
    "`adduser @user` — add a new user to the receipt (primary user only)",
    "_(Primary user: add @user to any command to act on their behalf)_",
  ].join("\n");

  return `${header}\n\nReply with the item numbers you want to claim.\n\n${commands}`;
}

export function formatUserTotal(ut: UserTotal, tipSet: boolean, name: string): string {
  const itemLines = ut.items
    .map((i) => `  ${i.index}. ${i.name} — $${i.amount.toFixed(2)}`)
    .join("\n");

  let msg = `**${name}**, you claimed:\n${itemLines}\n\n`;
  msg += `Items: $${ut.itemsTotal.toFixed(2)} | Tax: $${ut.taxShare.toFixed(2)}`;
  if (tipSet) {
    msg += ` | Tip: $${ut.tipShare.toFixed(2)}`;
  }
  msg += `\n**Your total: $${ut.grandTotal.toFixed(2)}**`;
  if (!tipSet) {
    msg += `\n_(Tip not yet set — total may change)_`;
  }
  msg += `\n\nReply \`paid\` when you've paid.`;
  return msg;
}
