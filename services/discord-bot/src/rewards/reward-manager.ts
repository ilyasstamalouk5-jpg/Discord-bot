import { logger } from "../config/logger.js";
import type { MilestoneStore } from "../milestones/types.js";
import type { CurrencyRewardProvider } from "./currency-reward-provider.js";

const PROCESSING_LEASE_MS = 5 * 60 * 1_000;

export class RewardManager {
  constructor(
    private readonly store: MilestoneStore,
    private readonly provider: CurrencyRewardProvider,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async processUserRewards(discordUserId: string): Promise<void> {
    const now = this.clock();
    const staleProcessingBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const candidates = await this.store.getRewardCandidates(
      discordUserId,
      this.provider.available,
      staleProcessingBefore,
    );

    for (const candidate of candidates) {
      if (
        candidate.currencyRewardAmount === null &&
        candidate.rewardStatus !== "pending" &&
        candidate.rewardStatus !== "processing"
      ) {
        continue;
      }

      const retryDeferred =
        this.provider.available && candidate.currencyRewardAmount !== null;
      const claimed = await this.store.claimMilestoneReward(
        discordUserId,
        candidate.milestoneId,
        this.clock(),
        retryDeferred,
        staleProcessingBefore,
      );
      if (!claimed) {
        continue;
      }

      if (claimed.currencyRewardAmount === null) {
        await this.deferReward(
          claimed.discordUserId,
          claimed.milestoneId,
          "Currency reward amount is still TBD.",
        );
        continue;
      }

      try {
        const result = await this.provider.awardCurrency({
          discordUserId: claimed.discordUserId,
          milestoneId: claimed.milestoneId,
          amount: claimed.currencyRewardAmount,
          idempotencyKey: `${claimed.discordUserId}:${claimed.milestoneId}`,
        });
        await this.store.completeMilestoneReward(
          claimed.discordUserId,
          claimed.milestoneId,
          result.status,
          this.clock(),
          result.status === "deferred" ? result.reason : undefined,
        );
      } catch {
        logger.error(
          {
            discordUserId: claimed.discordUserId,
            milestoneId: claimed.milestoneId,
          },
          "Currency reward provider failed; the milestone event is available for safe retry.",
        );
        await this.store.completeMilestoneReward(
          claimed.discordUserId,
          claimed.milestoneId,
          "failed",
          this.clock(),
          "Currency reward provider failed.",
        );
      }
    }
  }

  private async deferReward(
    discordUserId: string,
    milestoneId: string,
    reason: string,
  ): Promise<void> {
    logger.info(
      { discordUserId, milestoneId, reason },
      "Milestone reward was claimed and persisted, but currency issuance is deferred.",
    );
    await this.store.completeMilestoneReward(
      discordUserId,
      milestoneId,
      "deferred",
      this.clock(),
      reason,
    );
  }
}
