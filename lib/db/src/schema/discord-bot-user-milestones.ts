import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { discordBotUsers } from "./discord-bot-users.js";

export const discordBotUserMilestones = pgTable(
  "discord_bot_user_milestones",
  {
    discordUserId: text("discord_user_id").notNull(),
    milestoneId: text("milestone_id").notNull(),
    requiredVoiceTimeSeconds: bigint("required_voice_time_seconds", {
      mode: "number",
    }).notNull(),
    roleId: text("role_id"),
    currencyRewardAmount: bigint("currency_reward_amount", { mode: "number" }),
    reachedAt: timestamp("reached_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    roleStatus: text("role_status").notNull().default("pending"),
    roleGrantedAt: timestamp("role_granted_at", { withTimezone: true }),
    rewardStatus: text("reward_status").notNull().default("pending"),
    rewardProcessingAt: timestamp("reward_processing_at", {
      withTimezone: true,
    }),
    rewardAttempts: integer("reward_attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    rewardLastError: text("reward_last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "discord_bot_user_milestones_pk",
      columns: [table.discordUserId, table.milestoneId],
    }),
    foreignKey({
      name: "discord_bot_user_milestones_user_fk",
      columns: [table.discordUserId],
      foreignColumns: [discordBotUsers.discordUserId],
    }).onDelete("cascade"),
    check(
      "discord_bot_user_milestones_required_time_nonnegative",
      sql`${table.requiredVoiceTimeSeconds} >= 0`,
    ),
    check(
      "discord_bot_user_milestones_reward_nonnegative",
      sql`${table.currencyRewardAmount} IS NULL OR ${table.currencyRewardAmount} >= 0`,
    ),
    check(
      "discord_bot_user_milestones_role_status_valid",
      sql`${table.roleStatus} IN ('pending', 'granted', 'superseded', 'unconfigured', 'missing', 'member_not_found', 'failed')`,
    ),
    check(
      "discord_bot_user_milestones_reward_status_valid",
      sql`${table.rewardStatus} IN ('pending', 'processing', 'deferred', 'issued', 'failed')`,
    ),
    check(
      "discord_bot_user_milestones_reward_attempts_nonnegative",
      sql`${table.rewardAttempts} >= 0`,
    ),
    index("discord_bot_user_milestones_reward_status_idx").on(
      table.rewardStatus,
      table.rewardProcessingAt,
    ),
  ],
);

export type DiscordBotUserMilestone =
  typeof discordBotUserMilestones.$inferSelect;
export type NewDiscordBotUserMilestone =
  typeof discordBotUserMilestones.$inferInsert;
