import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config/index.js";
import { MilestoneManager } from "../src/milestones/milestone-manager.js";
import {
  DiscordMilestoneRoleOperations,
  MilestoneRoleManager,
  type MilestoneRoleOperations,
  type MilestoneRoleSnapshot,
} from "../src/milestones/role-manager.js";
import type { Client } from "discord.js";
import type {
  MilestoneDefinition,
  MilestoneProgressRecord,
  MilestoneRewardStatus,
  MilestoneRoleStatus,
  MilestoneStore,
  UserVoiceProgress,
} from "../src/milestones/types.js";
import {
  RewardManager,
} from "../src/rewards/reward-manager.js";
import type {
  CurrencyRewardEvent,
  CurrencyRewardProvider,
  CurrencyRewardResult,
} from "../src/rewards/currency-reward-provider.js";

const USER_ID = "200000000000000001";
const NOW = new Date("2026-02-01T12:00:00.000Z");
const TEST_MILESTONES: MilestoneDefinition[] =
  config.milestones.definitions.map((milestone) => ({
    ...milestone,
    roleId: `test-role-${milestone.id}`,
    currencyRewardAmount: 1,
  }));

function makeProgressRecord(
  discordUserId: string,
  milestone: MilestoneDefinition,
  reachedAt: Date,
): MilestoneProgressRecord {
  return {
    discordUserId,
    milestoneId: milestone.id,
    requiredVoiceTimeSeconds: milestone.requiredVoiceTimeSeconds,
    roleId: milestone.roleId,
    currencyRewardAmount: milestone.currencyRewardAmount,
    reachedAt,
    roleStatus: "pending",
    roleGrantedAt: null,
    rewardStatus: "pending",
    rewardProcessingAt: null,
    rewardAttempts: 0,
    claimedAt: null,
    rewardLastError: null,
  };
}

class MemoryMilestoneStore implements MilestoneStore {
  readonly voiceProgress = new Map<string, UserVoiceProgress>();
  readonly milestones = new Map<
    string,
    Map<string, MilestoneProgressRecord>
  >();
  readonly claimedMilestones = new Map<string, Set<string>>();
  readonly currentMilestones = new Map<string, string>();

  async getAllVoiceProgress(): Promise<UserVoiceProgress[]> {
    return [...this.voiceProgress.values()].map((progress) => ({ ...progress }));
  }

  async getMilestoneProgress(
    discordUserId: string,
  ): Promise<MilestoneProgressRecord[]> {
    return [
      ...(this.milestones.get(discordUserId)?.values() ?? []),
    ].map((record) => ({ ...record }));
  }

  async recordReachedMilestones(
    discordUserId: string,
    milestones: readonly MilestoneDefinition[],
    reachedAt: Date,
  ): Promise<void> {
    const userMilestones =
      this.milestones.get(discordUserId) ?? new Map();
    this.milestones.set(discordUserId, userMilestones);

    for (const milestone of milestones) {
      const existing = userMilestones.get(milestone.id);
      if (!existing) {
        userMilestones.set(
          milestone.id,
          makeProgressRecord(discordUserId, milestone, reachedAt),
        );
        continue;
      }
      if (existing.roleId !== milestone.roleId) {
        existing.roleStatus = "pending";
        existing.roleGrantedAt = null;
      }
      existing.requiredVoiceTimeSeconds =
        milestone.requiredVoiceTimeSeconds;
      existing.roleId = milestone.roleId;
      if (existing.rewardStatus !== "issued") {
        existing.currencyRewardAmount = milestone.currencyRewardAmount;
      }
    }

    const highest = milestones.at(-1);
    const currentId = this.currentMilestones.get(discordUserId);
    const current = currentId ? userMilestones.get(currentId) : undefined;
    const candidate = highest ? userMilestones.get(highest.id) : undefined;
    if (
      candidate &&
      (!current ||
        candidate.requiredVoiceTimeSeconds >=
          current.requiredVoiceTimeSeconds)
    ) {
      this.currentMilestones.set(discordUserId, candidate.milestoneId);
    }
  }

  async updateMilestoneRoleStatus(
    discordUserId: string,
    milestoneId: string,
    status: MilestoneRoleStatus,
    roleGrantedAt?: Date,
  ): Promise<void> {
    const milestone = this.milestones
      .get(discordUserId)
      ?.get(milestoneId);
    if (!milestone) {
      return;
    }
    milestone.roleStatus = status;
    if (status === "granted") {
      milestone.roleGrantedAt = roleGrantedAt ?? NOW;
    }
  }

