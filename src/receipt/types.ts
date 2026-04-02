export interface ParsedReceiptItem {
  name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
}

export interface ParsedReceipt {
  items: ParsedReceiptItem[];
  subtotal: number;
  discount: number;
  tax: number;
  tip: number | null;
  total: number;
}

export interface LineItem {
  index: number;
  name: string;
  unitPrice: number;
  originalQuantity: number;
  claimedByUserId: string | null;
}

export interface SplitEntry {
  sessionId: string;
  lineItemIndex: number;
  userId: string;
  shareCount: number;
}

export type SessionStatus = "active" | "all_claimed" | "settled";

export interface ReceiptSession {
  id: string;
  threadId: string;
  originalMessageId: string;
  channelId: string;
  guildId: string;
  primaryUserId: string;
  restaurantName: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  tipAmount: number | null;
  total: number;
  status: SessionStatus;
  summaryMessageId: string | null;
  taggedUserIds: string[];
  createdAt: string;
}

export interface UserTotal {
  userId: string;
  itemsTotal: number;
  taxShare: number;
  tipShare: number;
  grandTotal: number;
  items: { index: number; name: string; amount: number }[];
}
