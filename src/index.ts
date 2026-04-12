import { config } from "./config.js";
import { createClient } from "./bot/client.js";
import { registerReadyEvent } from "./bot/events/ready.js";
import { registerMessageCreateEvent } from "./bot/events/messageCreate.js";
import { initDatabase } from "./session/migrations.js";

const client = createClient();

initDatabase();
registerReadyEvent(client);
registerMessageCreateEvent(client);

client.login(config.discordToken).catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});
