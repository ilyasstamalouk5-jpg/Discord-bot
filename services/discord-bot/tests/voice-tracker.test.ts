import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  ChannelType,
  Events,
  type Client,
  type Guild,
  type VoiceState,
} from "discord.js";
import {
  VoiceSessionTracker,
  type VoiceSessionStore,
} from "../src/voice/voice-tracker.js";

const GUILD_ID = "100000000000000001";
const BOT_ID = "100000000000000002";
const USER_ID = "100000000000000003";
const NORMAL_CHANNEL_ID = "100000000000000004";
const SECOND_CHANNEL_ID = "100000000000000005";
const GUILD_AFK_CHANNEL_ID = "100000000000000007";
const DEPARTED_USER_ID = "100000000000000008";
const START_TIME = new Date("2026-01-01T00:00:00.000Z");

type TestSession = {
  discordUserId: string;
  voiceChannelId: string;
  startedAt: Date;
  active: boolean;
  endedAt: Date | null;
  lastSeenAt?: Date | null;
};

class MemoryVoiceSessionStore implements VoiceSessionStore {
  readonly sessions: TestSession[] = [];
  readonly totals = new Map<string, number>();
  failNextStart = false;

  async getActiveVoiceSession(discordUserId: string) {
    const session = this.sessions.find(
      (candidate) =>
        candidate.discordUserId === discordUserId && candidate.active,
    );
    return session ? this.asActiveSession(session) : null;
  }

  async getAllActiveVoiceSessions() {
    return this.sessions
      .filter((session) => session.active)
      .map((session) => this.asActiveSession(session));
  }

  async upsertActiveVoiceSession(input: {
    discordUserId: string;
    voiceChannelId: string;
    startedAt: Date;
  }) {
    const current = this.sessions.find(
      (session) =>
        session.discordUserId === input.discordUserId && session.active,
    );
    if (current) {
      current.voiceChannelId = input.voiceChannelId;
      return this.asActiveSession(current);
    }
    return this.createSession(input);
  }

  async startActiveVoiceSession(input: {
    discordUserId: string;
    voiceChannelId: string;
    startedAt: Date;
  }) {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("Simulated database failure.");
    }

    const current = this.sessions.find(
      (session) =>
        session.discordUserId === input.discordUserId && session.active,
    );
    if (current) {
      current.voiceChannelId = input.voiceChannelId;
      current.startedAt = input.startedAt;
      current.endedAt = null;
      return this.asActiveSession(current);
    }
    return this.createSession(input);
  }

  async endActiveVoiceSession(discordUserId: string, endedAt: Date) {
    const current = this.sessions.find(
      (session) => session.discordUserId === discordUserId && session.active,
    );
    if (!current) {
      return null;
    }

    const effectiveEndedAt =
      endedAt.getTime() < current.startedAt.getTime()
        ? current.startedAt
        : endedAt;
    current.active = false;
    current.endedAt = effectiveEndedAt;
    const seconds = Math.floor(
      (effectiveEndedAt.getTime() - current.startedAt.getTime()) / 1000,
    );
    this.totals.set(
      discordUserId,
      (this.totals.get(discordUserId) ?? 0) + seconds,
    );
    return this.asActiveSession(current);
  }

  private createSession(input: {
    discordUserId: string;
    voiceChannelId: string;
    startedAt: Date;
  }) {
    const session: TestSession = {
      ...input,
      active: true,
      endedAt: null,
    };
    this.sessions.push(session);
    return this.asActiveSession(session);
  }

  private asActiveSession(session: TestSession) {
    return {
      discordUserId: session.discordUserId,
      voiceChannelId: session.voiceChannelId,
      startedAt: session.startedAt,
      lastSeenAt: session.lastSeenAt ?? null,
    };
  }
}

type TestGuild = {
  id: string;
  afkChannelId: string | null;
  channels: { cache: Map<string, { type: ChannelType }> };
  voiceStates: { cache: Map<string, VoiceState> };
};

