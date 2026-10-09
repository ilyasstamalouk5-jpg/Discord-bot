import { ChannelType, Client, Events, type VoiceState } from "discord.js";
import type { DiscordBotVoiceSession } from "../database/index.js";
import { logger } from "../config/logger.js";

type ActiveVoiceSession = Pick<
  DiscordBotVoiceSession,
  "discordUserId" | "voiceChannelId" | "startedAt"
> & {
  // Last heartbeat. Missing for sessions stored before heartbeats existed.
  lastSeenAt?: Date | null;
};

const HEARTBEAT_INTERVAL_MS = 60_000;

type VoiceSessionInput = {
  discordUserId: string;
  voiceChannelId: string;
  startedAt: Date;
};

export interface VoiceSessionStore {
  getActiveVoiceSession(discordUserId: string): Promise<ActiveVoiceSession | null>;
  getAllActiveVoiceSessions(): Promise<ActiveVoiceSession[]>;
  upsertActiveVoiceSession(
    input: VoiceSessionInput,
  ): Promise<ActiveVoiceSession>;
  startActiveVoiceSession(
    input: VoiceSessionInput,
  ): Promise<ActiveVoiceSession>;
  endActiveVoiceSession(
    discordUserId: string,
    endedAt: Date,
  ): Promise<ActiveVoiceSession | null>;
  // Optional heartbeat: marks all active sessions as alive at the given time.
  touchActiveVoiceSessions?(at: Date): Promise<void>;
}

type CurrentVoiceChannel = {
  discordUserId: string;
  voiceChannelId: string;
};

