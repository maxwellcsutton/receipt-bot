import {
  Client,
  Message,
  TextChannel,
  ThreadChannel,
  ChannelType,
  EmbedBuilder,
} from "discord.js";
import { randomUUID } from "crypto";
import { config } from "../../config.js";
import {
  parseReceiptImage,
  expandLineItems,
  validateReceipt,
} from "../../receipt/parser.js";
import {
  buildSummaryEmbeds,
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
import { ReceiptSession, UserTotal } from "../../receipt/types.js";

export function registerMessageCreateEvent(client: Client): void {
  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot) return;

    try {
      // Messages in receipt threads
      if (
        message.channel.type === ChannelType.PublicThread ||
        message.channel.type === ChannelType.PrivateThread
      ) {
        await handleThreadMessage(message);
        return;
      }

      // Bot must be mentioned for any non-thread command
      if (!message.mentions.has(client.user!)) return;

      const content = message.content.toLowerCase();

      // Leaderboard command
      if (content.includes("leaderboard")) {
        await handleLeaderboard(message);
        return;
      }

      // Sum command (check "sum paid" before "sum")
      if (content.includes("sum paid")) {
        await handleSum(message, client, true);
        return;
      }
      if (content.includes("sum")) {
        await handleSum(message, client, false);
        return;
      }

      // New receipt submission (bot mention + image attachment)
      if (
        message.attachments.some((a) => a.contentType?.startsWith("image/"))
      ) {
        await handleNewReceipt(message, client);
      }
    } catch (err) {
      console.error("Error handling message:", err);
      try {
        await message.reply(
          `OOPSIE WOOPSIE!! Uwu We make a fucky wucky!! A wittle fucko boingo! The code monkeys at our headquarters are working VEWY HAWD to fix this!`,
        );
      } catch {
        // ignore reply failure
      }
    }
  });
}

// Returns a single proxy target for commands that act on behalf of one user
// (claim, unclaim, split). Returns null if not applicable.
function getProxyTarget(
  message: Message,
  session: ReceiptSession,
): string | null {
  if (message.author.id !== session.primaryUserId) return null;
  const mentioned = message.mentions.users
    .filter((u) => !u.bot && u.id !== message.author.id)
    .map((u) => u.id);
  if (mentioned.length !== 1) return null;
  const targetId = mentioned[0];
  if (!session.taggedUserIds.includes(targetId)) return null;
  return targetId;
}

// Returns all proxy targets for paid/unpaid, which can act on multiple users at once.
function getProxyTargets(
  message: Message,
  session: ReceiptSession,
): string[] | null {
  if (message.author.id !== session.primaryUserId) return null;
  const mentioned = message.mentions.users
    .filter((u) => !u.bot && u.id !== message.author.id)
    .map((u) => u.id)
    .filter((id) => session.taggedUserIds.includes(id));
  if (mentioned.length === 0) return null;
  return mentioned;
}

async function getDisplayNameResolver(
  message: Message,
  session: ReceiptSession,
): Promise<DisplayNameResolver> {
  const guild = message.guild;
  if (!guild) return (id: string) => `<@${id}>`;

  const allUserIds = new Set(session.taggedUserIds);
  const items = manager.getItems(session.id);
  for (const item of items) {
    if (item.claimedByUserId) allUserIds.add(item.claimedByUserId);
  }
  const splits = manager.getSplits(session.id);
  for (const s of splits) allUserIds.add(s.userId);

  return buildDisplayNameResolver(guild, [...allUserIds]);
}

async function handleLeaderboard(message: Message): Promise<void> {
  if (!message.guildId) {
    await message.reply("Leaderboard is only available in servers.");
    return;
  }

  const { restaurants, users } = manager.getLeaderboard(message.guildId);

  if (restaurants.length === 0 && users.length === 0) {
    await message.reply("No settled receipts yet — nothing to show.");
    return;
  }

  const guild = message.guild!;
  const userIds = users.map((u) => u.userId);
  const displayName =
    userIds.length > 0
      ? await buildDisplayNameResolver(guild, userIds)
      : (_id: string) => "Unknown";

  const embed = new EmbedBuilder()
    .setTitle("🏆 Receipt Leaderboard")
    .setColor(0x3498db);

  if (restaurants.length > 0) {
    const lines = restaurants.map(
      (r, i) =>
        `${i + 1}. **${r.restaurantName}** — $${r.totalSpend.toFixed(2)} (${r.receiptCount} receipt${r.receiptCount !== 1 ? "s" : ""})`,
    );
    embed.addFields({
      name: "Top Restaurants by Spend",
      value: lines.join("\n"),
      inline: false,
    });
  }

  if (users.length > 0) {
    const lines = users.map(
      (u, i) =>
        `${i + 1}. **${displayName(u.userId)}** — $${u.totalSpend.toFixed(2)}`,
    );
    embed.addFields({
      name: "Top Spenders",
      value: lines.join("\n"),
      inline: false,
    });
  }

  await message.reply({ embeds: [embed] });
}

