import { getDb } from "./migrations.js";
import {
  ReceiptSession,
  LineItem,
  SplitEntry,
  SessionStatus,
} from "../receipt/types.js";

// --- Sessions ---

export function createSession(session: ReceiptSession, items: LineItem[]): void {
  const db = getDb();
  const insertSession = db.prepare(`
    INSERT INTO receipt_sessions (id, thread_id, original_message_id, channel_id, guild_id,
      primary_user_id, restaurant_name, subtotal, discount_amount, tax_amount, tip_amount, total, status,
      summary_message_id, tagged_user_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO line_items (session_id, item_index, name, unit_price, original_quantity, claimed_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    insertSession.run(
      session.id,
      session.threadId,
      session.originalMessageId,
      session.channelId,
      session.guildId,
      session.primaryUserId,
      session.restaurantName,
      session.subtotal,
      session.discountAmount,
      session.taxAmount,
      session.tipAmount,
      session.total,
      session.status,
      session.summaryMessageId,
      JSON.stringify(session.taggedUserIds),
      session.createdAt
    );
    for (const item of items) {
      insertItem.run(
        session.id,
        item.index,
        item.name,
        item.unitPrice,
        item.originalQuantity,
        item.claimedByUserId
      );
    }
  });

  transaction();
}

export function getSessionByThreadId(
  threadId: string
): ReceiptSession | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM receipt_sessions WHERE thread_id = ?")
    .get(threadId) as any;
  if (!row) return null;
  return rowToSession(row);
}

export function getLineItems(sessionId: string): LineItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM line_items WHERE session_id = ? ORDER BY item_index"
    )
    .all(sessionId) as any[];
  return rows.map((r) => ({
    index: r.item_index,
    name: r.name,
    unitPrice: r.unit_price,
    originalQuantity: r.original_quantity,
    claimedByUserId: r.claimed_by_user_id,
  }));
}

export function claimItems(
  sessionId: string,
  itemIndices: number[],
  userId: string
): void {
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE line_items SET claimed_by_user_id = ? WHERE session_id = ? AND item_index = ? AND claimed_by_user_id IS NULL"
  );
  const transaction = db.transaction(() => {
    for (const idx of itemIndices) {
      const result = stmt.run(userId, sessionId, idx);
      if (result.changes === 0) {
        const existing = db
          .prepare(
            "SELECT claimed_by_user_id FROM line_items WHERE session_id = ? AND item_index = ?"
          )
          .get(sessionId, idx) as any;
        if (!existing) {
          throw new Error(`Item ${idx} does not exist.`);
        }
        if (existing.claimed_by_user_id) {
          throw new Error(
            `Item ${idx} is already claimed by <@${existing.claimed_by_user_id}>.`
          );
        }
      }
    }
    ensureUserPayment(sessionId, userId);
  });
  transaction();
}

export function unclaimItems(
  sessionId: string,
  itemIndices: number[],
  userId: string
): void {
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE line_items SET claimed_by_user_id = NULL WHERE session_id = ? AND item_index = ? AND claimed_by_user_id = ?"
  );
  const removeSplit = db.prepare(
    "DELETE FROM split_items WHERE session_id = ? AND line_item_index = ?"
  );
  const transaction = db.transaction(() => {
    for (const idx of itemIndices) {
      const result = stmt.run(sessionId, idx, userId);
      if (result.changes === 0) {
        throw new Error(
          `Item ${idx} is not claimed by you.`
        );
      }
      removeSplit.run(sessionId, idx);
    }
  });
  transaction();
}

export function editItemPrice(
  sessionId: string,
  itemIndex: number,
  newPrice: number,
): void {
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE line_items SET unit_price = ? WHERE session_id = ? AND item_index = ?",
    )
    .run(newPrice, sessionId, itemIndex);
  if (result.changes === 0) {
    throw new Error(`Item ${itemIndex} does not exist.`);
  }
}

export function addItem(
  sessionId: string,
  name: string,
  unitPrice: number,
  quantity: number,
): number[] {
  const db = getDb();
  const maxRow = db
    .prepare(
      "SELECT MAX(item_index) as max_idx FROM line_items WHERE session_id = ?",
    )
    .get(sessionId) as any;
  let nextIndex = (maxRow?.max_idx ?? 0) + 1;

  const stmt = db.prepare(
    "INSERT INTO line_items (session_id, item_index, name, unit_price, original_quantity, claimed_by_user_id) VALUES (?, ?, ?, ?, ?, NULL)",
  );

  const indices: number[] = [];
  const transaction = db.transaction(() => {
    for (let i = 1; i <= quantity; i++) {
      const itemName = quantity > 1 ? `${name} (${i} of ${quantity})` : name;
      stmt.run(sessionId, nextIndex, itemName, unitPrice, quantity);
      indices.push(nextIndex);
      nextIndex++;
    }
  });
  transaction();
  return indices;
}

export function removeItem(sessionId: string, itemIndex: number): void {
  const db = getDb();
  const transaction = db.transaction(() => {
    db.prepare(
      "DELETE FROM split_items WHERE session_id = ? AND line_item_index = ?",
    ).run(sessionId, itemIndex);
    const result = db
      .prepare(
        "DELETE FROM line_items WHERE session_id = ? AND item_index = ?",
      )
      .run(sessionId, itemIndex);
    if (result.changes === 0) {
      throw new Error(`Item ${itemIndex} does not exist.`);
    }
  });
  transaction();
}

// --- Splits ---

export function splitItem(
  sessionId: string,
  itemIndex: number,
  userIds: string[]
): void {
  const db = getDb();
  const item = db
    .prepare(
      "SELECT * FROM line_items WHERE session_id = ? AND item_index = ?"
    )
    .get(sessionId, itemIndex) as any;
  if (!item) throw new Error(`Item ${itemIndex} does not exist.`);

  const insertSplit = db.prepare(
    "INSERT OR REPLACE INTO split_items (session_id, line_item_index, user_id, share_count) VALUES (?, ?, ?, ?)"
  );
  const transaction = db.transaction(() => {
    // Mark the item as claimed by the first user (as the "owner" for display)
    db.prepare(
      "UPDATE line_items SET claimed_by_user_id = ? WHERE session_id = ? AND item_index = ?"
    ).run(userIds[0], sessionId, itemIndex);

    // Remove any existing splits for this item
    db.prepare(
      "DELETE FROM split_items WHERE session_id = ? AND line_item_index = ?"
    ).run(sessionId, itemIndex);

    for (const userId of userIds) {
      insertSplit.run(sessionId, itemIndex, userId, userIds.length);
      ensureUserPayment(sessionId, userId);
    }
  });
  transaction();
}

export function getSplitItems(sessionId: string): SplitEntry[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM split_items WHERE session_id = ?")
    .all(sessionId) as any[];
  return rows.map((r) => ({
    sessionId: r.session_id,
    lineItemIndex: r.line_item_index,
    userId: r.user_id,
    shareCount: r.share_count,
  }));
}

// --- Payments ---

function ensureUserPayment(sessionId: string, userId: string): void {
  const db = getDb();
  // Insert if not present; if already present and marked paid, reset to unpaid
  // so the user must pay again after claiming additional items.
  db.prepare(`
    INSERT INTO user_payments (session_id, user_id, paid) VALUES (?, ?, 0)
    ON CONFLICT(session_id, user_id) DO UPDATE SET paid = 0 WHERE paid = 1
  `).run(sessionId, userId);
}

export function markPaid(sessionId: string, userId: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE user_payments SET paid = 1 WHERE session_id = ? AND user_id = ?"
  ).run(sessionId, userId);
}

export function markUnpaid(sessionId: string, userId: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE user_payments SET paid = 0 WHERE session_id = ? AND user_id = ?"
  ).run(sessionId, userId);
}

export function getUserPayments(
  sessionId: string
): { userId: string; paid: boolean }[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM user_payments WHERE session_id = ?")
    .all(sessionId) as any[];
  return rows.map((r) => ({ userId: r.user_id, paid: !!r.paid }));
}

// --- Status ---

export function updateSessionStatus(
  sessionId: string,
  status: SessionStatus
): void {
  const db = getDb();
  db.prepare("UPDATE receipt_sessions SET status = ? WHERE id = ?").run(
    status,
    sessionId
  );
}

export function updateSummaryMessageId(
  sessionId: string,
  messageId: string
): void {
  const db = getDb();
  db.prepare(
    "UPDATE receipt_sessions SET summary_message_id = ? WHERE id = ?"
  ).run(messageId, sessionId);
}

export function addTaggedUser(sessionId: string, userId: string): void {
  const db = getDb();
  const row = db
    .prepare("SELECT tagged_user_ids FROM receipt_sessions WHERE id = ?")
    .get(sessionId) as any;
  if (!row) return;
  const ids: string[] = JSON.parse(row.tagged_user_ids);
  if (!ids.includes(userId)) {
    ids.push(userId);
    db.prepare("UPDATE receipt_sessions SET tagged_user_ids = ? WHERE id = ?").run(
      JSON.stringify(ids),
      sessionId
    );
  }
}

export function updateRestaurantName(sessionId: string, name: string): void {
  const db = getDb();
  db.prepare("UPDATE receipt_sessions SET restaurant_name = ? WHERE id = ?").run(
    name,
    sessionId,
  );
}

export function updateTip(sessionId: string, tipAmount: number): void {
  const db = getDb();
  db.prepare("UPDATE receipt_sessions SET tip_amount = ? WHERE id = ?").run(
    tipAmount,
    sessionId
  );
}

export function replaceSessionItems(
  sessionId: string,
  items: LineItem[],
  totals: {
    subtotal: number;
    discountAmount: number;
    taxAmount: number;
    tipAmount: number | null;
    total: number;
  },
): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM split_items WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM user_payments WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM line_items WHERE session_id = ?").run(sessionId);

    const insert = db.prepare(
      "INSERT INTO line_items (session_id, item_index, name, unit_price, original_quantity, claimed_by_user_id) VALUES (?, ?, ?, ?, ?, NULL)",
    );
    for (const item of items) {
      insert.run(
        sessionId,
        item.index,
        item.name,
        item.unitPrice,
        item.originalQuantity,
      );
    }

    db.prepare(
      "UPDATE receipt_sessions SET subtotal = ?, discount_amount = ?, tax_amount = ?, tip_amount = ?, total = ?, status = 'active' WHERE id = ?",
    ).run(
      totals.subtotal,
      totals.discountAmount,
      totals.taxAmount,
      totals.tipAmount,
      totals.total,
      sessionId,
    );
  });
  tx();
}

// --- Leaderboard / Stats ---

export function recordSettlement(
  guildId: string,
  restaurantName: string,
  userTotals: { userId: string; grandTotal: number }[]
): void {
  const db = getDb();

  const upsertRestaurant = db.prepare(`
    INSERT INTO restaurant_stats (guild_id, restaurant_name, total_spend, receipt_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(guild_id, restaurant_name) DO UPDATE SET
      total_spend = total_spend + excluded.total_spend,
      receipt_count = receipt_count + 1
  `);

  const upsertUser = db.prepare(`
    INSERT INTO user_stats (guild_id, user_id, total_spend)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      total_spend = total_spend + excluded.total_spend
  `);

  const receiptTotal = userTotals.reduce((sum, u) => sum + u.grandTotal, 0);

  const transaction = db.transaction(() => {
    upsertRestaurant.run(guildId, restaurantName, receiptTotal);
    for (const ut of userTotals) {
      if (ut.grandTotal > 0) {
        upsertUser.run(guildId, ut.userId, ut.grandTotal);
      }
    }
  });
  transaction();
}

export function getTopRestaurants(
  guildId: string,
  limit = 5
): { restaurantName: string; totalSpend: number; receiptCount: number }[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT restaurant_name, total_spend, receipt_count FROM restaurant_stats WHERE guild_id = ? ORDER BY total_spend DESC LIMIT ?"
    )
    .all(guildId, limit) as any[];
  return rows.map((r) => ({
    restaurantName: r.restaurant_name,
    totalSpend: r.total_spend,
    receiptCount: r.receipt_count,
  }));
}

export function getTopUsers(
  guildId: string,
  limit = 5
): { userId: string; totalSpend: number }[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT user_id, total_spend FROM user_stats WHERE guild_id = ? ORDER BY total_spend DESC LIMIT ?"
    )
    .all(guildId, limit) as any[];
  return rows.map((r) => ({ userId: r.user_id, totalSpend: r.total_spend }));
}

// --- API spend limit ---

const DAILY_LIMIT_USD = 0.10;

export function getDailyApiCost(date: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT estimated_cost_usd FROM api_cost_log WHERE date = ?")
    .get(date) as any;
  return row?.estimated_cost_usd ?? 0;
}

export function addApiCost(date: string, costUsd: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO api_cost_log (date, estimated_cost_usd) VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET estimated_cost_usd = estimated_cost_usd + excluded.estimated_cost_usd
  `).run(date, costUsd);
}

export function checkDailyLimit(): void {
  const today = new Date().toISOString().slice(0, 10);
  const used = getDailyApiCost(today);
  if (used >= DAILY_LIMIT_USD) {
    throw new Error(
      `Daily API spend limit reached ($${DAILY_LIMIT_USD.toFixed(2)}/day). Used: $${used.toFixed(4)}. Resets at midnight UTC.`
    );
  }
}

export function getUnpaidSessionsForUser(
  guildId: string,
  userId: string
): ReceiptSession[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT rs.* FROM receipt_sessions rs
       JOIN user_payments up ON up.session_id = rs.id
       WHERE rs.guild_id = ? AND rs.status != 'settled' AND up.user_id = ? AND up.paid = 0`
    )
    .all(guildId, userId) as any[];
  return rows.map(rowToSession);
}

// --- Helpers ---

function rowToSession(row: any): ReceiptSession {
  return {
    id: row.id,
    threadId: row.thread_id,
    originalMessageId: row.original_message_id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    primaryUserId: row.primary_user_id,
    restaurantName: row.restaurant_name,
    subtotal: row.subtotal,
    discountAmount: row.discount_amount ?? 0,
    taxAmount: row.tax_amount,
    tipAmount: row.tip_amount,
    total: row.total,
    status: row.status as SessionStatus,
    summaryMessageId: row.summary_message_id,
    taggedUserIds: JSON.parse(row.tagged_user_ids),
    createdAt: row.created_at,
  };
}
