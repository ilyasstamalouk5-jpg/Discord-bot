import { logger } from "../config/logger.js";

export type CurrencyRewardEvent = {
  discordUserId: string;
  milestoneId: string;
  amount: number;
  idempotencyKey: string;
};

export type CurrencyRewardResult =
  | { status: "issued" }
  | { status: "deferred"; reason: string };

export interface CurrencyRewardProvider {
  readonly available: boolean;
  awardCurrency(event: CurrencyRewardEvent): Promise<CurrencyRewardResult>;
}

export class UnconfiguredCurrencyRewardProvider
  implements CurrencyRewardProvider
{
  readonly available = false;

  async awardCurrency(
    event: CurrencyRewardEvent,
  ): Promise<CurrencyRewardResult> {
    logger.info(
      { discordUserId: event.discordUserId, milestoneId: event.milestoneId },
      "Currency system is not connected; the milestone reward remains deferred.",
    );
    return {
      status: "deferred",
      reason: "No currency provider is configured.",
    };
  }
}
