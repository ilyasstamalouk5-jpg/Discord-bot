import {
  Client,
  type Guild,
  type GuildMember,
} from "discord.js";
import { logger } from "../config/logger.js";
import type { MilestoneDefinition, MilestoneRoleStatus } from "./types.js";

export type MilestoneRoleSnapshot = {
  guildId: string | null;
  memberFound: boolean;
  availableRoleIds: string[];
  missingRoleIds: string[];
  invalidRoleIds?: string[];
  assignedRoleIds: string[];
};

type DiscordApiFailure = {
  code?: number | string;
  status?: number;
};

function discordApiFailure(error: unknown): DiscordApiFailure {
  if (!error || typeof error !== "object") {
    return {};
  }
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  return {
    ...(typeof candidate.code === "number" ||
    typeof candidate.code === "string"
      ? { code: candidate.code }
      : {}),
    ...(typeof candidate.status === "number"
      ? { status: candidate.status }
      : typeof candidate.statusCode === "number"
        ? { status: candidate.statusCode }
        : {}),
  };
}

function isDiscordSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

function isUnknownRoleFailure(error: unknown): boolean {
  const failure = discordApiFailure(error);
  return (
    failure.code === 10011 ||
    failure.code === "10011" ||
    failure.status === 404
  );
}

function roleOperationFailureMessage(
  action: "assigning" | "removing",
  error: unknown,
): string {
  const { code, status } = discordApiFailure(error);
  if (code === 50013 || code === "50013" || status === 403) {
    return `Discord denied ${action} a milestone role. Check that the bot has Manage Roles and that its highest role is above the milestone role.`;
  }
  if (code === 50001 || code === "50001") {
    return `Discord denied ${action} a milestone role because the bot lacks access to the server or member.`;
  }
  if (code === 10011 || code === "10011" || status === 404) {
    return `Discord could not find the milestone role while ${action} it; verify the configured role ID.`;
  }
  return `Could not complete the milestone role ${action} request.`;
}

export interface MilestoneRoleOperations {
  inspect(
    discordUserId: string,
    roleIds: readonly string[],
  ): Promise<MilestoneRoleSnapshot>;
  addRole(
    guildId: string,
    discordUserId: string,
    roleId: string,
  ): Promise<void>;
  removeRole(
    guildId: string,
    discordUserId: string,
    roleId: string,
  ): Promise<void>;
}

export class DiscordMilestoneRoleOperations
  implements MilestoneRoleOperations
{
  private readonly members = new Map<string, GuildMember>();

  constructor(
    private readonly client: Client,
    private readonly configuredGuildId?: string,
  ) {}

  async inspect(
    discordUserId: string,
    roleIds: readonly string[],
  ): Promise<MilestoneRoleSnapshot> {
    const invalidRoleIds = roleIds.filter(
      (roleId) => !isDiscordSnowflake(roleId),
    );
    const validRoleIds = roleIds.filter(isDiscordSnowflake);
    const guild = await this.resolveGuild(validRoleIds);
    if (!guild) {
      return {
        guildId: this.configuredGuildId ?? null,
        memberFound: false,
        availableRoleIds: [],
        missingRoleIds: validRoleIds,
        invalidRoleIds,
        assignedRoleIds: [],
      };
    }

    const availableRoleIds: string[] = [];
    const missingRoleIds: string[] = [];
    for (const roleId of validRoleIds) {
      let role = guild.roles.cache.get(roleId);
      if (!role) {
        try {
          role = await guild.roles.fetch(roleId) ?? undefined;
        } catch (error) {
          if (!isUnknownRoleFailure(error)) {
            throw error;
          }
        }
      }
      if (role) {
        availableRoleIds.push(roleId);
      } else {
        missingRoleIds.push(roleId);
      }
    }

    let member: GuildMember;
    try {
      member = await guild.members.fetch(discordUserId);
    } catch {
      return {
        guildId: guild.id,
        memberFound: false,
        availableRoleIds,
        missingRoleIds,
        invalidRoleIds,
        assignedRoleIds: [],
      };
    }

    this.members.set(this.memberKey(guild.id, discordUserId), member);
    return {
      guildId: guild.id,
      memberFound: true,
      availableRoleIds,
      missingRoleIds,
      invalidRoleIds,
      assignedRoleIds: roleIds.filter((roleId) =>
        member.roles.cache.has(roleId),
      ),
    };
  }

  async addRole(
    guildId: string,
    discordUserId: string,
    roleId: string,
  ): Promise<void> {
    const member = await this.getMember(guildId, discordUserId);
    await member.roles.add(roleId, "Voice-time milestone progression");
  }

  async removeRole(
    guildId: string,
    discordUserId: string,
    roleId: string,
  ): Promise<void> {
    const member = await this.getMember(guildId, discordUserId);
    await member.roles.remove(roleId, "Voice-time milestone progression");
  }

  private async resolveGuild(
    roleIds: readonly string[],
  ): Promise<Guild | null> {
    if (this.configuredGuildId) {
      const cached = this.client.guilds.cache.get(this.configuredGuildId);
      if (cached) {
        return cached;
      }
      try {
        return await this.client.guilds.fetch(this.configuredGuildId);
      } catch {
        return null;
      }
    }

    const guilds = [...this.client.guilds.cache.values()];
    if (guilds.length === 0) {
      return null;
    }
    return guilds
      .map((guild) => ({
        guild,
        matchingRoles: roleIds.filter((roleId) =>
          guild.roles.cache.has(roleId),
        ).length,
      }))
      .sort((left, right) => right.matchingRoles - left.matchingRoles)[0]!
      .guild;
  }

  private async getMember(
    guildId: string,
    discordUserId: string,
  ): Promise<GuildMember> {
    const key = this.memberKey(guildId, discordUserId);
    const cached = this.members.get(key);
    if (cached) {
      return cached;
    }
    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId));
    const member = await guild.members.fetch(discordUserId);
    this.members.set(key, member);
    return member;
  }

  private memberKey(guildId: string, discordUserId: string): string {
    return `${guildId}:${discordUserId}`;
  }
}

