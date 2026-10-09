import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProgressBar,
  formatVoiceDuration,
  getMilestoneProgress,
  voiceSlashCommandBuilders,
} from "../src/commands/voice-command-utils.js";

test("voice duration formatting uses readable days, hours, and minutes", () => {
  assert.equal(formatVoiceDuration(0), "0m");
  assert.equal(formatVoiceDuration(59), "0m");
  assert.equal(formatVoiceDuration(3_661), "1h 1m");
  assert.equal(formatVoiceDuration(90_061), "1d 1h 1m");
  assert.equal(formatVoiceDuration(-10), "0m");
});

test("milestone progress reports the next threshold and remaining time", () => {
  const progress = getMilestoneProgress(90 * 60);

  assert.equal(progress.current?.id, "1");
  assert.equal(progress.next?.id, "2");
  assert.equal(progress.remainingSeconds, 30 * 60);
  assert.equal(progress.progressPercent, 50);
  assert.equal(progress.progressBar, `${"█".repeat(10)}${"░".repeat(10)}`);
});

test("highest configured milestone has no next milestone", () => {
  const progress = getMilestoneProgress(150 * 60 * 60);

  assert.equal(progress.current?.id, "10");
  assert.equal(progress.next, null);
  assert.equal(progress.remainingSeconds, 0);
  assert.equal(progress.progressPercent, 100);
  assert.equal(buildProgressBar(progress.progressPercent), "█".repeat(20));
});

test("only the four Step 6 voice-time slash commands are registered", () => {
  assert.deepEqual(
    voiceSlashCommandBuilders.map((command) => command.name),
    ["profile", "voicestats", "rank", "leaderboard"],
  );
});
