import { logger } from "../config/logger.js";
import type { MilestoneStore, UserVoiceProgress } from "./types.js";
import type {
  MilestoneDefinition,
  MilestoneProgressRecord,
} from "./types.js";
import type { MilestoneRoleManager } from "./role-manager.js";
import type { RewardManager } from "../rewards/reward-manager.js";

function validateMilestones(milestones: readonly MilestoneDefinition[]): void {
  const ids = new Set<string>();
  const roleIds = new Set<string>();
  let previousRequiredSeconds = 0;
  for (const milestone of milestones) {
    if (!milestone.id.trim() || ids.has(milestone.id)) {
      throw new Error("Milestone IDs must be non-empty and unique.");
    }
    if (
      !Number.isSafeInteger(milestone.requiredVoiceTimeSeconds) ||
      milestone.requiredVoiceTimeSeconds <= previousRequiredSeconds
    ) {
      throw new Error(
        "Milestone voice-time requirements must be increasing positive safe integers.",
      );
    }
    if (
      milestone.currencyRewardAmount !== null &&
      (!Number.isSafeInteger(milestone.currencyRewardAmount) ||
        milestone.currencyRewardAmount < 0)
    ) {
      throw new Error(
        `Currency reward for milestone ${milestone.id} must be a non-negative safe integer or null.`,
      );
    }
    if (milestone.roleId && roleIds.has(milestone.roleId)) {
      throw new Error("Each configured milestone must use a unique role ID.");
    }
    ids.add(milestone.id);
    if (milestone.roleId) {
      roleIds.add(milestone.roleId);
    }
    previousRequiredSeconds = milestone.requiredVoiceTimeSeconds;
  }
}

function activeVoiceSeconds(
  progress: UserVoiceProgress,
  now: Date,
): number {
  if (!progress.activeSessionStartedAt) {
    return 0;
  }
  return Math.max(
    0,
    Math.floor(
      (now.getTime() - progress.activeSessionStartedAt.getTime()) / 1_000,
    ),
  );
}

