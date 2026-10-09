import { Client, Events } from "discord.js";
import {
  handleVoiceCommand,
  registerVoiceSlashCommands,
} from "../commands/voice-commands.js";
import { config } from "../config/index.js";
import { logger } from "../config/logger.js";
import { DrizzleMilestoneStore } from "../database/milestone-store.js";
import { MilestoneManager } from "../milestones/milestone-manager.js";
import {
  DiscordMilestoneRoleOperations,
  MilestoneRoleManager,
} from "../milestones/role-manager.js";
import { RewardManager } from "../rewards/reward-manager.js";
import { UnconfiguredCurrencyRewardProvider } from "../rewards/currency-reward-provider.js";

function addProcessHandlers(
  client: Client,
  stopMilestones: () => Promise<void>,
  stopVoiceTracking: () => Promise<void>,
  closeDatabase: () => Promise<void>,
): void {
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      client.destroy();
      await stopMilestones();
      await stopVoiceTracking();
      await closeDatabase();
    })();
    return cleanupPromise;
  };

  const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    logger.info({ signal }, "Shutting down Discord client.");
    void cleanup()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error) => {
        logger.error({ err: error }, "Graceful bot shutdown did not complete cleanly.");
        process.exitCode = 1;
      });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("unhandledRejection", () => {
    logger.fatal("Unhandled promise rejection. Shutting down.");
    void cleanup().finally(() => process.exit(1));
  });
  process.once("uncaughtException", () => {
    logger.fatal("Unexpected uncaught exception. Shutting down.");
    void cleanup().finally(() => process.exit(1));
  });
}

export async function startBot(): Promise<void> {
  const token = config.discord.token;

  if (!token) {
    logger.fatal(
      "DISCORD_TOKEN is missing. Add it to your host's environment variables, then restart the bot.",
    );
    process.exitCode = 1;
    return;
  }

  let database: typeof import("../database/index.js");
  try {
    database = await import("../database/index.js");
    await database.applyMigrations();
    await database.initializeDatabase();
  } catch (error) {
    logger.fatal(
      { err: error },
      "Database initialization failed. Verify DATABASE_URL (it must be set and reachable).",
    );
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    intents: [...config.discord.intents],
  });
  const { VoiceSessionTracker } = await import("../voice/voice-tracker.js");
  const voiceTracker = new VoiceSessionTracker(client, database);
  voiceTracker.attach();

  const milestoneStore = new DrizzleMilestoneStore();
  const milestoneRoleManager = new MilestoneRoleManager(
    new DiscordMilestoneRoleOperations(client, config.milestones.guildId),
    config.milestones.definitions,
  );
  const rewardManager = new RewardManager(
    milestoneStore,
    new UnconfiguredCurrencyRewardProvider(),
  );
  const milestoneManager = new MilestoneManager(
    milestoneStore,
    milestoneRoleManager,
    rewardManager,
    config.milestones.definitions,
    config.milestones.checkIntervalMs,
  );

  client.once(Events.ClientReady, () => {
    logger.info("Discord bot connected successfully.");
    void (async () => {
      await voiceTracker.waitForRecovery();
      try {
        await registerVoiceSlashCommands(client);
      } catch (error) {
        logger.error(
          { err: error },
          "Voice-time slash commands could not be registered.",
        );
      }
      await milestoneManager.start();
    })().catch((error) => {
      logger.error(
        { err: error },
        "Voice-time milestone checks could not be started.",
      );
    });
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client connection error.");
  });

  client.on(Events.ShardError, (error) => {
    logger.error({ err: error }, "Discord gateway connection error.");
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) {
      void handleVoiceCommand(interaction);
    }
  });

  addProcessHandlers(
    client,
    () => milestoneManager.stop(),
    () => voiceTracker.stop(),
    database.closeDatabase,
  );

  try {
    await client.login(token);
  } catch (error) {
    logger.fatal(
      { err: error },
      "Discord login failed. Check that DISCORD_TOKEN is set correctly in your host's environment variables.",
    );
    client.destroy();
    await milestoneManager.stop();
    await voiceTracker.stop();
    await database.closeDatabase();
    process.exitCode = 1;
  }
}
