import {
  ApplicationCommandType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from "discord.js";
import {
  getActiveVoiceSession,
  getUserData,
  getVoiceTimeLeaderboardData,
  getVoiceTimeRank,
  getVoiceTimeSessionStats,
} from "../database/index.js";
import { logger } from "../config/logger.js";
import { config } from "../config/index.js";
import {
  formatDiscordTimestamp,
  formatVoiceDuration,
  getMilestoneProgress,
  voiceSlashCommandBuilders,
} from "./voice-command-utils.js";

type VoiceCommandResult = {
  content?: string;
  embeds?: EmbedBuilder[];
};

function currentSessionSeconds(startedAt: Date | null, checkedAt: Date): number {
  if (!startedAt || Number.isNaN(startedAt.getTime())) {
    return 0;
  }
  return Math.max(
    0,
    Math.floor((checkedAt.getTime() - startedAt.getTime()) / 1000),
  );
}

function currentDisplayName(
  interaction: ChatInputCommandInteraction,
): string {
  const member = interaction.member;
  if (member && "displayName" in member && member.displayName) {
    return member.displayName;
  }
  if (member && "nick" in member && member.nick) {
    return member.nick;
  }
  return interaction.user.globalName ?? interaction.user.username;
}

async function milestoneRoleStatus(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  milestoneId: string,
): Promise<string> {
  const definition = config.milestones.definitions.find(
    (milestone) => milestone.id === milestoneId,
  );
  if (!definition?.roleId) {
    return "No role is configured for this milestone.";
  }

  let targetGuild: Guild | null = null;
  if (config.milestones.guildId) {
    targetGuild =
      interaction.client.guilds.cache.get(config.milestones.guildId) ??
      (await interaction.client.guilds
        .fetch(config.milestones.guildId)
        .catch(() => null));
  } else {
    const configuredRoleIds = config.milestones.definitions.flatMap(
      (milestone) => (milestone.roleId ? [milestone.roleId] : []),
    );
    const candidates = [...interaction.client.guilds.cache.values()];
    targetGuild =
      candidates.reduce<Guild | null>((best, candidate) => {
        const candidateCount = configuredRoleIds.filter((roleId) =>
          candidate.roles.cache.has(roleId),
        ).length;
        const bestCount = best
          ? configuredRoleIds.filter((roleId) => best.roles.cache.has(roleId))
              .length
          : -1;
        return candidateCount > bestCount ? candidate : best;
      }, null) ?? guild;
  }

  if (!targetGuild) {
    return "The configured milestone server is unavailable.";
  }

  const role =
    targetGuild.roles.cache.get(definition.roleId) ??
    (await targetGuild.roles.fetch(definition.roleId).catch(() => null));
  if (!role) {
    return "The configured role is not available in the milestone server.";
  }

  const member =
    targetGuild.members.cache.get(interaction.user.id) ??
    (await targetGuild.members.fetch(interaction.user.id).catch(() => null));
  if (!member) {
    return `${role.name} (member is not available in the milestone server)`;
  }

  return `${role.name} (${member.roles.cache.has(role.id) ? "assigned" : "not currently assigned"})`;
}

async function buildProfile(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
): Promise<VoiceCommandResult> {
  const checkedAt = new Date();
  const [user, activeSession] = await Promise.all([
    getUserData(interaction.user.id),
    getActiveVoiceSession(interaction.user.id),
  ]);
  const activeSeconds = currentSessionSeconds(
    activeSession?.startedAt ?? null,
    checkedAt,
  );
  const totalSeconds = (user?.totalVoiceTimeSeconds ?? 0) + activeSeconds;
  const progress = getMilestoneProgress(totalSeconds);
  const currentRole = progress.current
    ? await milestoneRoleStatus(interaction, guild, progress.current.id)
    : "No milestone role yet.";
  const nextMilestone = progress.next
    ? `${progress.next.id} · ${formatVoiceDuration(progress.next.requiredVoiceTimeSeconds)} total`
    : progress.current
      ? "No next milestone — highest configured milestone reached."
      : "No next milestone is configured.";
  const progressText = progress.next
    ? `${progress.progressBar}  ${progress.progressPercent}%\n${formatVoiceDuration(progress.remainingSeconds)} remaining`
    : progress.current
      ? `${progress.progressBar}  100%`
      : `${progress.progressBar}  0%`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({
      name: `${currentDisplayName(interaction)}'s voice profile`,
      iconURL: interaction.user.displayAvatarURL({ size: 256 }),
    })
    .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
    .addFields(
      {
        name: "Total eligible voice time",
        value: formatVoiceDuration(totalSeconds),
        inline: true,
      },
      {
        name: "Current milestone",
        value: progress.current
          ? `${progress.current.id} · ${formatVoiceDuration(progress.current.requiredVoiceTimeSeconds)}`
          : "Not reached",
        inline: true,
      },
      {
        name: "Milestone role",
        value: currentRole,
        inline: true,
      },
      {
        name: "Next milestone",
        value: nextMilestone,
        inline: true,
      },
      {
        name: "Progress",
        value: progressText,
        inline: false,
      },
    );

  return { embeds: [embed] };
}

async function buildVoiceStats(
  interaction: ChatInputCommandInteraction,
): Promise<VoiceCommandResult> {
  const checkedAt = new Date();
  const [user, activeSession, sessionStats] = await Promise.all([
    getUserData(interaction.user.id),
    getActiveVoiceSession(interaction.user.id),
    getVoiceTimeSessionStats(interaction.user.id),
  ]);
  const activeSeconds = currentSessionSeconds(
    activeSession?.startedAt ?? null,
    checkedAt,
  );
  const storedSeconds = user?.totalVoiceTimeSeconds ?? 0;
  const totalSeconds = storedSeconds + activeSeconds;
  const currentSession = activeSession
    ? `Active for ${formatVoiceDuration(activeSeconds)}`
    : "Not currently active";
  const sessionHistory =
    sessionStats.totalSessionRecords > 0
      ? [
          `Recorded sessions: **${sessionStats.totalSessionRecords}** (${sessionStats.completedSessionRecords} completed)`,
          `Average completed session: **${formatVoiceDuration(sessionStats.averageCompletedSessionSeconds)}**`,
          `Longest completed session: **${formatVoiceDuration(sessionStats.longestCompletedSessionSeconds)}**`,
          `First recorded session: ${formatDiscordTimestamp(sessionStats.firstSessionAt)}`,
          `Most recent session: ${formatDiscordTimestamp(sessionStats.mostRecentSessionAt)}`,
        ].join("\n")
      : "No voice-session records are available.";

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${currentDisplayName(interaction)} — voice-time statistics`)
    .addFields(
      {
        name: "Total eligible voice time",
        value: formatVoiceDuration(totalSeconds),
        inline: true,
      },
      {
        name: "Stored completed voice time",
        value: formatVoiceDuration(storedSeconds),
        inline: true,
      },
      {
        name: "Current session",
        value: currentSession,
        inline: true,
      },
      {
        name: "Recorded session history",
        value: sessionHistory,
        inline: false,
      },
    )
    .setFooter({
      text: "Session details come from records currently stored in PostgreSQL; no daily history is inferred.",
    });

  return { embeds: [embed] };
}

async function buildRank(
  interaction: ChatInputCommandInteraction,
): Promise<VoiceCommandResult> {
  const checkedAt = new Date();
  const [user, activeSession, rank] = await Promise.all([
    getUserData(interaction.user.id),
    getActiveVoiceSession(interaction.user.id),
    getVoiceTimeRank(interaction.user.id, checkedAt),
  ]);

  if (rank === null || !user) {
    return {
      content: "You do not have a stored voice-time record yet, so no rank is available.",
    };
  }

  const totalSeconds =
    user.totalVoiceTimeSeconds +
    currentSessionSeconds(activeSession?.startedAt ?? null, checkedAt);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${currentDisplayName(interaction)}'s voice-time rank`)
    .setDescription(`**Position:** #${rank}\n**Eligible voice time:** ${formatVoiceDuration(totalSeconds)}`)
    .setFooter({
      text: "Rank uses cumulative eligible voice time, including the current active session.",
    });

  return { embeds: [embed] };
}

