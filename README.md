# Receipt Bot

A Discord bot that splits restaurant receipts among users. Post a receipt photo, and the bot uses Claude AI to extract line items. Users claim their items, and the bot calculates each person's share including proportional tax and tip.

## Features

- **AI-powered receipt reading** — Claude Vision extracts line items, tax, tip, and totals from receipt photos
- **Item claiming** — Users claim items by number with support for ranges (`1-3, 5`)
- **Item splitting** — Split shared items between multiple users (`split 3 @alice @bob`)
- **Proportional tax/tip** — Each user's tax and tip is calculated based on their share of the subtotal
- **Payment tracking** — Users mark themselves as paid; bot notifies when all payments are received
- **Concurrent receipts** — Each receipt gets its own Discord thread, so multiple receipts can run simultaneously
- **Persistent storage** — SQLite database survives bot restarts

## Quick Start

```bash
# 1. Clone and install
git clone <your-repo-url>
cd receipt-bot
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your tokens (see Setup section below)

# 3. Run in development mode
bash dev.sh
```

## Setup

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name, and create it
3. Go to the **Bot** tab and click **Add Bot**
4. Enable **Message Content Intent** under Privileged Gateway Intents — this is required for the bot to read message text
5. Copy the **Bot Token** — you'll need this for your `.env` file

### 2. Invite the Bot to Your Server

1. In the Developer Portal, go to **OAuth2 > URL Generator**
2. Under **Scopes**, select `bot`
3. Under **Bot Permissions**, select:
   - Send Messages
   - Send Messages in Threads
   - Create Public Threads
   - Read Message History
   - Add Reactions
   - Manage Messages
   - Embed Links
4. Copy the generated URL and open it in your browser
5. Select your server and authorize the bot

### 3. Get an Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an account or sign in
3. Generate an API key
4. The bot uses Claude Haiku 4.5 for receipt parsing — cost is approximately $0.01 per receipt

### 4. Configure Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
DISCORD_TOKEN=your_discord_bot_token
ANTHROPIC_API_KEY=your_anthropic_api_key
MONITORED_CHANNEL_IDS=channel_id_1,channel_id_2
DATABASE_PATH=./data/receipts.db
```

To get a channel ID: enable **Developer Mode** in Discord settings (App Settings > Advanced), then right-click the channel and select **Copy Channel ID**.

## Usage

### Starting a Receipt

In a monitored channel, post a message with:
- A receipt photo (JPEG, PNG, GIF, or WebP)
- An `@mention` of the bot
- `@mentions` of all users splitting the receipt
- The restaurant name as text

**Example:**
```
@ReceiptBot @alice @bob Sakura Sushi
[attached receipt photo]
```

The bot will:
1. Create a thread for this receipt
2. Parse the receipt using Claude AI
3. Post numbered line items with a command reference

### Claiming Items

Reply in the receipt thread with item numbers:

```
1, 3, 5          # claim specific items
1-3               # claim a range
1-3, 7            # mix ranges and specific numbers
```

The bot replies with your calculated total (items + proportional tax + tip).

### Splitting Items

To split a shared item between users:

```
split 3 @alice @bob
```

The item price is divided equally among all mentioned users (including yourself).

### Setting the Tip

Only the primary user (who posted the receipt) can set the tip:

```
tip 20%           # percentage of subtotal
tip 15.00         # flat dollar amount
tip 0             # no tip
```

If no tip is detected on the receipt, the bot will prompt for one.

### Unclaiming Items

To release items you've claimed:

```
unclaim 1, 3
```

### Marking as Paid

Once you've paid the primary user:

```
paid
```

### Settlement

When all items are claimed and all users are marked as paid, the bot sends a final message notifying the primary user that all payments have been received.

## Commands Reference

| Command | Description |
|---------|-------------|
| `1, 3, 5` or `1-3` | Claim items by number |
| `unclaim 1, 3` | Release claimed items |
| `split 3 @user1 @user2` | Split an item between users |
| `tip 20%` or `tip 15.00` | Set tip (primary user only) |
| `tip 0` | Skip tip |
| `paid` | Mark yourself as paid |

## Deployment

### Local Development

```bash
bash dev.sh
```

This runs the bot with hot reload via `tsx watch`. The script checks for `.env` and required variables before starting.

### Production (Railway)

1. Install the [Railway CLI](https://docs.railway.com/guides/cli):
   ```bash
   npm install -g @railway/cli
   railway login
   ```

2. Create a project:
   ```bash
   railway init
   ```

3. In the Railway dashboard:
   - Add your environment variables (`DISCORD_TOKEN`, `ANTHROPIC_API_KEY`, `MONITORED_CHANNEL_IDS`)
   - Add a persistent volume mounted at `/app/data` (for the SQLite database)

4. Deploy:
   ```bash
   bash deploy.sh
   ```

### Production (Docker)

```bash
# Build
npm run build
docker build -t receipt-bot .

# Run
docker run -d \
  --env-file .env \
  -v receipt-data:/app/data \
  receipt-bot
```

## Project Structure

```
src/
  index.ts              — Entry point
  config.ts             — Environment variable loading
  bot/
    client.ts           — Discord client setup
    events/
      messageCreate.ts  — Main message handler (receipts, claims, payments)
      ready.ts          — Bot ready event
  receipt/
    parser.ts           — Claude Vision API receipt extraction
    formatter.ts        — Discord embed/message formatting
    calculator.ts       — Proportional tax/tip math
    types.ts            — TypeScript interfaces
  session/
    manager.ts          — Session business logic
    store.ts            — SQLite CRUD operations
    migrations.ts       — Database schema
  utils/
    discord.ts          — Mention parsing, display name resolution
```

## How Tax and Tip Are Calculated

Each user's share is proportional to their claimed items relative to the receipt subtotal:

```
userShare    = userItemsTotal / receiptSubtotal
userTax      = taxAmount  × userShare
userTip      = tipAmount  × userShare
userTotal    = userItemsTotal + userTax + userTip  (rounded to nearest cent)
```

For split items, each user's portion is `itemPrice / numberOfUsers`.

Rounding may cause the sum of all user totals to differ from the receipt total by 1-2 cents.