function createEnvironment(guildAfkChannelId: string | null = null) {
  const guild: TestGuild = {
    id: GUILD_ID,
    afkChannelId: guildAfkChannelId,
    channels: { cache: new Map() },
    voiceStates: { cache: new Map() },
  };
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    guilds: { cache: new Map([[GUILD_ID, guild]]) },
    user: { id: BOT_ID },
  }) as unknown as Client;

  return {
    client,
    emitter,
    guild,
    state(
      discordUserId: string,
      channelId: string | null,
      options: {
        channelType?: ChannelType;
        channelCached?: boolean;
        bot?: boolean;
        muted?: boolean;
        deafened?: boolean;
      } = {},
    ): VoiceState {
      return {
        id: discordUserId,
        channelId,
        guild: guild as unknown as Guild,
        channel:
          channelId && options.channelCached !== false
            ? ({ type: options.channelType ?? ChannelType.GuildVoice } as never)
            : null,
        member: { user: { bot: options.bot ?? false } } as never,
        selfMute: options.muted ?? false,
        selfDeaf: options.deafened ?? false,
        serverMute: false,
        serverDeaf: false,
      } as unknown as VoiceState;
    },
  };
}

function createClock(initialTime: Date) {
  let currentTime = new Date(initialTime);
  return {
    now: () => new Date(currentTime),
    set: (time: Date) => {
      currentTime = new Date(time);
    },
  };
}

async function startTracker(input: {
  store?: MemoryVoiceSessionStore;
  guildAfkChannelId?: string | null;
  initialVoiceStates?: VoiceState[];
  clock?: () => Date;
}) {
  const environment = createEnvironment(input.guildAfkChannelId ?? null);
  for (const state of input.initialVoiceStates ?? []) {
    environment.guild.voiceStates.cache.set(state.id, state);
  }
  const store = input.store ?? new MemoryVoiceSessionStore();
  const tracker = new VoiceSessionTracker(
    environment.client,
    store,
    input.clock,
  );
  tracker.attach();
  environment.emitter.emit(Events.ClientReady, environment.client);
  await tracker.waitForRecovery();
  return { ...environment, store, tracker };
}

function emitVoiceState(
  emitter: EventEmitter,
  oldState: VoiceState,
  newState: VoiceState,
): void {
  emitter.emit(Events.VoiceStateUpdate, oldState, newState);
}

test("records exact elapsed seconds after a normal voice-channel join and leave", async () => {
  const clock = createClock(START_TIME);
  const env = createEnvironment();
  const store = new MemoryVoiceSessionStore();
  const tracker = new VoiceSessionTracker(
    env.client,
    store,
    clock.now,
  );
  tracker.attach();
  env.emitter.emit(Events.ClientReady, env.client);
  await tracker.waitForRecovery();

  const disconnected = env.state(USER_ID, null);
  const joined = env.state(USER_ID, NORMAL_CHANNEL_ID);
  emitVoiceState(env.emitter, disconnected, joined);
  clock.set(new Date(START_TIME.getTime() + 30 * 60 * 1000));
  emitVoiceState(env.emitter, joined, disconnected);
  await tracker.stop();

  assert.equal(store.totals.get(USER_ID), 30 * 60);
  assert.equal(store.sessions.length, 1);
  assert.equal(store.sessions[0]?.active, false);
});

test("moving between normal channels preserves one continuous session", async () => {
  const clock = createClock(START_TIME);
  const { emitter, state, store, tracker } = await startTracker({
    clock: clock.now,
  });

  const disconnected = state(USER_ID, null);
  const firstChannel = state(USER_ID, NORMAL_CHANNEL_ID);
  const secondChannel = state(USER_ID, SECOND_CHANNEL_ID);
  emitVoiceState(emitter, disconnected, firstChannel);
  clock.set(new Date(START_TIME.getTime() + 10 * 60 * 1000));
  emitVoiceState(emitter, firstChannel, secondChannel);
  clock.set(new Date(START_TIME.getTime() + 30 * 60 * 1000));
  emitVoiceState(emitter, secondChannel, disconnected);
  await tracker.stop();

  assert.equal(store.totals.get(USER_ID), 30 * 60);
  assert.equal(store.sessions.length, 1);
  assert.equal(
    store.sessions[0]?.startedAt.getTime(),
    START_TIME.getTime(),
  );
  assert.equal(store.sessions[0]?.voiceChannelId, SECOND_CHANNEL_ID);
});

