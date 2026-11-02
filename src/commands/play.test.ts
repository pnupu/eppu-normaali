import { expect, spyOn, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { getVoiceConnections, VoiceConnectionStatus, type AudioPlayer, type VoiceConnection } from '@discordjs/voice';
import { Collection, type Client } from 'discord.js';
import { MusicQueue } from '../music/queue';
import { checkAndLeaveIfNeeded, ensureVoiceConnectionRecovery, queues } from './play';

test('playback connections receive a single recovery handler and rejoin after a disconnect', async () => {
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

for (const scenario of [
  { name: 'keeps music playback with a human present', humans: 1, music: true, leave: false },
  { name: 'leaves an empty channel during playback', humans: 0, music: true, leave: true },
  { name: 'leaves after the music queue empties', humans: 1, music: false, leave: true },
]) {
  test(scenario.name, () => {
    const guildId = `cleanup-${scenario.humans}-${scenario.music}`;
    let destroyed = false;
    let stopped = false;
    const connection = {
      state: { status: VoiceConnectionStatus.Ready },
      destroy() { destroyed = true; },
    } as unknown as VoiceConnection;
    const player = {
      state: { status: scenario.music ? 'playing' : 'idle' },
      stop() { stopped = true; },
    } as unknown as AudioPlayer;
    const queue = new MusicQueue(player);
    if (scenario.music) {
      queue.addSong({
        title: 'Fixture song', url: 'https://www.youtube.com/watch?v=fixture',
        source: 'youtube', key: 'fixture', duration: null, thumbnail: null, requestedBy: 'Fixture user',
      });
    }
    const members = new Collection([
      ['bot', { user: { bot: true } }],
      ...Array.from({ length: scenario.humans }, (_, i) => [`human-${i}`, { user: { bot: false } }] as const),
    ]);
    const guild = {
      id: guildId, name: 'Fixture guild',
      members: { cache: new Collection([['bot', { voice: { channel: { id: 'channel', name: 'Music', members } } }]]) },
    };
    const client = {
      user: { id: 'bot' }, guilds: { cache: new Collection([[guildId, guild]]) },
    } as unknown as Client;
    const connections = getVoiceConnections();
    connections.set(guildId, connection);
    queues.set(guildId, queue);
    const usageLogEnabled = process.env.USAGE_LOG_ENABLED;
    // Skip legacy root-log rotation without changing queue/connection cleanup.
    const maintenanceLogs = new Set(['eppu-out.log', 'eppu-error.log'].map(name => path.join(__dirname, '../../', name)));
    const existsSync = fs.existsSync;
    const logExists = spyOn(fs, 'existsSync').mockImplementation(file =>
      maintenanceLogs.has(String(file)) ? false : existsSync(file));
    try {
      process.env.USAGE_LOG_ENABLED = 'false';
      checkAndLeaveIfNeeded(client, guildId);
      expect(destroyed).toBe(scenario.leave);
      expect(stopped).toBe(scenario.leave);
      expect(queues.has(guildId)).toBe(!scenario.leave);
    } finally {
      logExists.mockRestore();
      if (usageLogEnabled === undefined) delete process.env.USAGE_LOG_ENABLED;
      else process.env.USAGE_LOG_ENABLED = usageLogEnabled;
      connections.delete(guildId);
      queues.delete(guildId);
    }
  });
}
