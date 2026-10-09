import { db } from "@workspace/db";
import {
  discordBotUserMilestones,
  discordBotUsers,
  discordBotVoiceSessions,
} from "@workspace/db";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { logger } from "../config/logger.js";
import type {
  MilestoneDefinition,
  MilestoneProgressRecord,
  MilestoneRewardStatus,
  MilestoneRoleStatus,
  MilestoneStore,
  UserVoiceProgress,
} from "../milestones/types.js";

function asRecord(
  row: typeof discordBotUserMilestones.$inferSelect,
): MilestoneProgressRecord {
  return {
    discordUserId: row.discordUserId,
    milestoneId: row.milestoneId,
    requiredVoiceTimeSeconds: row.requiredVoiceTimeSeconds,
    roleId: row.roleId,
    currencyRewardAmount: row.currencyRewardAmount,
    reachedAt: row.reachedAt,
    roleStatus: row.roleStatus as MilestoneRoleStatus,
    roleGrantedAt: row.roleGrantedAt,
    rewardStatus: row.rewardStatus as MilestoneRewardStatus,
    rewardProcessingAt: row.rewardProcessingAt,
    rewardAttempts: row.rewardAttempts,
    claimedAt: row.claimedAt,
    rewardLastError: row.rewardLastError,
  };
}

export class DrizzleMilestoneStore implements MilestoneStore {
  async getAllVoiceProgress(): Promise<UserVoiceProgress[]> {
    try {
      const rows = await db
        .select({
          discordUserId: discordBotUsers.discordUserId,
          totalVoiceTimeSeconds: discordBotUsers.totalVoiceTimeSeconds,
          activeSessionStartedAt: discordBotVoiceSessions.startedAt,
        })
        .from(discordBotUsers)
        .leftJoin(
          discordBotVoiceSessions,
          and(
            eq(
              discordBotVoiceSessions.discordUserId,
              discordBotUsers.discordUserId,
            ),
            eq(discordBotVoiceSessions.active, true),
          ),
        )
        .orderBy(asc(discordBotUsers.discordUserId));

      return rows.map((row) => ({
        discordUserId: row.discordUserId,
        totalVoiceTimeSeconds: row.totalVoiceTimeSeconds,
        activeSessionStartedAt: row.activeSessionStartedAt,
      }));
    } catch {
      logger.error("Could not load accumulated voice-time progress.");
      throw new Error("Could not load accumulated voice-time progress.");
    }
  }

  async getMilestoneProgress(
    discordUserId: string,
  ): Promise<MilestoneProgressRecord[]> {
    try {
      const rows = await db
        .select()
        .from(discordBotUserMilestones)
        .where(eq(discordBotUserMilestones.discordUserId, discordUserId));
      return rows.map(asRecord);
    } catch {
      logger.error("Could not load a user's milestone progress.");
      throw new Error("Could not load a user's milestone progress.");
    }
  }