test("time in the server AFK channel counts like any other voice channel", async () => {
  const clock = createClock(START_TIME);
  const { emitter, state, store, tracker } = await startTracker({
    clock: clock.now,
    guildAfkChannelId: GUILD_AFK_CHANNEL_ID,
  });

  const disconnected = state(USER_ID, null);
  const normal = state(USER_ID, NORMAL_CHANNEL_ID);
  const afk = state(USER_ID, GUILD_AFK_CHANNEL_ID);
  emitVoiceState(emitter, disconnected, normal);
  clock.set(new Date(START_TIME.getTime() + 10 * 60 * 1000));
  emitVoiceState(emitter, normal, afk);
  clock.set(new Date(START_TIME.getTime() + 30 * 60 * 1000));
  emitVoiceState(emitter, afk, disconnected);
  await tracker.stop();

  assert.equal(store.totals.get(USER_ID), 30 * 60);
  assert.equal(store.sessions.length, 1);
});

test("muted, deafened, alone, and uncached private-channel states continue counting", async () => {
  const clock = createClock(START_TIME);
  const env = createEnvironment();
  const store = new MemoryVoiceSessionStore();
  const tracker = new VoiceSessionTracker(
    env.client,
    store,
    clock.now,
  );
  tracker.attach();
  env.emitter.emit(Events.ClientReady, env.client);
  await tracker.waitForRecovery();

  const disconnected = env.state(USER_ID, null);
  const muted = env.state(USER_ID, NORMAL_CHANNEL_ID, {
    channelCached: false,
    muted: true,
  });
  const deafened = env.state(USER_ID, NORMAL_CHANNEL_ID, {
    channelCached: false,
    muted: true,
    deafened: true,
  });
  emitVoiceState(env.emitter, disconnected, muted);
  clock.set(new Date(START_TIME.getTime() + 30 * 60 * 1000));
  emitVoiceState(env.emitter, muted, deafened);
  emitVoiceState(env.emitter, deafened, disconnected);
  await tracker.stop();

  assert.equal(store.totals.get(USER_ID), 30 * 60);
  assert.equal(store.sessions.length, 1);
});

test("stage voice states are counted", async () => {
  const clock = createClock(START_TIME);
  const env = createEnvironment();
  const store = new MemoryVoiceSessionStore();
  const tracker = new VoiceSessionTracker(
    env.client,
    store,
    clock.now,
  );
  tracker.attach();
  env.emitter.emit(Events.ClientReady, env.client);
  await tracker.waitForRecovery();

  const disconnected = env.state(USER_ID, null);
  const stage = env.state(USER_ID, NORMAL_CHANNEL_ID, {
    channelType: ChannelType.GuildStageVoice,
  });
  emitVoiceState(env.emitter, disconnected, stage);
  clock.set(new Date(START_TIME.getTime() + 60_000));
  emitVoiceState(env.emitter, stage, disconnected);
  await tracker.stop();

  assert.equal(store.totals.get(USER_ID), 60);
});

test("restart resets live sessions to startup time and discards stale downtime", async () => {
  const bootTime = new Date(START_TIME.getTime() + 12 * 60 * 60 * 1000);
  const clock = createClock(bootTime);
  const store = new MemoryVoiceSessionStore();
  store.totals.set(USER_ID, 3_600);
  await store.startActiveVoiceSession({
    discordUserId: USER_ID,
    voiceChannelId: NORMAL_CHANNEL_ID,
    startedAt: START_TIME,
  });
  await store.startActiveVoiceSession({
    discordUserId: BOT_ID,
    voiceChannelId: SECOND_CHANNEL_ID,
    startedAt: START_TIME,
  });

  const env = createEnvironment();
  const connected = env.state(USER_ID, NORMAL_CHANNEL_ID);
  env.guild.voiceStates.cache.set(USER_ID, connected);
  const tracker = new VoiceSessionTracker(env.client, store, clock.now);
  tracker.attach();
  env.emitter.emit(Events.ClientReady, env.client);
  await tracker.waitForRecovery();

  assert.equal(
    store.sessions.find((session) => session.discordUserId === USER_ID)
      ?.startedAt.getTime(),
    bootTime.getTime(),
  );
  assert.equal(
    store.sessions.find((session) => session.discordUserId === BOT_ID)
      ?.endedAt?.getTime(),
    START_TIME.getTime(),
  );

  clock.set(new Date(bootTime.getTime() + 30_000));
  emitVoiceState(env.emitter, connected, env.state(USER_ID, null));
  await tracker.stop();

  assert.equal(store.totals.get(USER_ID), 3_630);
  assert.equal(store.totals.get(BOT_ID) ?? 0, 0);
});

