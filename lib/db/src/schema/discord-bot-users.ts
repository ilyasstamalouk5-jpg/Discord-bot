import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const discordBotUsers = pgTable(
  "discord_bot_users",
  {
    discordUserId: text("discord_user_id").primaryKey(),
    totalVoiceTimeSeconds: bigint("total_voice_time_seconds", {
      mode: "number",
    })
      .notNull()
      .default(0),
    currentMilestone: text("current_milestone"),
    claimedMilestones: text("claimed_milestones")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    totalXp: bigint("total_xp", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "discord_bot_users_voice_time_nonnegative",
      sql`${table.totalVoiceTimeSeconds} >= 0`,
    ),
    check("discord_bot_users_xp_nonnegative", sql`${table.totalXp} >= 0`),
  ],
);

export type DiscordBotUser = typeof discordBotUsers.$inferSelect;
export type NewDiscordBotUser = typeof discordBotUsers.$inferInsert;