async function handleSum(
  message: Message,
  client: Client,
  markPaid: boolean,
): Promise<void> {
  if (!message.guildId || !message.guild) {
    await message.reply("The sum command is only available in servers.");
    return;
  }

  const sessions = manager.getUnpaidSessionsForUser(
    message.guildId,
    message.author.id,
  );

  if (sessions.length === 0) {
    await message.reply("You have no unpaid items across any active receipts.");
    return;
  }

  const sessionData: { session: ReceiptSession; ut: UserTotal }[] = [];
  for (const session of sessions) {
    const userTotals = manager.getUserTotals(session);
    const ut = userTotals.find((u) => u.userId === message.author.id);
    if (ut) sessionData.push({ session, ut });
  }

  if (sessionData.length === 0) {
    await message.reply("You have no unpaid items across any active receipts.");
    return;
  }

  const grandTotal = sessionData.reduce((sum, d) => sum + d.ut.grandTotal, 0);

  const lines = sessionData.map(
    (d) => `**${d.session.restaurantName}** — $${d.ut.grandTotal.toFixed(2)}`,
  );
  lines.push(`\n**Grand Total: $${grandTotal.toFixed(2)}**`);

  if (markPaid) {
    for (const { session } of sessionData) {
      manager.markUserPaid(session.id, message.author.id);
    }

    // Update each thread's summary and check for settlement
    for (const { session } of sessionData) {
      try {
        const thread = await client.channels.fetch(session.threadId);
        if (!thread || !thread.isThread()) continue;

        const refreshedSession = manager.getSession(session.threadId);
        if (!refreshedSession) continue;

        const displayName = await buildDisplayNameResolver(
          thread.guild,
          refreshedSession.taggedUserIds,
        );
        const items = manager.getItems(session.id);
        const userTotals = manager.getUserTotals(refreshedSession);
        const payments = manager.getPaymentStatuses(session.id);
        const splits = manager.getSplits(session.id);
        const embeds = buildSummaryEmbeds(
          refreshedSession,
          items,
          userTotals,
          payments,
          splits,
          displayName,
        );

        if (session.summaryMessageId) {
          try {
            const summaryMsg = await thread.messages.fetch(
              session.summaryMessageId,
            );
            await summaryMsg.edit({ embeds });
          } catch {
            const newMsg = await thread.send({ embeds });
            manager.setSummaryMessageId(session.id, newMsg.id);
          }
        }

        const { allPaid } = manager.checkAllClaimedAndPaid(refreshedSession);
        if (allPaid) {
          const primaryName = displayName(session.primaryUserId);
          manager.recordSettlement(
            session.guildId,
            session.restaurantName,
            userTotals,
          );
          await thread.send(
            `🎉 **${primaryName}** — All payments for **${session.restaurantName}** have been received!`,
          );
        }
      } catch (err) {
        console.error(`Failed to update thread for session ${session.id}:`, err);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle("✅ Marked as Paid")
      .setColor(0x2ecc71)
      .setDescription(lines.join("\n"));
    await message.reply({ embeds: [embed] });
  } else {
    const embed = new EmbedBuilder()
      .setTitle("💰 Your Unpaid Totals")
      .setColor(0xe74c3c)
      .setDescription(
        lines.join("\n") + "\n\nReply `@bot sum paid` to mark all as paid.",
      );
    await message.reply({ embeds: [embed] });
  }
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

  const taggedUserIds = message.mentions.users
    .filter((u) => u.id !== client.user!.id)
    .map((u) => u.id);

  if (taggedUserIds.length === 0) {
    await message.reply(
      "Please tag at least one other user to split the receipt with.",
    );
    return;
  }

  // Check daily API spend limit before calling Claude
  manager.checkDailyLimit();

  const restaurantName = extractRestaurantName(
    message.content,
    client.user!.id,
  );

  await message.react("⏳");

  const response = await fetch(attachment.url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const imageBase64 = buffer.toString("base64");

  const { parsed, estimatedCostUsd } = await parseReceiptImage(
    imageBase64,
    mediaType,
  );

  manager.logApiCost(estimatedCostUsd);

  const lineItems = expandLineItems(parsed);
  const warning = validateReceipt(parsed, lineItems);

  const thread = await (message.channel as TextChannel).threads.create({
    name: restaurantName,
    startMessage: message,
  });

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

  const itemListMsg = formatItemList(session.taggedUserIds);
  await thread.send(itemListMsg);

  const displayName = await getDisplayNameResolver(message, session);
  const userTotals = manager.getUserTotals(session);
  const payments = manager.getPaymentStatuses(session.id);
  const splits = manager.getSplits(session.id);
  const embeds = buildSummaryEmbeds(
    session,
    lineItems,
    userTotals,
    payments,
    splits,
    displayName,
  );
  const summaryMsg = await thread.send({ embeds });
  manager.setSummaryMessageId(session.id, summaryMsg.id);

  if (warning) {
    await thread.send(`⚠️ ${warning}`);
  }

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
  if (!session) return;

  if (session.status === "settled") {
    await message.reply("This receipt has already been settled.");
    return;
  }

  // Strip mentions from content so proxy commands parse cleanly
  const contentClean = message.content
    .replace(/<@!?\d+>/g, "")
    .trim()
    .toLowerCase();

  // Proxy target: if primary user tags a secondary user, act on their behalf
  const proxyTarget = getProxyTarget(message, session);
  const effectiveUserId = proxyTarget ?? message.author.id;

  if (contentClean.startsWith("tip ")) {
    await handleTipCommand(message, session, contentClean);
    return;
  }

  if (contentClean.startsWith("unclaim ")) {
    await handleUnclaim(message, session, contentClean, effectiveUserId);
    return;
  }

  if (contentClean.startsWith("split ")) {
    await handleSplit(message, session, effectiveUserId);
    return;
  }

  if (contentClean === "paid" || contentClean === "done") {
    const targets = getProxyTargets(message, session) ?? [message.author.id];
    for (const t of targets) await handlePaid(message, session, t);
    return;
  }

  if (contentClean === "unpaid") {
    const targets = getProxyTargets(message, session) ?? [message.author.id];
    for (const t of targets) await handleUnpaid(message, session, t);
    return;
  }

  if (contentClean === "status") {
    await handleStatus(message, session);
    return;
  }

  if (contentClean.startsWith("adduser ")) {
    await handleAddUser(message, session);
    return;
  }

  if (contentClean.startsWith("claim ") || contentClean === "claim") {
    const numbers = parseItemNumbers(contentClean.slice("claim".length));
    if (numbers.length === 0) {
      await message.reply("Please specify item numbers (e.g. `claim 1 3 5`).");
      return;
    }
    await handleClaim(message, session, numbers, effectiveUserId);
    return;
  }
}

async function handleClaim(
  message: Message,
  session: ReceiptSession,
  itemNumbers: number[],
  targetUserId: string,
): Promise<void> {
  try {
    manager.claimItems(session.id, itemNumbers, targetUserId);
  } catch (err) {
    await message.reply(
      err instanceof Error ? err.message : "Failed to claim items.",
    );
    return;
  }

  const refreshedSession = manager.getSession(
    (message.channel as ThreadChannel).id,
  )!;
  const displayName = await getDisplayNameResolver(message, refreshedSession);
  const userTotals = manager.getUserTotals(refreshedSession);
  const ut = userTotals.find((u) => u.userId === targetUserId);

  if (ut) {
    const tipSet = refreshedSession.tipAmount !== null;
    await message.reply(formatUserTotal(ut, tipSet, displayName(targetUserId)));
  }

  await updateSummaryMessage(message, refreshedSession);
  await checkAndNotify(message, refreshedSession);
}

async function handleUnclaim(
  message: Message,
  session: ReceiptSession,
  contentClean: string,
  targetUserId: string,
): Promise<void> {
  const numbers = parseItemNumbers(contentClean.slice("unclaim ".length));
  if (numbers.length === 0) {
    await message.reply(
      "Please specify item numbers to unclaim (e.g. `unclaim 1 3`).",
    );
    return;
  }

  try {
    manager.unclaimItems(session.id, numbers, targetUserId);
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
  effectiveUserId: string,
): Promise<void> {
  // Parse item index — strip mentions first since they may contain numbers
  const parts = message.content
    .replace(/<@!?\d+>/g, "")
    .trim()
    .split(/\s+/);
  const itemIndex = parseInt(parts[1], 10);
  if (isNaN(itemIndex)) {
    await message.reply("Usage: `split <item number> @user1 @user2`");
    return;
  }

  const mentionedIds = message.mentions.users
    .filter((u) => !u.bot)
    .map((u) => u.id);
  // effectiveUserId is the acting participant; add all other mentions, deduped
  const allUserIds = [
    effectiveUserId,
    ...mentionedIds.filter((id) => id !== effectiveUserId),
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

async function handleUnpaid(
  message: Message,
  session: ReceiptSession,
  targetUserId: string,
): Promise<void> {
  const payments = manager.getPaymentStatuses(session.id);
  const userPayment = payments.find((p) => p.userId === targetUserId);

  if (!userPayment) {
    await message.reply(
      "That user doesn't have any claimed items on this receipt.",
    );
    return;
  }

  if (!userPayment.paid) {
    await message.reply("That user is already marked as unpaid.");
    return;
  }

  manager.markUserUnpaid(session.id, targetUserId);

  const displayName = await getDisplayNameResolver(message, session);
  await message.reply(`${displayName(targetUserId)} marked as unpaid.`);

  const refreshedSession = manager.getSession(
    (message.channel as ThreadChannel).id,
  )!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleAddUser(
  message: Message,
  session: ReceiptSession,
): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply("Only the primary user can add new users.");
    return;
  }

  const newUsers = message.mentions.users
    .filter((u) => !u.bot && !session.taggedUserIds.includes(u.id))
    .map((u) => u.id);

  if (newUsers.length === 0) {
    await message.reply(
      "No new users to add. Make sure you @mention users not already in this receipt.",
    );
    return;
  }

  for (const userId of newUsers) {
    manager.addUserToSession(session.id, userId);
  }

  const refreshedSession = manager.getSession(
    (message.channel as ThreadChannel).id,
  )!;
  const displayName = await getDisplayNameResolver(message, refreshedSession);
  const names = newUsers.map((id) => displayName(id)).join(", ");
  await message.reply(
    `Added ${names} to the receipt. They can now claim items.`,
  );

  await updateSummaryMessage(message, refreshedSession);
}

async function handleStatus(
  message: Message,
  session: ReceiptSession,
): Promise<void> {
  const displayName = await getDisplayNameResolver(message, session);
  const items = manager.getItems(session.id);
  const userTotals = manager.getUserTotals(session);
  const payments = manager.getPaymentStatuses(session.id);
  const splits = manager.getSplits(session.id);
  const embeds = buildSummaryEmbeds(
    session,
    items,
    userTotals,
    payments,
    splits,
    displayName,
  );
  await message.reply({ embeds });
}

async function handleTipCommand(
  message: Message,
  session: ReceiptSession,
  contentClean: string,
): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply("Only the primary user can set the tip.");
    return;
  }

  const tipStr = contentClean.slice("tip ".length).trim();
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
  targetUserId: string,
): Promise<void> {
  const payments = manager.getPaymentStatuses(session.id);
  const userPayment = payments.find((p) => p.userId === targetUserId);

  if (!userPayment) {
    await message.reply(
      "That user doesn't have any claimed items on this receipt.",
    );
    return;
  }

  if (userPayment.paid) {
    await message.reply("That user is already marked as paid.");
    return;
  }

  manager.markUserPaid(session.id, targetUserId);

  const displayName = await getDisplayNameResolver(message, session);
  await message.reply(`${displayName(targetUserId)} marked as paid! ✅`);

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
  const embeds = buildSummaryEmbeds(
    session,
    items,
    userTotals,
    payments,
    splits,
    displayName,
  );

  try {
    const summaryMsg = await thread.messages.fetch(session.summaryMessageId);
    await summaryMsg.edit({ embeds });
  } catch {
    const newMsg = await thread.send({ embeds });
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

    const userTotals = manager.getUserTotals(session);
    manager.recordSettlement(
      session.guildId,
      session.restaurantName,
      userTotals,
    );

    await thread.send(
      `🎉 **${primaryName}** — All payments for **${session.restaurantName}** have been received!`,
    );
  } else if (!allClaimed) {
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
