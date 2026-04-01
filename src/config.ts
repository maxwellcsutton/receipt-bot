import dotenv from "dotenv";
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  databasePath: process.env.DATABASE_PATH || "./data/receipts.db",
};
