import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { discordBotUsers } from "./discord-bot-users.js";

export const discordBotVoiceSessions = pgTable(
  "discord_bot_voice_sessions",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    discordUserId: text("discord_user_id")
      .notNull()
      .references(() => discordBotUsers.discordUserId, { onDelete: "cascade" }),
    voiceChannelId: text("voice_channel_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    active: boolean("active").notNull().default(true),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Heartbeat: refreshed about once a minute while the session is active, so a
    // crash or restart only loses the time since the last heartbeat.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => [
    index("discord_bot_voice_sessions_user_started_idx").on(
      table.discordUserId,
      table.startedAt,
    ),
    uniqueIndex("discord_bot_one_active_voice_session_per_user_idx")
      .on(table.discordUserId)
      .where(sql`${table.active} = true`),
    check(
      "discord_bot_voice_sessions_end_state_consistency",
      sql`(${table.active} = true AND ${table.endedAt} IS NULL) OR (${table.active} = false AND ${table.endedAt} IS NOT NULL)`,
    ),
  ],
);

export type DiscordBotVoiceSession =
  typeof discordBotVoiceSessions.$inferSelect;
export type NewDiscordBotVoiceSession =
  typeof discordBotVoiceSessions.$inferInsert;