  async getRewardCandidates(
    discordUserId: string,
    retryDeferred: boolean,
    staleProcessingBefore: Date,
  ): Promise<MilestoneProgressRecord[]> {
    return (await this.getMilestoneProgress(discordUserId)).filter(
      (milestone) =>
        milestone.rewardStatus === "pending" ||
        (retryDeferred &&
          (milestone.rewardStatus === "deferred" ||
            milestone.rewardStatus === "failed")) ||
        (milestone.rewardStatus === "processing" &&
          (!milestone.rewardProcessingAt ||
            milestone.rewardProcessingAt < staleProcessingBefore)),
    );
  }

  async claimMilestoneReward(
    discordUserId: string,
    milestoneId: string,
    claimedAt: Date,
    retryDeferred: boolean,
    staleProcessingBefore: Date,
  ): Promise<MilestoneProgressRecord | null> {
    const milestone = this.milestones
      .get(discordUserId)
      ?.get(milestoneId);
    if (!milestone) {
      return null;
    }
    const claimable =
      milestone.rewardStatus === "pending" ||
      (retryDeferred &&
        (milestone.rewardStatus === "deferred" ||
          milestone.rewardStatus === "failed")) ||
      (milestone.rewardStatus === "processing" &&
        (!milestone.rewardProcessingAt ||
          milestone.rewardProcessingAt < staleProcessingBefore));
    if (!claimable) {
      return null;
    }

    milestone.rewardStatus = "processing";
    milestone.rewardProcessingAt = claimedAt;
    milestone.rewardAttempts += 1;
    return { ...milestone };
  }

  async completeMilestoneReward(
    discordUserId: string,
    milestoneId: string,
    status: Extract<MilestoneRewardStatus, "deferred" | "issued" | "failed">,
    completedAt: Date,
    error?: string,
  ): Promise<void> {
    const milestone = this.milestones
      .get(discordUserId)
      ?.get(milestoneId);
    if (!milestone) {
      return;
    }
    milestone.rewardStatus = status;
    milestone.rewardProcessingAt = null;
    milestone.rewardLastError = error ?? null;
    if (status !== "failed") {
      milestone.claimedAt ??= completedAt;
      const claims =
        this.claimedMilestones.get(discordUserId) ?? new Set<string>();
      claims.add(milestoneId);
      this.claimedMilestones.set(discordUserId, claims);
    }
  }
}

class MemoryRoleOperations implements MilestoneRoleOperations {
  readonly availableRoleIds = new Set(
    TEST_MILESTONES.flatMap((milestone) =>
      milestone.roleId ? [milestone.roleId] : [],
    ),
  );
  readonly assignedRoleIdsByUser = new Map<string, Set<string>>();
  readonly addCalls: string[] = [];
  readonly removeCalls: string[] = [];

  async inspect(
    discordUserId: string,
    roleIds: readonly string[],
  ): Promise<MilestoneRoleSnapshot> {
    const assigned =
      this.assignedRoleIdsByUser.get(discordUserId) ?? new Set<string>();
    return {
      guildId: "test-guild",
      memberFound: true,
      availableRoleIds: roleIds.filter((roleId) =>
        this.availableRoleIds.has(roleId),
      ),
      missingRoleIds: roleIds.filter(
        (roleId) => !this.availableRoleIds.has(roleId),
      ),
      assignedRoleIds: roleIds.filter((roleId) => assigned.has(roleId)),
    };
  }

  async addRole(
    _guildId: string,
    discordUserId: string,
    roleId: string,
  ): Promise<void> {
    this.addCalls.push(roleId);
    const assigned =
      this.assignedRoleIdsByUser.get(discordUserId) ?? new Set<string>();
    assigned.add(roleId);
    this.assignedRoleIdsByUser.set(discordUserId, assigned);
  }

  async removeRole(
    _guildId: string,
    discordUserId: string,
    roleId: string,
  ): Promise<void> {
    this.removeCalls.push(roleId);
    this.assignedRoleIdsByUser.get(discordUserId)?.delete(roleId);
  }
}

