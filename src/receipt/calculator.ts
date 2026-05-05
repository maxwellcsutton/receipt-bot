import { ReceiptSession, LineItem, SplitEntry, UserTotal } from "./types.js";

export function calculateUserTotals(
  session: ReceiptSession,
  items: LineItem[],
  splits: SplitEntry[]
): UserTotal[] {
  const splitMap = new Map<string, SplitEntry[]>();
  for (const s of splits) {
    const key = `${s.lineItemIndex}`;
    if (!splitMap.has(key)) splitMap.set(key, []);
    splitMap.get(key)!.push(s);
  }

  // Items are stored at raw (pre-discount) prices; apply the discount factor
  // at calc time so changes to session.discountAmount flow through to every
  // item — parsed or custom-added.
  const discount = session.discountAmount ?? 0;
  const factor =
    session.subtotal > 0 && discount > 0
      ? (session.subtotal - discount) / session.subtotal
      : 1;
  const round = (n: number) => Math.round(n * 100) / 100;

  // Build per-user item costs
  const userItems = new Map<
    string,
    { index: number; name: string; amount: number }[]
  >();
  const userTotalsMap = new Map<string, number>();

  for (const item of items) {
    if (!item.claimedByUserId) continue;

    const adjustedUnit = round(item.unitPrice * factor);
    const itemSplits = splitMap.get(`${item.index}`);

    if (itemSplits && itemSplits.length > 0) {
      // Item is split among multiple users — by percentage if all entries
      // carry sharePct, otherwise an even split across all participants.
      const allHavePct = itemSplits.every((s) => s.sharePct !== null);
      for (const split of itemSplits) {
        const shareAmount = allHavePct
          ? round(adjustedUnit * (split.sharePct! / 100))
          : round(adjustedUnit / itemSplits.length);
        if (!userItems.has(split.userId)) userItems.set(split.userId, []);
        userItems.get(split.userId)!.push({
          index: item.index,
          name: item.name,
          amount: shareAmount,
        });
        userTotalsMap.set(
          split.userId,
          (userTotalsMap.get(split.userId) || 0) + shareAmount
        );
      }
    } else {
      // Item is claimed by a single user
      const userId = item.claimedByUserId;
      if (!userItems.has(userId)) userItems.set(userId, []);
      userItems.get(userId)!.push({
        index: item.index,
        name: item.name,
        amount: adjustedUnit,
      });
      userTotalsMap.set(
        userId,
        (userTotalsMap.get(userId) || 0) + adjustedUnit
      );
    }
  }

  const tipAmount = session.tipAmount || 0;
  const results: UserTotal[] = [];

  for (const [userId, itemsList] of userItems) {
    const itemsTotal = userTotalsMap.get(userId) || 0;
    const effectiveSubtotal = session.subtotal - (session.discountAmount ?? 0);
    const share = effectiveSubtotal > 0 ? itemsTotal / effectiveSubtotal : 0;
    const taxShare = Math.round(session.taxAmount * share * 100) / 100;
    const tipShare = Math.round(tipAmount * share * 100) / 100;
    const grandTotal =
      Math.round((itemsTotal + taxShare + tipShare) * 100) / 100;

    results.push({
      userId,
      itemsTotal: Math.round(itemsTotal * 100) / 100,
      taxShare,
      tipShare,
      grandTotal,
      items: itemsList,
    });
  }

  return results;
}
