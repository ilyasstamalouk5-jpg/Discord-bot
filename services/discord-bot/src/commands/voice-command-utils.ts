import { SlashCommandBuilder } from "discord.js";
import { config } from "../config/index.js";
import type { MilestoneDefinition } from "../milestones/types.js";

export const voiceSlashCommandBuilders = [
  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("View your eligible voice-time profile and milestone progress."),
  new SlashCommandBuilder()
    .setName("voicestats")
    .setDescription("View your recorded eligible voice-time statistics."),
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("View your position by cumulative eligible voice time."),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View the top 10 members by eligible voice time."),
];

export function formatVoiceDuration(seconds: number): string {
  const wholeMinutes = Math.floor(
    Math.max(0, Number.isFinite(seconds) ? seconds : 0) / 60,
  );
  const days = Math.floor(wholeMinutes / (24 * 60));
  const hours = Math.floor((wholeMinutes % (24 * 60)) / 60);
  const minutes = wholeMinutes % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`);
  }

  return parts.join(" ");
}

export function buildProgressBar(percent: number, width = 20): string {
  const boundedWidth = Math.max(1, Math.floor(width));
  const boundedPercent = Math.min(
    100,
    Math.max(0, Number.isFinite(percent) ? percent : 0),
  );
  const filled = Math.round((boundedPercent / 100) * boundedWidth);
  return `${"█".repeat(filled)}${"░".repeat(boundedWidth - filled)}`;
}

export function getMilestoneProgress(
  totalVoiceTimeSeconds: number,
  definitions: readonly MilestoneDefinition[] = config.milestones.definitions,
) {
  const total = Math.max(
    0,
    Number.isFinite(totalVoiceTimeSeconds)
      ? Math.floor(totalVoiceTimeSeconds)
      : 0,
  );
  const ordered = [...definitions].sort(
    (left, right) =>
      left.requiredVoiceTimeSeconds - right.requiredVoiceTimeSeconds,
  );
  const current =
    ordered
      .filter((milestone) => milestone.requiredVoiceTimeSeconds <= total)
      .at(-1) ?? null;
  const next =
    ordered.find((milestone) => milestone.requiredVoiceTimeSeconds > total) ??
    null;
  const previousThreshold = current?.requiredVoiceTimeSeconds ?? 0;
  const span = next
    ? next.requiredVoiceTimeSeconds - previousThreshold
    : 0;
  const progressPercent = next
    ? Math.floor(
        Math.min(
          1,
          Math.max(0, (total - previousThreshold) / Math.max(1, span)),
        ) * 100,
      )
    : current
      ? 100
      : 0;

  return {
    current,
    next,
    remainingSeconds: next
      ? Math.max(0, next.requiredVoiceTimeSeconds - total)
      : 0,
    progressPercent,
    progressBar: buildProgressBar(progressPercent),
  };
}

export function formatDiscordTimestamp(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) {
    return "No recorded session history";
  }
  return `<t:${Math.floor(date.getTime() / 1000)}:F>`;
}