class MemoryCurrencyProvider implements CurrencyRewardProvider {
  readonly available = true;
  readonly events: CurrencyRewardEvent[] = [];

  async awardCurrency(
    event: CurrencyRewardEvent,
  ): Promise<CurrencyRewardResult> {
    this.events.push(event);
    return { status: "issued" };
  }
}

function createSystem(input: {
  totalVoiceTimeSeconds: number;
  activeSessionStartedAt?: Date | null;
  currencyRewardAmount?: number | null;
  unconfiguredRoleIds?: readonly string[];
  roleOperations?: MemoryRoleOperations;
  currencyProvider?: CurrencyRewardProvider;
  store?: MemoryMilestoneStore;
  clock?: () => Date;
}) {
  const milestones = TEST_MILESTONES.map((milestone) => ({
    ...milestone,
    roleId: input.unconfiguredRoleIds?.includes(milestone.id)
      ? null
      : milestone.roleId,
    currencyRewardAmount:
      input.currencyRewardAmount === undefined
        ? milestone.currencyRewardAmount
        : input.currencyRewardAmount,
  }));
  const store = input.store ?? new MemoryMilestoneStore();
  store.voiceProgress.set(USER_ID, {
    discordUserId: USER_ID,
    totalVoiceTimeSeconds: input.totalVoiceTimeSeconds,
    activeSessionStartedAt: input.activeSessionStartedAt ?? null,
  });
  const roleOperations = input.roleOperations ?? new MemoryRoleOperations();
  const roleManager = new MilestoneRoleManager(
    roleOperations,
    milestones,
  );
  const currencyProvider =
    input.currencyProvider ?? new MemoryCurrencyProvider();
  const rewardManager = new RewardManager(
    store,
    currencyProvider,
    input.clock ?? (() => new Date(NOW)),
  );
  const milestoneManager = new MilestoneManager(
    store,
    roleManager,
    rewardManager,
    milestones,
    10_000,
    input.clock ?? (() => new Date(NOW)),
  );
  return {
    store,
    roleOperations,
    currencyProvider,
    milestoneManager,
    milestones,
  };
}

test("exactly 1 hour reaches milestone 1", async () => {
  const system = createSystem({ totalVoiceTimeSeconds: 3_600 });
  await system.milestoneManager.checkAllUsers();

  assert.deepEqual(
    (await system.store.getMilestoneProgress(USER_ID)).map(
      (milestone) => milestone.milestoneId,
    ),
    ["1"],
  );
  assert.deepEqual(
    system.roleOperations.assignedRoleIdsByUser.get(USER_ID),
    new Set(["test-role-1"]),
  );
});

test("default milestone requirements match the requested hour sequence", () => {
  assert.deepEqual(
    config.milestones.definitions.map(
      (milestone) => milestone.requiredVoiceTimeSeconds / 3_600,
    ),
    [1, 2, 4, 8, 16, 24, 48, 72, 100, 150],
  );
});

test("exactly 2 hours reaches milestones 1 and 2 and grants milestone 2 role", async () => {
  const system = createSystem({ totalVoiceTimeSeconds: 7_200 });
  await system.milestoneManager.checkAllUsers();

  assert.deepEqual(
    (await system.store.getMilestoneProgress(USER_ID)).map(
      (milestone) => milestone.milestoneId,
    ),
    ["1", "2"],
  );
  assert.deepEqual(
    system.roleOperations.assignedRoleIdsByUser.get(USER_ID),
    new Set(["test-role-2"]),
  );
});

test("reaching a higher milestone replaces the previous milestone role", async () => {
  const system = createSystem({ totalVoiceTimeSeconds: 3_600 });
  await system.milestoneManager.checkAllUsers();

  system.store.voiceProgress.set(USER_ID, {
    discordUserId: USER_ID,
    totalVoiceTimeSeconds: 7_200,
    activeSessionStartedAt: null,
  });
  await system.milestoneManager.checkAllUsers();

  assert.deepEqual(
    system.roleOperations.assignedRoleIdsByUser.get(USER_ID),
    new Set(["test-role-2"]),
  );
  assert.deepEqual(system.roleOperations.addCalls, [
    "test-role-1",
    "test-role-2",
  ]);
  assert.deepEqual(system.roleOperations.removeCalls, ["test-role-1"]);
});