function leaderboardName(guild: Guild, discordUserId: string): string {
  const member = guild.members.cache.get(discordUserId);
  if (member) {
    return member.displayName;
  }
  const user = guild.client.users.cache.get(discordUserId);
  if (user) {
    return `${user.globalName ?? user.username} (not in this server)`;
  }
  return `Unavailable member (${discordUserId})`;
}

async function buildLeaderboard(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
): Promise<VoiceCommandResult> {
  const checkedAt = new Date();
  const [entries, userRank] = await Promise.all([
    getVoiceTimeLeaderboardData(10, checkedAt),
    getVoiceTimeRank(interaction.user.id, checkedAt),
  ]);

  if (entries.length === 0) {
    return { content: "There are no stored voice-time records yet." };
  }

  const rows = entries.map(
    (entry, index) =>
      `**${index + 1}.** ${leaderboardName(guild, entry.discordUserId)} — ${formatVoiceDuration(entry.value)}`,
  );
  const requesterInTopTen = entries.some(
    (entry) => entry.discordUserId === interaction.user.id,
  );
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Eligible voice-time leaderboard")
    .setDescription(rows.join("\n"))
    .setFooter({
      text: "Cumulative voice time includes active sessions; ties are ordered by Discord user ID.",
    });

  if (userRank === null) {
    embed.addFields({
      name: "Your position",
      value: "No stored voice-time record yet.",
    });
  } else if (!requesterInTopTen) {
    const [user, activeSession] = await Promise.all([
      getUserData(interaction.user.id),
      getActiveVoiceSession(interaction.user.id),
    ]);
    const totalSeconds =
      (user?.totalVoiceTimeSeconds ?? 0) +
      currentSessionSeconds(activeSession?.startedAt ?? null, checkedAt);
    embed.addFields({
      name: "Your position",
      value: `#${userRank} — ${formatVoiceDuration(totalSeconds)}`,
    });
  }

  return { embeds: [embed] };
}

