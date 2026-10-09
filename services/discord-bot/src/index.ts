import { logger } from "./config/logger.js";
import { startBot } from "./bot/start.js";

void startBot().catch((error) => {
  logger.fatal({ err: error }, "Unexpected bot startup error.");
  process.exitCode = 1;
});
