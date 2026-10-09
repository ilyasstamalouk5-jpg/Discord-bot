export type MilestoneDefinition = {
  id: string;
  requiredVoiceTimeSeconds: number;
  roleId: string | null;
  currencyRewardAmount: number | null;
};

export type MilestoneRoleStatus =
  | "pending"
  | "granted"
  | "superseded"
  | "unconfigured"
  | "missing"
  | "member_not_found"
  | "failed";

export type MilestoneRewardStatus =
  | "pending"
  | "processing"
  | "deferred"
  | "issued"
  | "failed";

export type UserVoiceProgress = {
  discordUserId: string;
  totalVoiceTimeSeconds: number;
  activeSessionStartedAt: Date | null;
};

export type MilestoneProgressRecord = {
  discordUserId: string;
  milestoneId: string;
  requiredVoiceTimeSeconds: number;
  roleId: string | null;
  currencyRewardAmount: number | null;
  reachedAt: Date;
  roleStatus: MilestoneRoleStatus;
  roleGrantedAt: Date | null;
  rewardStatus: MilestoneRewardStatus;
  rewardProcessingAt: Date | null;
  rewardAttempts: number;
  claimedAt: Date | null;
  rewardLastError: string | null;
};

export interface MilestoneStore {
  getAllVoiceProgress(): Promise<UserVoiceProgress[]>;
  getMilestoneProgress(
    discordUserId: string,
  ): Promise<MilestoneProgressRecord[]>;
  recordReachedMilestones(
    discordUserId: string,
    milestones: readonly MilestoneDefinition[],
    reachedAt: Date,
  ): Promise<void>;
  updateMilestoneRoleStatus(
    discordUserId: string,
    milestoneId: string,
    status: MilestoneRoleStatus,
    roleGrantedAt?: Date,
  ): Promise<void>;
  getRewardCandidates(
    discordUserId: string,
    retryDeferred: boolean,
    staleProcessingBefore: Date,
  ): Promise<MilestoneProgressRecord[]>;
  claimMilestoneReward(
    discordUserId: string,
    milestoneId: string,
    claimedAt: Date,
    retryDeferred: boolean,
    staleProcessingBefore: Date,
  ): Promise<MilestoneProgressRecord | null>;
  completeMilestoneReward(
    discordUserId: string,
    milestoneId: string,
    status: Extract<MilestoneRewardStatus, "deferred" | "issued" | "failed">,
    completedAt: Date,
    error?: string,
  ): Promise<void>;
}
