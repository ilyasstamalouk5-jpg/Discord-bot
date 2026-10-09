CREATE TABLE "discord_bot_users" (
	"discord_user_id" text PRIMARY KEY NOT NULL,
	"total_voice_time_seconds" bigint DEFAULT 0 NOT NULL,
	"current_milestone" text,
	"claimed_milestones" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"total_xp" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_bot_users_voice_time_nonnegative" CHECK ("discord_bot_users"."total_voice_time_seconds" >= 0),
	CONSTRAINT "discord_bot_users_xp_nonnegative" CHECK ("discord_bot_users"."total_xp" >= 0)
);
--> statement-breakpoint
CREATE TABLE "discord_bot_voice_sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "discord_bot_voice_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"discord_user_id" text NOT NULL,
	"voice_channel_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "discord_bot_voice_sessions_end_state_consistency" CHECK (("discord_bot_voice_sessions"."active" = true AND "discord_bot_voice_sessions"."ended_at" IS NULL) OR ("discord_bot_voice_sessions"."active" = false AND "discord_bot_voice_sessions"."ended_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "discord_bot_user_milestones" (
	"discord_user_id" text NOT NULL,
	"milestone_id" text NOT NULL,
	"required_voice_time_seconds" bigint NOT NULL,
	"role_id" text,
	"currency_reward_amount" bigint,
	"reached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role_status" text DEFAULT 'pending' NOT NULL,
	"role_granted_at" timestamp with time zone,
	"reward_status" text DEFAULT 'pending' NOT NULL,
	"reward_processing_at" timestamp with time zone,
	"reward_attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"reward_last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_bot_user_milestones_pk" PRIMARY KEY("discord_user_id","milestone_id"),
	CONSTRAINT "discord_bot_user_milestones_required_time_nonnegative" CHECK ("discord_bot_user_milestones"."required_voice_time_seconds" >= 0),
	CONSTRAINT "discord_bot_user_milestones_reward_nonnegative" CHECK ("discord_bot_user_milestones"."currency_reward_amount" IS NULL OR "discord_bot_user_milestones"."currency_reward_amount" >= 0),
	CONSTRAINT "discord_bot_user_milestones_role_status_valid" CHECK ("discord_bot_user_milestones"."role_status" IN ('pending', 'granted', 'superseded', 'unconfigured', 'missing', 'member_not_found', 'failed')),
	CONSTRAINT "discord_bot_user_milestones_reward_status_valid" CHECK ("discord_bot_user_milestones"."reward_status" IN ('pending', 'processing', 'deferred', 'issued', 'failed')),
	CONSTRAINT "discord_bot_user_milestones_reward_attempts_nonnegative" CHECK ("discord_bot_user_milestones"."reward_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "discord_bot_voice_sessions" ADD CONSTRAINT "discord_bot_voice_sessions_discord_user_id_discord_bot_users_discord_user_id_fk" FOREIGN KEY ("discord_user_id") REFERENCES "public"."discord_bot_users"("discord_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_bot_user_milestones" ADD CONSTRAINT "discord_bot_user_milestones_user_fk" FOREIGN KEY ("discord_user_id") REFERENCES "public"."discord_bot_users"("discord_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discord_bot_voice_sessions_user_started_idx" ON "discord_bot_voice_sessions" USING btree ("discord_user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_bot_one_active_voice_session_per_user_idx" ON "discord_bot_voice_sessions" USING btree ("discord_user_id") WHERE "discord_bot_voice_sessions"."active" = true;--> statement-breakpoint
CREATE INDEX "discord_bot_user_milestones_reward_status_idx" ON "discord_bot_user_milestones" USING btree ("reward_status","reward_processing_at");