export class MilestoneManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningCheck: Promise<void> | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly store: MilestoneStore,
    private readonly roleManager: MilestoneRoleManager,
    private readonly rewardManager: RewardManager,
    private readonly milestones: readonly MilestoneDefinition[],
    private readonly checkIntervalMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {
    validateMilestones(milestones);
    if (!Number.isSafeInteger(checkIntervalMs) || checkIntervalMs < 10_000) {
      throw new Error("Milestone check interval must be at least 10 seconds.");
    }
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    await this.checkAllUsers();
    if (this.stopped) {
      return;
    }
    this.timer = setInterval(() => {
      void this.checkAllUsers();
    }, this.checkIntervalMs);
    this.timer.unref?.();
    logger.info(
      { intervalMs: this.checkIntervalMs },
      "Voice-time milestone checks started.",
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.runningCheck;
  }

  async checkAllUsers(): Promise<void> {
    if (this.runningCheck) {
      return this.runningCheck;
    }

    const check = this.checkAllUsersInternal();
    this.runningCheck = check;
    try {
      await check;
    } finally {
      if (this.runningCheck === check) {
        this.runningCheck = null;
      }
    }
  }

  private async checkAllUsersInternal(): Promise<void> {
    let users: UserVoiceProgress[];
    try {
      users = await this.store.getAllVoiceProgress();
    } catch (error) {
      logger.error({ err: error }, "Milestone check could not load voice-time totals.");
      return;
    }

    const now = this.clock();
    for (const user of users) {
      if (this.stopped) {
        return;
      }
      try {
        await this.checkUser(user, now);
      } catch (error) {
        logger.error(
          { err: error, discordUserId: user.discordUserId },
          "Milestone check failed for one Discord user.",
        );
      }
    }
  }

  private async checkUser(
    user: UserVoiceProgress,
    checkedAt: Date,
  ): Promise<void> {
    const earnedVoiceSeconds =
      user.totalVoiceTimeSeconds + activeVoiceSeconds(user, checkedAt);
    const progressBefore = await this.store.getMilestoneProgress(
      user.discordUserId,
    );
    const previouslyReached = new Set(
      progressBefore.map((milestone) => milestone.milestoneId),
    );
    const earnedMilestones = this.milestones.filter(
      (milestone) =>
        milestone.requiredVoiceTimeSeconds <= earnedVoiceSeconds ||
        previouslyReached.has(milestone.id),
    );
    if (earnedMilestones.length === 0) {
      return;
    }

    const progressByIdBefore = new Map(
      progressBefore.map((milestone) => [milestone.milestoneId, milestone]),
    );
    const milestonesNeedingPersistence = earnedMilestones.filter(
      (milestone) => {
        const existing = progressByIdBefore.get(milestone.id);
        return (
          !existing ||
          existing.requiredVoiceTimeSeconds !==
            milestone.requiredVoiceTimeSeconds ||
          existing.roleId !== milestone.roleId ||
          (existing.rewardStatus !== "issued" &&
            existing.currencyRewardAmount !== milestone.currencyRewardAmount)
        );
      },
    );
    if (milestonesNeedingPersistence.length > 0) {
      await this.store.recordReachedMilestones(
        user.discordUserId,
        milestonesNeedingPersistence,
        checkedAt,
      );
    }
    const progress = await this.store.getMilestoneProgress(user.discordUserId);
    const progressById = new Map(
      progress.map((milestone) => [milestone.milestoneId, milestone]),
    );
    const highestReached = earnedMilestones.at(-1);
    if (!highestReached) {
      return;
    }

    const highestConfiguredRole = earnedMilestones
      .filter((milestone) => milestone.roleId !== null)
      .at(-1);

    if (!highestConfiguredRole) {
      await this.roleManager.assignHighestMilestoneRole(
        user.discordUserId,
        highestReached,
      );
      for (const milestone of earnedMilestones) {
        const existing = progressById.get(milestone.id);
        if (existing?.roleStatus !== "unconfigured") {
          await this.store.updateMilestoneRoleStatus(
            user.discordUserId,
            milestone.id,
            "unconfigured",
          );
        }
      }
      await this.rewardManager.processUserRewards(user.discordUserId);
      return;
    }

    const highestProgress = progressById.get(highestConfiguredRole.id);
    let highestRoleStatus = highestProgress?.roleStatus;
    if (
      !highestProgress ||
      highestProgress.roleId !== highestConfiguredRole.roleId ||
      this.needsRoleSynchronization(highestProgress)
    ) {
      const roleStatus = await this.roleManager.assignHighestMilestoneRole(
        user.discordUserId,
        highestConfiguredRole,
      );
      await this.store.updateMilestoneRoleStatus(
        user.discordUserId,
        highestConfiguredRole.id,
        roleStatus,
        roleStatus === "granted" ? checkedAt : undefined,
      );
      highestRoleStatus = roleStatus;
    }

    for (const milestone of earnedMilestones) {
      if (milestone.id === highestConfiguredRole.id) {
        continue;
      }
      const existing = progressById.get(milestone.id);
      const desiredStatus = milestone.roleId ? "superseded" : "unconfigured";
      if (existing?.roleStatus === desiredStatus) {
        continue;
      }
      if (
        !milestone.roleId ||
        highestRoleStatus === "granted" ||
        highestRoleStatus === "superseded"
      ) {
        await this.store.updateMilestoneRoleStatus(
          user.discordUserId,
          milestone.id,
          desiredStatus,
        );
      }
    }

    await this.rewardManager.processUserRewards(user.discordUserId);
  }

  private needsRoleSynchronization(
    progress: MilestoneProgressRecord,
  ): boolean {
    return (
      progress.roleStatus === "pending" ||
      progress.roleStatus === "missing" ||
      progress.roleStatus === "member_not_found" ||
      progress.roleStatus === "failed"
    );
  }
}