const commandHandlers: Record<
  string,
  (
    interaction: ChatInputCommandInteraction,
    guild: Guild,
  ) => Promise<VoiceCommandResult>
> = {
  profile: buildProfile,
  voicestats: buildVoiceStats,
  rank: buildRank,
  leaderboard: buildLeaderboard,
};

export async function handleVoiceCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const handler = commandHandlers[interaction.commandName];
  if (!handler) {
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({
      content: "Use this command in a Discord server.",
      ephemeral: true,
    });
    return;
  }

  try {
    await interaction.deferReply();
    const result = await handler(interaction, interaction.guild);
    await interaction.editReply(result);
  } catch (error) {
    logger.error(
      { err: error, commandName: interaction.commandName },
      "Could not complete a voice-time slash command.",
    );
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(
          "Voice-time data is temporarily unavailable. Please try again later.",
        );
      } else {
        await interaction.reply({
          content:
            "Voice-time data is temporarily unavailable. Please try again later.",
          ephemeral: true,
        });
      }
    } catch {
      logger.warn(
        { commandName: interaction.commandName },
        "Could not send the voice-time command error response.",
      );
    }
  }
}

export async function registerVoiceSlashCommands(
  client: Client,
): Promise<void> {
  const application = client.application;
  if (!application) {
    throw new Error("Discord application is not ready for command registration.");
  }

  const manager = application.commands;
  const existingCommands = await manager.fetch();
  for (const builder of voiceSlashCommandBuilders) {
    const payload = builder.toJSON();
    const existing = existingCommands.find(
      (command) =>
        command.name === payload.name &&
        command.type === ApplicationCommandType.ChatInput,
    );

    if (!existing) {
      await manager.create(payload);
      continue;
    }

    const definitionChanged =
      existing.description !== payload.description ||
      JSON.stringify(existing.options ?? []) !==
        JSON.stringify(payload.options ?? []);
    if (definitionChanged) {
      await manager.edit(existing.id, payload);
    }
  }
}