test("exactly 4 hours reaches milestones 1 through 3", async () => {
  const system = createSystem({ totalVoiceTimeSeconds: 14_400 });
  await system.milestoneManager.checkAllUsers();

  assert.equal((await system.store.getMilestoneProgress(USER_ID)).length, 3);
  assert.deepEqual(
    system.roleOperations.assignedRoleIdsByUser.get(USER_ID),
    new Set(["test-role-3"]),
  );
});

test("uses the highest earned role that is configured when a higher role is unset", async () => {
  const system = createSystem({
    totalVoiceTimeSeconds: 7_200,
    unconfiguredRoleIds: ["2"],
  });
  await system.milestoneManager.checkAllUsers();

  const progress = await system.store.getMilestoneProgress(USER_ID);
  assert.deepEqual(
    progress.map((milestone) => [
      milestone.milestoneId,
      milestone.roleStatus,
    ]),
    [
      ["1", "granted"],
      ["2", "unconfigured"],
    ],
  );
  assert.deepEqual(
    system.roleOperations.assignedRoleIdsByUser.get(USER_ID),
    new Set(["test-role-1"]),
  );
});

test("a small amount above a threshold still reaches it once", async () => {
  const system = createSystem({ totalVoiceTimeSeconds: 3_601 });
  await system.milestoneManager.checkAllUsers();

  const progress = await system.store.getMilestoneProgress(USER_ID);
  assert.equal(progress.length, 1);
  assert.equal(progress[0]?.milestoneId, "1");
  assert.equal(progress[0]?.claimedAt?.getTime(), NOW.getTime());
});

test("a multi-milestone time increase records all milestones and grants only the highest role", async () => {
  const system = createSystem({
    totalVoiceTimeSeconds: 150 * 60 * 60,
  });
  await system.milestoneManager.checkAllUsers();

  assert.equal((await system.store.getMilestoneProgress(USER_ID)).length, 10);
  assert.equal(
    system.store.claimedMilestones.get(USER_ID)?.size,
    10,
  );
  assert.deepEqual(
    system.roleOperations.assignedRoleIdsByUser.get(USER_ID),
    new Set(["test-role-10"]),
  );
});

test("leave and rejoin checks use accumulated totals without repeating a claim", async () => {
  let now = new Date(NOW);
  const system = createSystem({
    totalVoiceTimeSeconds: 3_599,
    activeSessionStartedAt: new Date(NOW.getTime() - 1_000),
    clock: () => new Date(now),
  });
  await system.milestoneManager.checkAllUsers();

  system.store.voiceProgress.set(USER_ID, {
    discordUserId: USER_ID,
    totalVoiceTimeSeconds: 3_600,
    activeSessionStartedAt: new Date(now),
  });
  now = new Date(now.getTime() + 30_000);
  await system.milestoneManager.checkAllUsers();

  assert.equal(system.store.claimedMilestones.get(USER_ID)?.size, 1);
  assert.equal(
    (system.currencyProvider as MemoryCurrencyProvider).events.length,
    1,
  );
});

test("a claimed milestone stays claimed after manager restart", async () => {
  const store = new MemoryMilestoneStore();
  const firstProvider = new MemoryCurrencyProvider();
  const firstRun = createSystem({
    totalVoiceTimeSeconds: 3_600,
    store,
    currencyProvider: firstProvider,
  });
  await firstRun.milestoneManager.checkAllUsers();

  const secondProvider = new MemoryCurrencyProvider();
  const restarted = createSystem({
    totalVoiceTimeSeconds: 3_600,
    store,
    currencyProvider: secondProvider,
    roleOperations: firstRun.roleOperations,
  });
  await restarted.milestoneManager.checkAllUsers();

  assert.equal(store.claimedMilestones.get(USER_ID)?.has("1"), true);
  assert.equal(firstProvider.events.length, 1);
  assert.equal(secondProvider.events.length, 0);
});

test("repeated milestone checks do not duplicate a currency reward", async () => {
  const system = createSystem({ totalVoiceTimeSeconds: 3_600 });
  await system.milestoneManager.checkAllUsers();
  await system.milestoneManager.checkAllUsers();
  await system.milestoneManager.checkAllUsers();

  const progress = await system.store.getMilestoneProgress(USER_ID);
  assert.equal(progress[0]?.rewardAttempts, 1);
  assert.equal(
    (system.currencyProvider as MemoryCurrencyProvider).events.length,
    1,
  );
});

