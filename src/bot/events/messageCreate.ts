import {
  Client,
  Message,
  TextChannel,
  ThreadChannel,
  ChannelType,
} from "discord.js";
import { randomUUID } from "crypto";
import { config } from "../../config.js";
import {
  parseReceiptImage,
  expandLineItems,
  validateReceipt,
} from "../../receipt/parser.js";
import {
  buildSummaryEmbed,
  formatItemList,
  formatUserTotal,
} from "../../receipt/formatter.js";
import * as manager from "../../session/manager.js";
import {
  parseItemNumbers,
  extractRestaurantName,
  getImageMediaType,
  buildDisplayNameResolver,
  DisplayNameResolver,
} from "../../utils/discord.js";
import { ReceiptSession } from "../../receipt/types.js";

export function registerMessageCreateEvent(client: Client): void {
  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot) return;

    try {
      // Check if this is a message in a receipt thread
      if (
        message.channel.type === ChannelType.PublicThread ||
        message.channel.type === ChannelType.PrivateThread
      ) {
        await handleThreadMessage(message);
        return;
      }

      // Check if this is a new receipt submission in a monitored channel
      if (message.mentions.has(client.user!)) {
        await handleNewReceipt(message, client);
      }
    } catch (err) {
      console.error("Error handling message:", err);
      try {
        await message.reply(
          `An error occurred: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      } catch {
        // ignore reply failure
      }
    }
  });
}

async function getDisplayNameResolver(
  message: Message,
  session: ReceiptSession,
): Promise<DisplayNameResolver> {
  const guild = message.guild;
  if (!guild) return (id: string) => `<@${id}>`;

  // Collect all user IDs that might appear in the summary
  const allUserIds = new Set(session.taggedUserIds);
  const items = manager.getItems(session.id);
  for (const item of items) {
    if (item.claimedByUserId) allUserIds.add(item.claimedByUserId);
  }
  const splits = manager.getSplits(session.id);
  for (const s of splits) allUserIds.add(s.userId);

  return buildDisplayNameResolver(guild, [...allUserIds]);
}

async function handleNewReceipt(
  message: Message,
  client: Client,
): Promise<void> {
  const attachment = message.attachments.find((a) =>
    a.contentType?.startsWith("image/"),
  );
  if (!attachment) {
    await message.reply("Please include a receipt image in your message.");
    return;
  }

  const mediaType = getImageMediaType(attachment.contentType);
  if (!mediaType) {
    await message.reply(
      "Unsupported image format. Please use JPEG, PNG, GIF, or WebP.",
    );
    return;
  }

  // Get tagged users (exclude bot)
  const taggedUserIds = message.mentions.users
    .filter((u) => u.id !== client.user!.id)
    .map((u) => u.id);

  if (taggedUserIds.length === 0) {
    await message.reply(
      "Please tag at least one other user to split the receipt with.",
    );
    return;
  }

  const restaurantName = extractRestaurantName(
    message.content,
    client.user!.id,
  );

  // Download and parse receipt
  await message.react("⏳");

  const response = await fetch(attachment.url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const imageBase64 = buffer.toString("base64");

  const parsed = await parseReceiptImage(imageBase64, mediaType);
  const lineItems = expandLineItems(parsed);
  const warning = validateReceipt(parsed, lineItems);

  // Create thread
  const thread = await (message.channel as TextChannel).threads.create({
    name: restaurantName,
    startMessage: message,
  });

  // Create session
  const session: ReceiptSession = {
    id: randomUUID(),
    threadId: thread.id,
    originalMessageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId!,
    primaryUserId: message.author.id,
    restaurantName,
    subtotal: parsed.subtotal,
    taxAmount: parsed.tax,
    tipAmount: parsed.tip,
    total: parsed.total,
    status: "active",
    summaryMessageId: null,
    taggedUserIds: [message.author.id, ...taggedUserIds],
    createdAt: new Date().toISOString(),
  };

  manager.createReceiptSession(session, lineItems);

  // Post item list
  const itemListMsg = formatItemList(lineItems, session.taggedUserIds);
  await thread.send(itemListMsg);

  // Post initial summary embed
  const displayName = await getDisplayNameResolver(message, session);
  const userTotals = manager.getUserTotals(session);
  const payments = manager.getPaymentStatuses(session.id);
  const splits = manager.getSplits(session.id);
  const embed = buildSummaryEmbed(
    session,
    lineItems,
    userTotals,
    payments,
    splits,
    displayName,
  );
  const summaryMsg = await thread.send({ embeds: [embed] });
  manager.setSummaryMessageId(session.id, summaryMsg.id);

  // Warning if items don't sum correctly
  if (warning) {
    await thread.send(`⚠️ ${warning}`);
  }

  // Tip prompt
  if (parsed.tip === null || parsed.tip === 0) {
    await thread.send(
      "No tip detected on the receipt. The primary user can reply `tip 20%` or `tip 15.00` to add a tip, or `tip 0` to skip.",
    );
  }

  await message.reactions.removeAll().catch(() => {});
  await message.react("✅");
}

async function handleThreadMessage(message: Message): Promise<void> {
  const thread = message.channel as ThreadChannel;
  const session = manager.getSession(thread.id);
  if (!session) return; // Not a receipt thread we're tracking

  if (session.status === "settled") {
    await message.reply("This receipt has already been settled.");
    return;
  }

  const content = message.content.trim().toLowerCase();

  // Handle tip setting
  if (content.startsWith("tip ")) {
    await handleTipCommand(message, session);
    return;
  }

  // Handle unclaim
  if (content.startsWith("unclaim ")) {
    await handleUnclaim(message, session);
    return;
  }

  // Handle split
  if (content.startsWith("split ")) {
    await handleSplit(message, session);
    return;
  }

  // Handle paid
  if (content === "paid" || content === "done") {
    await handlePaid(message, session);
    return;
  }

  // Handle claim (any message with numbers)
  const numbers = parseItemNumbers(message.content);
  if (numbers.length > 0) {
    await handleClaim(message, session, numbers);
    return;
  }
}

async function handleClaim(
  message: Message,
  session: ReceiptSession,
  itemNumbers: number[],
): Promise<void> {
  try {
    manager.claimItems(session.id, itemNumbers, message.author.id);
  } catch (err) {
    await message.reply(
      err instanceof Error ? err.message : "Failed to claim items.",
    );
    return;
  }

  // Get updated state and reply with user's total
  const refreshedSession = manager.getSession(
    (message.channel as ThreadChannel).id,
  )!;
  const displayName = await getDisplayNameResolver(message, refreshedSession);
  const userTotals = manager.getUserTotals(refreshedSession);
  const ut = userTotals.find((u) => u.userId === message.author.id);

  if (ut) {
    const tipSet = refreshedSession.tipAmount !== null;
    await message.reply(
      formatUserTotal(ut, tipSet, displayName(message.author.id)),
    );
  }

  await updateSummaryMessage(message, refreshedSession);
  await checkAndNotify(message, refreshedSession);
}

async function handleUnclaim(
  message: Message,
  session: ReceiptSession,
): Promise<void> {
  const numbers = parseItemNumbers(message.content.slice("unclaim ".length));
  if (numbers.length === 0) {
    await message.reply(
      "Please specify item numbers to unclaim (e.g. `unclaim 1, 3`).",
    );
    return;
  }

  try {
    manager.unclaimItems(session.id, numbers, message.author.id);
  } catch (err) {
    await message.reply(
      err instanceof Error ? err.message : "Failed to unclaim items.",
    );
    return;
  }

  await message.reply(`Unclaimed items: ${numbers.join(", ")}`);

  const refreshedSession = manager.getSession(
    (message.channel as ThreadChannel).id,
  )!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleSplit(
  message: Message,
  session: ReceiptSession,
): Promise<void> {
  // Parse: split <number> @user1 @user2 ...
  const parts = message.content.trim().split(/\s+/);
  const itemIndex = parseInt(parts[1], 10);
  if (isNaN(itemIndex)) {
    await message.reply("Usage: `split <item number> @user1 @user2`");
    return;
  }

  // Include the message author plus all mentioned users
  const mentionedIds = message.mentions.users.map((u) => u.id);
  const allUserIds = [
    message.author.id,
    ...mentionedIds.filter((id) => id !== message.author.id),
  ];

  if (allUserIds.length < 2) {
    await message.reply(
      "Please mention at least one other user to split the item with.",
    );
    return;
  }

  try {
    manager.splitItem(session.id, itemIndex, allUserIds);
  } catch (err) {
    await message.reply(
      err instanceof Error ? err.message : "Failed to split item.",
    );
    return;
  }

  const displayName = await getDisplayNameResolver(message, session);
  const items = manager.getItems(session.id);
  const item = items.find((i) => i.index === itemIndex);
  const perPerson = item
    ? (item.unitPrice / allUserIds.length).toFixed(2)
    : "?";
  const names = allUserIds.map((id) => displayName(id)).join(", ");
  await message.reply(
    `Item ${itemIndex} split between ${names} — $${perPerson} each.`,
  );

  const refreshedSession = manager.getSession(
    (message.channel as ThreadChannel).id,
  )!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleTipCommand(
  message: Message,
  session: ReceiptSession,
): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply("Only the primary user can set the tip.");
    return;
  }

  const tipStr = message.content.trim().slice("tip ".length).trim();
  let tipAmount: number;

  if (tipStr.endsWith("%")) {
    const pct = parseFloat(tipStr.slice(0, -1));
    if (isNaN(pct)) {
      await message.reply("Invalid tip percentage. Use e.g. `tip 20%`.");
      return;
    }
    tipAmount = Math.round(session.subtotal * (pct / 100) * 100) / 100;
  } else {
    tipAmount = parseFloat(tipStr);
    if (isNaN(tipAmount)) {
      await message.reply(
        "Invalid tip amount. Use e.g. `tip 15.00` or `tip 20%`.",
      );
      return;
    }
  }

  manager.setTip(session.id, tipAmount);
  await message.reply(`Tip set to $${tipAmount.toFixed(2)}.`);

  const refreshedSession = manager.getSession(
    (message.channel as ThreadChannel).id,
  )!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handlePaid(
  message: Message,
  session: ReceiptSession,
): Promise<void> {
  const payments = manager.getPaymentStatuses(session.id);
  const userPayment = payments.find((p) => p.userId === message.author.id);

  if (!userPayment) {
    await message.reply("You don't have any claimed items on this receipt.");
    return;
  }

  if (userPayment.paid) {
    await message.reply("You're already marked as paid.");
    return;
  }

  manager.markUserPaid(session.id, message.author.id);

  const displayName = await getDisplayNameResolver(message, session);
  const name = displayName(message.author.id);
  await message.reply(`${name} marked as paid! ✅`);

  const refreshedSession = manager.getSession(
    (message.channel as ThreadChannel).id,
  )!;
  await updateSummaryMessage(message, refreshedSession);
  await checkAndNotify(message, refreshedSession);
}

async function updateSummaryMessage(
  message: Message,
  session: ReceiptSession,
): Promise<void> {
  if (!session.summaryMessageId) return;

  const thread = message.channel as ThreadChannel;
  const displayName = await getDisplayNameResolver(message, session);
  const items = manager.getItems(session.id);
  const userTotals = manager.getUserTotals(session);
  const payments = manager.getPaymentStatuses(session.id);
  const splits = manager.getSplits(session.id);
  const embed = buildSummaryEmbed(
    session,
    items,
    userTotals,
    payments,
    splits,
    displayName,
  );

  try {
    const summaryMsg = await thread.messages.fetch(session.summaryMessageId);
    await summaryMsg.edit({ embeds: [embed] });
  } catch {
    // If we can't edit the old message, send a new one
    const newMsg = await thread.send({ embeds: [embed] });
    manager.setSummaryMessageId(session.id, newMsg.id);
  }
}

async function checkAndNotify(
  message: Message,
  session: ReceiptSession,
): Promise<void> {
  const { allClaimed, allPaid } = manager.checkAllClaimedAndPaid(session);
  const thread = message.channel as ThreadChannel;

  if (allPaid) {
    const displayName = await getDisplayNameResolver(message, session);
    const primaryName = displayName(session.primaryUserId);
    await thread.send(
      `🎉 **${primaryName}** — All payments for **${session.restaurantName}** have been received!`,
    );
  } else if (!allClaimed) {
    // Check if all tagged users have claimed at least one item but unclaimed items remain
    const items = manager.getItems(session.id);
    const unclaimed = items.filter((i) => !i.claimedByUserId);
    if (unclaimed.length > 0) {
      const claimants = new Set(
        items.filter((i) => i.claimedByUserId).map((i) => i.claimedByUserId!),
      );
      const allTaggedHaveClaimed = session.taggedUserIds
        .filter((id) => id !== session.primaryUserId)
        .every((id) => claimants.has(id));

      if (allTaggedHaveClaimed && !claimants.has(session.primaryUserId)) {
        const unclaimedNums = unclaimed.map((i) => i.index).join(", ");
        await thread.send(
          `Items ${unclaimedNums} are still unclaimed. <@${session.primaryUserId}>, who do these belong to?`,
        );
      }
    }
  }
}