  async recordReachedMilestones(
    discordUserId: string,
    milestones: readonly MilestoneDefinition[],
    reachedAt: Date,
  ): Promise<void> {
    try {
      await db.transaction(async (transaction) => {
        await transaction
          .insert(discordBotUsers)
          .values({ discordUserId })
          .onConflictDoNothing({
            target: discordBotUsers.discordUserId,
          });

        for (const milestone of milestones) {
          await transaction
            .insert(discordBotUserMilestones)
            .values({
              discordUserId,
              milestoneId: milestone.id,
              requiredVoiceTimeSeconds: milestone.requiredVoiceTimeSeconds,
              roleId: milestone.roleId,
              currencyRewardAmount: milestone.currencyRewardAmount,
              reachedAt,
            })
            .onConflictDoUpdate({
              target: [
                discordBotUserMilestones.discordUserId,
                discordBotUserMilestones.milestoneId,
              ],
              set: {
                requiredVoiceTimeSeconds:
                  milestone.requiredVoiceTimeSeconds,
                roleId: milestone.roleId,
                roleStatus: sql`CASE
                  WHEN ${discordBotUserMilestones.roleId} IS DISTINCT FROM ${milestone.roleId}
                    THEN 'pending'
                  ELSE ${discordBotUserMilestones.roleStatus}
                END`,
                roleGrantedAt: sql`CASE
                  WHEN ${discordBotUserMilestones.roleId} IS DISTINCT FROM ${milestone.roleId}
                    THEN NULL
                  ELSE ${discordBotUserMilestones.roleGrantedAt}
                END`,
                currencyRewardAmount: sql`CASE
                  WHEN ${discordBotUserMilestones.rewardStatus} = 'issued'
                    THEN ${discordBotUserMilestones.currencyRewardAmount}
                  ELSE ${milestone.currencyRewardAmount}
                END`,
                updatedAt: reachedAt,
              },
            });
        }

        const highest = milestones.at(-1);
        if (!highest) {
          return;
        }

        const [user] = await transaction
          .select({ currentMilestone: discordBotUsers.currentMilestone })
          .from(discordBotUsers)
          .where(eq(discordBotUsers.discordUserId, discordUserId))
          .limit(1);
        const [candidate] = await transaction
          .select({
            requiredVoiceTimeSeconds:
              discordBotUserMilestones.requiredVoiceTimeSeconds,
          })
          .from(discordBotUserMilestones)
          .where(
            and(
              eq(discordBotUserMilestones.discordUserId, discordUserId),
              eq(discordBotUserMilestones.milestoneId, highest.id),
            ),
          )
          .limit(1);

        if (!user || !candidate) {
          throw new Error("Reached milestone was not persisted.");
        }

        let currentRank = -1;
        if (user.currentMilestone) {
          const [current] = await transaction
            .select({
              requiredVoiceTimeSeconds:
                discordBotUserMilestones.requiredVoiceTimeSeconds,
            })
            .from(discordBotUserMilestones)
            .where(
              and(
                eq(discordBotUserMilestones.discordUserId, discordUserId),
                eq(
                  discordBotUserMilestones.milestoneId,
                  user.currentMilestone,
                ),
              ),
            )
            .limit(1);
          currentRank = current?.requiredVoiceTimeSeconds ?? -1;
        }
        const candidateRank = candidate.requiredVoiceTimeSeconds;

        if (!user.currentMilestone || candidateRank >= currentRank) {
          await transaction
            .update(discordBotUsers)
            .set({
              currentMilestone: highest.id,
              updatedAt: reachedAt,
            })
            .where(eq(discordBotUsers.discordUserId, discordUserId));
        }
      });
    } catch {
      logger.error("Could not persist reached voice-time milestones.");
      throw new Error("Could not persist reached voice-time milestones.");
    }
  }

  async updateMilestoneRoleStatus(
    discordUserId: string,
    milestoneId: string,
    status: MilestoneRoleStatus,
    roleGrantedAt?: Date,
  ): Promise<void> {
    try {
      await db
        .update(discordBotUserMilestones)
        .set({
          roleStatus: status,
          roleGrantedAt:
            status === "granted"
              ? roleGrantedAt ?? new Date()
              : discordBotUserMilestones.roleGrantedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(discordBotUserMilestones.discordUserId, discordUserId),
            eq(discordBotUserMilestones.milestoneId, milestoneId),
          ),
        );
    } catch {
      logger.error("Could not persist milestone role status.");
      throw new Error("Could not persist milestone role status.");
    }
  }

  async getRewardCandidates(
    discordUserId: string,
    retryDeferred: boolean,
    staleProcessingBefore: Date,
  ): Promise<MilestoneProgressRecord[]> {
    const candidateStatuses = [
      eq(discordBotUserMilestones.rewardStatus, "pending"),
      ...(retryDeferred
        ? [eq(discordBotUserMilestones.rewardStatus, "failed")]
        : []),
      and(
        eq(discordBotUserMilestones.rewardStatus, "processing"),
        or(
          isNull(discordBotUserMilestones.rewardProcessingAt),
          lt(
            discordBotUserMilestones.rewardProcessingAt,
            staleProcessingBefore,
          ),
        ),
      ),
      ...(retryDeferred
        ? [eq(discordBotUserMilestones.rewardStatus, "deferred")]
        : []),
    ];

    try {
      const rows = await db
        .select()
        .from(discordBotUserMilestones)
        .where(
          and(
            eq(discordBotUserMilestones.discordUserId, discordUserId),
            or(...candidateStatuses),
          ),
        )
        .orderBy(asc(discordBotUserMilestones.requiredVoiceTimeSeconds));
      return rows.map(asRecord);
    } catch {
      logger.error("Could not load pending milestone reward events.");
      throw new Error("Could not load pending milestone reward events.");
    }
  }

