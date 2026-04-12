import http from "http";
import { config } from "./config.js";
import { createClient } from "./bot/client.js";
import { registerReadyEvent } from "./bot/events/ready.js";
import { registerMessageCreateEvent } from "./bot/events/messageCreate.js";
import { initDatabase } from "./session/migrations.js";

// Health check server for Railway
const port = process.env.PORT || 3000;
http
  .createServer((_req, res) => {
    res.writeHead(200);
    res.end("OK");
  })
  .listen(port, () => {
    console.log(`Health check listening on port ${port}`);
  });

const client = createClient();

initDatabase();
registerReadyEvent(client);
registerMessageCreateEvent(client);

client.login(config.discordToken).catch((err) => {
  console.error("Failed to login:", err);
  process.exit(1);
});
