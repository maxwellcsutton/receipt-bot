import { Client } from "discord.js";

export function registerReadyEvent(client: Client): void {
  client.once("ready", () => {
    console.log(`Receipt Bot online as ${client.user?.tag}`);
  });
}