test("a missing configured Discord role is logged and does not crash milestone processing", async () => {
  const roleOperations = new MemoryRoleOperations();
  roleOperations.availableRoleIds.delete("test-role-1");
  const system = createSystem({
    totalVoiceTimeSeconds: 3_600,
    roleOperations,
  });

  await assert.doesNotReject(system.milestoneManager.checkAllUsers());
  const progress = await system.store.getMilestoneProgress(USER_ID);
  assert.equal(progress[0]?.roleStatus, "missing");
  assert.equal(progress[0]?.rewardStatus, "issued");
});

test("a user who already has a higher milestone role is not downgraded", async () => {
  const roleOperations = new MemoryRoleOperations();
  roleOperations.assignedRoleIdsByUser.set(
    USER_ID,
    new Set(["test-role-3"]),
  );
  const system = createSystem({
    totalVoiceTimeSeconds: 3_600,
    roleOperations,
  });
  await system.milestoneManager.checkAllUsers();

  assert.deepEqual(
    roleOperations.assignedRoleIdsByUser.get(USER_ID),
    new Set(["test-role-3"]),
  );
  assert.equal(
    (await system.store.getMilestoneProgress(USER_ID))[0]?.roleStatus,
    "superseded",
  );
  assert.deepEqual(roleOperations.addCalls, []);
});

test("permission or hierarchy failures keep existing roles and retry safely", async () => {
  const roleOperations = new MemoryRoleOperations();
  roleOperations.assignedRoleIdsByUser.set(USER_ID, new Set(["test-role-1"]));
  const addRole = roleOperations.addRole.bind(roleOperations);
  roleOperations.addRole = async () => {
    throw Object.assign(new Error("Missing Permissions"), {
      code: 50013,
      status: 403,
    });
  };
  const system = createSystem({
    totalVoiceTimeSeconds: 7_200,
    roleOperations,
  });

  await assert.doesNotReject(system.milestoneManager.checkAllUsers());
  assert.deepEqual(
    roleOperations.assignedRoleIdsByUser.get(USER_ID),
    new Set(["test-role-1"]),
  );
  assert.deepEqual(roleOperations.removeCalls, []);
  assert.equal(
    (await system.store.getMilestoneProgress(USER_ID)).find(
      (milestone) => milestone.milestoneId === "2",
    )?.roleStatus,
    "failed",
  );

  roleOperations.addRole = addRole;
  await system.milestoneManager.checkAllUsers();
  assert.deepEqual(
    roleOperations.assignedRoleIdsByUser.get(USER_ID),
    new Set(["test-role-2"]),
  );
  assert.deepEqual(roleOperations.removeCalls, ["test-role-1"]);
});

test("invalid configured role IDs are reported without a Discord role lookup", async () => {
  let roleFetches = 0;
  const guildId = "300000000000000001";
  const guild = {
    id: guildId,
    roles: {
      cache: new Map(),
      fetch: async () => {
        roleFetches += 1;
        return null;
      },
    },
    members: {
      fetch: async () => ({ roles: { cache: { has: () => false } } }),
    },
  };
  const client = {
    guilds: {
      cache: new Map([[guildId, guild]]),
    },
  } as unknown as Client;
  const operations = new DiscordMilestoneRoleOperations(client, guildId);

  const snapshot = await operations.inspect(USER_ID, [
    "not-a-role-id",
    "1234",
  ]);

  assert.deepEqual(snapshot.invalidRoleIds, ["not-a-role-id", "1234"]);
  assert.equal(roleFetches, 0);
  assert.deepEqual(snapshot.availableRoleIds, []);
});

test("unset currency amounts are claimed once and safely deferred without an economy", async () => {
  const system = createSystem({
    totalVoiceTimeSeconds: 3_600,
    currencyRewardAmount: null,
  });
  await system.milestoneManager.checkAllUsers();
  await system.milestoneManager.checkAllUsers();

  const progress = (await system.store.getMilestoneProgress(USER_ID))[0];
  assert.equal(progress?.claimedAt?.getTime(), NOW.getTime());
  assert.equal(progress?.rewardStatus, "deferred");
  assert.equal(progress?.rewardAttempts, 1);
  assert.equal(
    (system.currencyProvider as MemoryCurrencyProvider).events.length,
    0,
  );
});
