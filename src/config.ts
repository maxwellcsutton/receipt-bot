import dotenv from "dotenv";
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const DEFAULT_MODIFIER_PREFIXES = "add ,extra ,side ,sub ,w/ ,with ,no ";

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  databasePath: process.env.DATABASE_PATH || "./data/receipts.db",
  modifierPrefixes: (process.env.MODIFIER_PREFIXES ?? DEFAULT_MODIFIER_PREFIXES)
    .split(",")
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 0),
};
