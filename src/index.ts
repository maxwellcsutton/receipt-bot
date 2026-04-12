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

client.on("error", (err) => console.error("Client error:", err));
client.on("warn", (msg) => console.warn("Client warn:", msg));
client.on("debug", (msg) => {
  if (msg.includes("Heartbeat") || msg.includes("Session")) return;
  console.log("Client debug:", msg);
});
client.on("invalidated", () => console.error("Session invalidated"));

console.log("Calling client.login()...");
client
  .login(config.discordToken)
  .then(() => console.log("login() resolved"))
  .catch((err) => {
    console.error("Failed to login:", err);
    process.exit(1);
  });
