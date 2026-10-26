import { expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import { ensureVoiceConnectionRecovery } from '../commands/play';
import { isDiscordVoiceListener, startDiscordVoiceReceiver } from './discordVoiceRuntime';

test('listen-only connections receive a single recovery handler and rejoin after a disconnect', async () => {
  let rejoins = 0;
  const connection = Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Disconnected },
    rejoinAttempts: 0,
    joinConfig: { channelId: 'test-channel' },
    rejoin() {
      rejoins += 1;
      this.state.status = VoiceConnectionStatus.Ready;
      return true;
    },
  }) as unknown as VoiceConnection;
  ensureVoiceConnectionRecovery(connection, 'test-guild', 'Test');
  ensureVoiceConnectionRecovery(connection, 'test-guild', 'Test');
  expect(connection.listenerCount(VoiceConnectionStatus.Disconnected)).toBe(1);
  expect(connection.listenerCount('stateChange')).toBe(1);
  expect(connection.listenerCount('error')).toBe(1);
  connection.emit(VoiceConnectionStatus.Disconnected, {}, { reason: 'network failure' });
  await Promise.resolve();
  expect(rejoins).toBe(1);
  expect(connection.state.status).toBe(VoiceConnectionStatus.Ready);
});

test('only active, enabled voice receivers keep the connection for listening', () => {
  const keys = ['VOICE_COMMANDS_ENABLED', 'VOICE_SAMPLE_COLLECTION_ENABLED', 'VOICE_SAMPLE_COLLECTION_DIR'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const connection = Object.assign(new EventEmitter(), {
    receiver: { speaking: new EventEmitter() },
  }) as unknown as VoiceConnection;
  try {
    process.env.VOICE_COMMANDS_ENABLED = 'false';
    process.env.VOICE_SAMPLE_COLLECTION_ENABLED = 'true';
    process.env.VOICE_SAMPLE_COLLECTION_DIR = './voice-samples';
    expect(isDiscordVoiceListener(connection)).toBe(false);
    startDiscordVoiceReceiver(connection, 'test-guild');
    expect(isDiscordVoiceListener(connection)).toBe(true);
    process.env.VOICE_SAMPLE_COLLECTION_ENABLED = 'false';
    expect(isDiscordVoiceListener(connection)).toBe(false);
    process.env.VOICE_COMMANDS_ENABLED = 'true';
    expect(isDiscordVoiceListener(connection)).toBe(true);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