export class VoiceSessionTracker {
  private readonly pendingByUser = new Map<string, Promise<void>>();
  private readonly processOwnedUsers = new Set<string>();
  private readonly recoveryBarrier: Promise<void>;
  private resolveRecoveryBarrier!: () => void;
  private recoveryPromise: Promise<void> | null = null;
  private recoverySucceeded = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private attached = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly client: Client,
    private readonly store: VoiceSessionStore,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.recoveryBarrier = new Promise((resolve) => {
      this.resolveRecoveryBarrier = resolve;
    });
  }

  attach(): void {
    if (this.attached) {
      return;
    }
    this.attached = true;

    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      this.enqueueVoiceStateUpdate(oldState, newState);
    });

    this.client.once(Events.ClientReady, () => {
      if (this.stopping) {
        this.resolveRecoveryBarrier();
        return;
      }
      this.recoveryPromise = this.recoverCurrentVoiceStates().catch((error) => {
        this.recoverySucceeded = false;
        logger.error(
          { err: error },
          "Voice-session recovery failed; live events will resynchronize sessions safely.",
        );
      });
      void this.recoveryPromise.finally(() => {
        this.startHeartbeat();
        this.resolveRecoveryBarrier();
      });
    });
  }

  async waitForRecovery(): Promise<void> {
    if (this.recoveryPromise) {
      await this.recoveryPromise;
      return;
    }
    await this.recoveryBarrier;
  }

  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopping = true;
    this.stopHeartbeat();
    this.stopPromise = this.stopTracking();
    return this.stopPromise;
  }

  private async stopTracking(): Promise<void> {
    if (this.recoveryPromise) {
      await this.recoveryPromise;
    } else {
      this.resolveRecoveryBarrier();
    }

    await Promise.allSettled(this.pendingByUser.values());

    let activeSessions: ActiveVoiceSession[];
    try {
      activeSessions = await this.store.getAllActiveVoiceSessions();
    } catch {
      logger.error("Could not load active voice sessions during shutdown.");
      return;
    }

    const shutdownAt = this.clock();
    for (const session of activeSessions) {
      const endedAt = this.processOwnedUsers.has(session.discordUserId)
        ? shutdownAt
        : session.startedAt;
      try {
        await this.store.endActiveVoiceSession(session.discordUserId, endedAt);
        this.processOwnedUsers.delete(session.discordUserId);
      } catch {
        logger.error("Could not finalize an active voice session during shutdown.");
      }
    }
  }

  private startHeartbeat(): void {
    const touch = this.store.touchActiveVoiceSessions?.bind(this.store);
    if (!touch || this.stopping || this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      touch(this.clock()).catch((error: unknown) => {
        logger.warn({ err: error }, "Voice-session heartbeat failed.");
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private enqueueVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
  ): void {
    if (this.stopping) {
      return;
    }

    const discordUserId = newState.id || oldState.id;
    if (
      !discordUserId ||
      discordUserId === this.client.user?.id ||
      oldState.member?.user.bot ||
      newState.member?.user.bot
    ) {
      return;
    }

    const eventAt = this.clock();
    const previous = this.pendingByUser.get(discordUserId) ?? Promise.resolve();
    let queued: Promise<void>;
    queued = previous
      .catch(() => undefined)
      .then(async () => {
        await this.recoveryBarrier;
        await this.processVoiceStateUpdate(
          discordUserId,
          oldState,
          newState,
          eventAt,
        );
      })
      .catch((error: unknown) => {
        logger.error(
          { err: error },
          "Could not process a Discord voice-state update.",
        );
      })
      .finally(() => {
        if (this.pendingByUser.get(discordUserId) === queued) {
          this.pendingByUser.delete(discordUserId);
        }
      });
    this.pendingByUser.set(discordUserId, queued);
  }

  private async processVoiceStateUpdate(
    discordUserId: string,
    oldState: VoiceState,
    newState: VoiceState,
    eventAt: Date,
  ): Promise<void> {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) {
      logger.warn("Ignored a voice-state update without guild data.");
      return;
    }

    const wasEligible = this.isEligibleVoiceState(oldState);
    const isEligible = this.isEligibleVoiceState(newState);
    const voiceChannelId = newState.channelId;

    if (wasEligible && isEligible && voiceChannelId) {
      if (this.processOwnedUsers.has(discordUserId)) {
        if (oldState.channelId !== voiceChannelId) {
          await this.store.upsertActiveVoiceSession({
            discordUserId,
            voiceChannelId,
            startedAt: eventAt,
          });
        }
      } else {
        // If recovery or an earlier database operation was incomplete, start
        // from this known event rather than risk counting time while offline.
        await this.store.startActiveVoiceSession({
          discordUserId,
          voiceChannelId,
          startedAt: eventAt,
        });
        this.processOwnedUsers.add(discordUserId);
      }
      return;
    }

    if (wasEligible && !isEligible) {
      const activeSession =
        await this.store.getActiveVoiceSession(discordUserId);
      if (!activeSession) {
        this.processOwnedUsers.delete(discordUserId);
        return;
      }

      const endedAt = this.processOwnedUsers.has(discordUserId)
        ? eventAt
        : activeSession.startedAt;
      this.processOwnedUsers.delete(discordUserId);
      await this.store.endActiveVoiceSession(discordUserId, endedAt);
      return;
    }

    if (!wasEligible && isEligible && voiceChannelId) {
      if (this.processOwnedUsers.has(discordUserId)) {
        const activeSession =
          await this.store.getActiveVoiceSession(discordUserId);
        if (activeSession?.voiceChannelId === voiceChannelId) {
          return;
        }
      }
      await this.store.startActiveVoiceSession({
        discordUserId,
        voiceChannelId,
        startedAt: eventAt,
      });
      this.processOwnedUsers.add(discordUserId);
    }
  }

  private isEligibleVoiceState(state: VoiceState): boolean {
    const { channelId, guild } = state;
    if (!channelId?.trim() || !guild) {
      return false;
    }

    // A missing cached channel can occur for private channels. The gateway
    // voice state still identifies the channel, so trust its channel ID.
    const channelType =
      state.channel?.type ?? guild.channels.cache.get(channelId)?.type;
    return (
      channelType === undefined ||
      channelType === ChannelType.GuildVoice ||
      channelType === ChannelType.GuildStageVoice
    );
  }

  private async recoverCurrentVoiceStates(): Promise<void> {
    const currentByUser = this.getCurrentEligibleVoiceChannels();
    let recoverySucceeded = true;
    let previousSessions: ActiveVoiceSession[] = [];

    try {
      previousSessions = await this.store.getAllActiveVoiceSessions();
    } catch (error) {
      recoverySucceeded = false;
      logger.error(
        { err: error },
        "Could not read active voice sessions during startup recovery.",
      );
    }

    for (const session of previousSessions) {
      const stillConnected = currentByUser.has(session.discordUserId);
      if (stillConnected && !session.lastSeenAt) {
        // No heartbeat is stored (older data): the fresh session started below
        // replaces it, so downtime is never charged.
        continue;
      }

      try {
        // The previous process may have stopped unexpectedly. Close the old
        // session at its last heartbeat: the time up to then is kept, and the
        // downtime after it is not charged.
        await this.store.endActiveVoiceSession(
          session.discordUserId,
          session.lastSeenAt ?? session.startedAt,
        );
      } catch (error) {
        recoverySucceeded = false;
        logger.error(
          { err: error },
          "Could not close a stale voice session during recovery.",
        );
      }
    }

    const recoveryStartedAt = this.clock();
    for (const current of currentByUser.values()) {
      try {
        await this.store.startActiveVoiceSession({
          ...current,
          startedAt: recoveryStartedAt,
        });
        this.processOwnedUsers.add(current.discordUserId);
      } catch (error) {
        recoverySucceeded = false;
        logger.error({ err: error }, "Could not restore an active voice session.");
      }
    }

    this.recoverySucceeded = recoverySucceeded;
    logger.info(
      {
        recoveredUsers: this.processOwnedUsers.size,
        recoverySucceeded,
      },
      "Voice-session recovery finished.",
    );
  }

  private getCurrentEligibleVoiceChannels(): Map<string, CurrentVoiceChannel> {
    const currentByUser = new Map<string, CurrentVoiceChannel>();

    for (const guild of this.client.guilds.cache.values()) {
      for (const state of guild.voiceStates.cache.values()) {
        if (
          !state.channelId ||
          state.member?.user.bot ||
          state.id === this.client.user?.id ||
          !this.isEligibleVoiceState(state)
        ) {
          continue;
        }

        if (currentByUser.has(state.id)) {
          logger.warn(
            "A user has eligible voice states in multiple guilds; keeping one active session to prevent duplicate accounting.",
          );
          continue;
        }

        currentByUser.set(state.id, {
          discordUserId: state.id,
          voiceChannelId: state.channelId,
        });
      }
    }

    return currentByUser;
  }
}
