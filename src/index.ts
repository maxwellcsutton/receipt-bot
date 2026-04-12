console.log("Bot process starting...");

import { config } from "./config.js";
import { createClient } from "./bot/client.js";
import { registerReadyEvent } from "./bot/events/ready.js";
import { registerMessageCreateEvent } from "./bot/events/messageCreate.js";
import { initDatabase } from "./session/migrations.js";

try {
  console.log("Creating client...");
  const client = createClient();

  console.log("Initializing database...");
  initDatabase();

  console.log("Registering events...");
  registerReadyEvent(client);
  registerMessageCreateEvent(client);

  console.log("Logging in...");
  console.log(
    `Token starts with: ${config.discordToken.slice(0, 10)}...`,
  );

  client.on("error", (err) => {
    console.error("Client error:", err);
  });

  client.login(config.discordToken).catch((err) => {
    console.error("Failed to login:", err);
    process.exit(1);
  });
} catch (err) {
  console.error("Fatal startup error:", err);
  process.exit(1);
}