export class MilestoneRoleManager {
  private readonly loggedMissingRoleIds = new Set<string>();
  private readonly loggedInvalidRoleIds = new Set<string>();
  private readonly loggedUnconfiguredMilestones = new Set<string>();

  constructor(
    private readonly operations: MilestoneRoleOperations,
    private readonly milestones: readonly MilestoneDefinition[],
  ) {}

  async assignHighestMilestoneRole(
    discordUserId: string,
    target: MilestoneDefinition,
  ): Promise<MilestoneRoleStatus> {
    if (!target.roleId) {
      if (!this.loggedUnconfiguredMilestones.has(target.id)) {
        this.loggedUnconfiguredMilestones.add(target.id);
        logger.warn(
          { milestoneId: target.id },
          "No Discord role ID is configured for this voice-time milestone; role assignment is skipped.",
        );
      }
      return "unconfigured";
    }

    const roleIds = this.milestones.flatMap((milestone) =>
      milestone.roleId ? [milestone.roleId] : [],
    );
    let snapshot: MilestoneRoleSnapshot;
    try {
      snapshot = await this.operations.inspect(discordUserId, roleIds);
    } catch (error) {
      logger.error(
        {
          discordUserId,
          milestoneId: target.id,
          ...discordApiFailure(error),
        },
        roleOperationFailureMessage("assigning", error),
      );
      return "failed";
    }

    for (const roleId of snapshot.invalidRoleIds ?? []) {
      if (this.loggedInvalidRoleIds.has(roleId)) {
        continue;
      }
      this.loggedInvalidRoleIds.add(roleId);
      const milestoneId = this.milestones.find(
        (milestone) => milestone.roleId === roleId,
      )?.id;
      logger.error(
        { discordUserId, milestoneId, guildId: snapshot.guildId },
        "Configured milestone role ID is invalid; use the Discord role ID, not its name.",
      );
    }

    for (const roleId of snapshot.missingRoleIds) {
      if (this.loggedMissingRoleIds.has(roleId)) {
        continue;
      }
      this.loggedMissingRoleIds.add(roleId);
      logger.error(
        { roleId, guildId: snapshot.guildId },
        "Configured milestone role was not found; that role cannot be assigned.",
      );
    }

    if (!snapshot.memberFound || !snapshot.guildId) {
      logger.warn(
        { discordUserId, guildId: snapshot.guildId },
        "Milestone roles were not changed because the Discord member or target server is unavailable.",
      );
      return "member_not_found";
    }

    const targetIndex = this.milestones.findIndex(
      (milestone) => milestone.id === target.id,
    );
    if (targetIndex < 0) {
      logger.error(
        { milestoneId: target.id },
        "Reached milestone is missing from the configured milestone list.",
      );
      return "failed";
    }

    const availableRoleIds = new Set(snapshot.availableRoleIds);
    const assignedRoleIds = new Set(snapshot.assignedRoleIds);
    const highestAssignedIndex = this.milestones.reduce(
      (highest, milestone, index) =>
        milestone.roleId && assignedRoleIds.has(milestone.roleId)
          ? Math.max(highest, index)
          : highest,
      -1,
    );

    let finalIndex = targetIndex;
    let result: MilestoneRoleStatus = "granted";

    if (highestAssignedIndex > targetIndex) {
      finalIndex = highestAssignedIndex;
      result = "superseded";
    } else if (!availableRoleIds.has(target.roleId)) {
      return "missing";
    } else if (!assignedRoleIds.has(target.roleId)) {
      try {
        await this.operations.addRole(
          snapshot.guildId,
          discordUserId,
          target.roleId,
        );
        assignedRoleIds.add(target.roleId);
      } catch (error) {
        logger.error(
          {
            discordUserId,
            milestoneId: target.id,
            roleId: target.roleId,
            guildId: snapshot.guildId,
            ...discordApiFailure(error),
          },
          roleOperationFailureMessage("assigning", error),
        );
        return "failed";
      }
    }

    let removalFailed = false;
    for (let index = 0; index < this.milestones.length; index += 1) {
      const milestone = this.milestones[index]!;
      if (
        index === finalIndex ||
        !milestone.roleId ||
        !assignedRoleIds.has(milestone.roleId)
      ) {
        continue;
      }

      try {
        await this.operations.removeRole(
          snapshot.guildId,
          discordUserId,
          milestone.roleId,
        );
      } catch (error) {
        removalFailed = true;
        logger.error(
          {
            discordUserId,
            milestoneId: milestone.id,
            roleId: milestone.roleId,
            guildId: snapshot.guildId,
            ...discordApiFailure(error),
          },
          roleOperationFailureMessage("removing", error),
        );
      }
    }

    if (removalFailed) {
      return "failed";
    }
    return result;
  }
}
