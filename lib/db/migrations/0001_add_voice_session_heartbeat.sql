ALTER TABLE "discord_bot_voice_sessions" ADD COLUMN "last_seen_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "discord_bot_voice_sessions" SET "last_seen_at" = COALESCE("ended_at", "started_at") WHERE "last_seen_at" IS NULL;