  async claimMilestoneReward(
    discordUserId: string,
    milestoneId: string,
    claimedAt: Date,
    retryDeferred: boolean,
    staleProcessingBefore: Date,
  ): Promise<MilestoneProgressRecord | null> {
    const claimableStatuses = [
      eq(discordBotUserMilestones.rewardStatus, "pending"),
      and(
        eq(discordBotUserMilestones.rewardStatus, "processing"),
        or(
          isNull(discordBotUserMilestones.rewardProcessingAt),
          lt(
            discordBotUserMilestones.rewardProcessingAt,
            staleProcessingBefore,
          ),
        ),
      ),
      ...(retryDeferred
        ? [
            eq(discordBotUserMilestones.rewardStatus, "deferred"),
            eq(discordBotUserMilestones.rewardStatus, "failed"),
          ]
        : []),
    ];

    try {
      return await db.transaction(async (transaction) => {
        const [claimed] = await transaction
          .update(discordBotUserMilestones)
          .set({
            rewardStatus: "processing",
            rewardProcessingAt: claimedAt,
            rewardAttempts: sql`${discordBotUserMilestones.rewardAttempts} + 1`,
            rewardLastError: null,
            updatedAt: claimedAt,
          })
          .where(
            and(
              eq(discordBotUserMilestones.discordUserId, discordUserId),
              eq(discordBotUserMilestones.milestoneId, milestoneId),
              or(...claimableStatuses),
            ),
          )
          .returning();

        if (!claimed) {
          return null;
        }

        return asRecord(claimed);
      });
    } catch {
      logger.error("Could not claim a milestone reward event.");
      throw new Error("Could not claim a milestone reward event.");
    }
  }

  async completeMilestoneReward(
    discordUserId: string,
    milestoneId: string,
    status: Extract<MilestoneRewardStatus, "deferred" | "issued" | "failed">,
    completedAt: Date,
    error?: string,
  ): Promise<void> {
    try {
      await db.transaction(async (transaction) => {
        const [completed] = await transaction
          .update(discordBotUserMilestones)
          .set({
            rewardStatus: status,
            rewardProcessingAt: null,
            rewardLastError: error?.slice(0, 1_000) ?? null,
            claimedAt:
              status === "failed"
                ? discordBotUserMilestones.claimedAt
                : sql`COALESCE(${discordBotUserMilestones.claimedAt}, ${completedAt})`,
            updatedAt: completedAt,
          })
          .where(
            and(
              eq(discordBotUserMilestones.discordUserId, discordUserId),
              eq(discordBotUserMilestones.milestoneId, milestoneId),
              eq(discordBotUserMilestones.rewardStatus, "processing"),
            ),
          )
          .returning({
            discordUserId: discordBotUserMilestones.discordUserId,
          });

        if (completed && status !== "failed") {
          await transaction
            .update(discordBotUsers)
            .set({
              claimedMilestones: sql`CASE
                WHEN ${discordBotUsers.claimedMilestones} @> ARRAY[${milestoneId}]::text[]
                  THEN ${discordBotUsers.claimedMilestones}
                ELSE array_append(${discordBotUsers.claimedMilestones}, ${milestoneId})
              END`,
              updatedAt: completedAt,
            })
            .where(eq(discordBotUsers.discordUserId, discordUserId));
        }
      });
    } catch {
      logger.error("Could not complete a milestone reward event.");
      throw new Error("Could not complete a milestone reward event.");
    }
  }

}