test("crash recovery keeps time up to the last heartbeat and discards downtime", async () => {
  const bootTime = new Date(START_TIME.getTime() + 12 * 60 * 60 * 1000);
  const clock = createClock(bootTime);
  const store = new MemoryVoiceSessionStore();
  // Still in voice after the restart; last heartbeat 10 minutes after joining.
  store.sessions.push({
    discordUserId: USER_ID,
    voiceChannelId: NORMAL_CHANNEL_ID,
    startedAt: START_TIME,
    active: true,
    endedAt: null,
    lastSeenAt: new Date(START_TIME.getTime() + 10 * 60 * 1000),
  });
  // Left while the bot was down; last heartbeat 20 minutes after joining.
  store.sessions.push({
    discordUserId: DEPARTED_USER_ID,
    voiceChannelId: NORMAL_CHANNEL_ID,
    startedAt: START_TIME,
    active: true,
    endedAt: null,
    lastSeenAt: new Date(START_TIME.getTime() + 20 * 60 * 1000),
  });

  const env = createEnvironment();
  const connected = env.state(USER_ID, NORMAL_CHANNEL_ID);
  env.guild.voiceStates.cache.set(USER_ID, connected);
  const tracker = new VoiceSessionTracker(env.client, store, clock.now);
  tracker.attach();
  env.emitter.emit(Events.ClientReady, env.client);
  await tracker.waitForRecovery();

  assert.equal(store.totals.get(USER_ID), 10 * 60);
  assert.equal(store.totals.get(DEPARTED_USER_ID), 20 * 60);
  assert.equal(
    store.sessions.filter(
      (session) => session.discordUserId === USER_ID && session.active,
    )[0]?.startedAt.getTime(),
    bootTime.getTime(),
  );

  clock.set(new Date(bootTime.getTime() + 30_000));
  emitVoiceState(env.emitter, connected, env.state(USER_ID, null));
  await tracker.stop();

  assert.equal(store.totals.get(USER_ID), 10 * 60 + 30);
});

test("duplicate join events cannot create multiple active sessions", async () => {
  const clock = createClock(START_TIME);
  const { emitter, state, store, tracker } = await startTracker({
    clock: clock.now,
  });

  const disconnected = state(USER_ID, null);
  const joined = state(USER_ID, NORMAL_CHANNEL_ID);
  emitVoiceState(emitter, disconnected, joined);
  clock.set(new Date(START_TIME.getTime() + 5_000));
  emitVoiceState(emitter, disconnected, joined);
  await tracker.stop();

  assert.equal(
    store.sessions.filter((session) => session.active).length,
    0,
  );
  assert.equal(store.sessions.length, 1);
  assert.equal(store.sessions[0]?.startedAt.getTime(), START_TIME.getTime());
});

test("a database failure for one voice event does not throw through the gateway listener", async () => {
  const clock = createClock(START_TIME);
  const store = new MemoryVoiceSessionStore();
  store.failNextStart = true;
  const { emitter, state, tracker } = await startTracker({
    store,
    clock: clock.now,
  });

  assert.doesNotThrow(() => {
    emitVoiceState(
      emitter,
      state(USER_ID, null),
      state(USER_ID, NORMAL_CHANNEL_ID),
    );
  });
  await tracker.stop();

  assert.equal(store.sessions.length, 0);
});
