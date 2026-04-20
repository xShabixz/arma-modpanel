import { buildServer } from "./server.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  const app = await buildServer();

  try {
    await app.listen({
      port: config.PORT,
      host: config.HOST
    });
  } catch (error) {
    app.log.error(error, "Failed to start server");
    process.exit(1);
  }
}

main();
