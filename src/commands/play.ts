// src/commands/play.ts
import { Client, Message } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  DiscordGatewayAdapterCreator,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState
} from '@discordjs/voice';
import youtubeDl, { Flags } from 'youtube-dl-exec';
import { MusicQueue } from '../music/queue';
import { ExtendedPayload, PlaylistEntry } from './play-types';
import { clearStartupTrace, getStartupTrace, logStartupTrace } from './play-startup';
import { checkDiskSpace } from './play-maintenance';
import { clearGuildUiTracking, sendOrEditMusicMessage, voiceChannelLabel } from './play-ui';
import { queues } from './play-state';
import { clearNextSongPrefetch, requestNextSongPrefetch } from './play-prefetch';
import { playYouTubeUrl } from './play-playback';
import { checkAndLeaveChannel } from './play-controls';

export { searchYouTubeFromWeb } from './play-search';
export type { WebSearchResult } from './play-types';
export { queues, getVolume, setVolume } from './play-state';
export {
  handlePause,
  handleResume,
  handleSkip,
  handleQueue,
  handleHelp,
  handleCleanup,
  handleNukkumaan,
  checkAndLeaveIfNeeded,
} from './play-controls';

function createWebPlaybackMessage(client: Client, guild: any, requestedBy: string): Message {
  const botUserId = client.user?.id || 'eppu-web';

  const fakeBotMessage = async () => ({
    id: `web-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    author: { id: botUserId },
    edit: async () => undefined,
  });

  const fakeChannel: any = {
    send: async () => fakeBotMessage(),
    messages: {
      fetch: async () => ({ first: () => undefined }),
    },
  };

  return {
    guild,
    member: {
      voice: { channel: null },
      permissions: { has: () => false },
    },
    author: {
      id: `web-${requestedBy}`,
      username: requestedBy || 'Web UI',
      bot: false,
    },
    channel: fakeChannel,
    client,
    reply: async (payload: any) => {
      const content = typeof payload === 'string' ? payload : payload?.content;
      if (content) {
        console.log(`[web] ${content}`);
      }
      return fakeBotMessage();
    },
  } as unknown as Message;
}

export function refreshNextSongPrefetch(client: Client, guildId: string): void {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    clearNextSongPrefetch(guildId);
    return;
  }
  const message = createWebPlaybackMessage(client, guild, 'Web UI');
  requestNextSongPrefetch(message);
}

async function resolveDefaultVoiceChannelForGuild(client: Client, guildId: string): Promise<{ guild: any; channelId: string; error?: string }> {
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    return { guild: null, channelId: '', error: 'Guild not found for web playback.' };
  }

  const defaultVoiceChannelId = process.env.DEFAULT_VOICE_CHANNEL_ID?.trim();
  if (!defaultVoiceChannelId) {
    return { guild, channelId: '', error: 'DEFAULT_VOICE_CHANNEL_ID is not configured.' };
  }

  const channel = guild.channels.cache.get(defaultVoiceChannelId)
    || await guild.channels.fetch(defaultVoiceChannelId).catch(() => null);
  if (!channel || !channel.isVoiceBased()) {
    return {
      guild,
      channelId: '',
      error: `DEFAULT_VOICE_CHANNEL_ID (${defaultVoiceChannelId}) is not a valid voice channel in ${guild.name}.`,
    };
  }

  return { guild, channelId: defaultVoiceChannelId };
}

export async function addSongFromWeb(
  client: Client,
  guildId: string,
  url: string,
  requestedBy: string
): Promise<{ success: boolean; error?: string }> {
  let queue = queues.get(guildId);
  let playbackMessage: Message | null = null;
  let resolvedGuild: any = null;

  if (!queue) {
    const resolved = await resolveDefaultVoiceChannelForGuild(client, guildId);
    if (resolved.error || !resolved.channelId) {
      return { success: false, error: resolved.error || 'Could not resolve default voice channel.' };
    }

    resolvedGuild = resolved.guild;
    playbackMessage = createWebPlaybackMessage(client, resolvedGuild, requestedBy);
    console.log(
      `[web-voice] Bootstrapping queue for guild=${resolved.guild.name} (${guildId}) `
      + `channelId=${resolved.channelId}`
    );

    try {
      queue = await createQueueAndConnection(playbackMessage, resolved.channelId);
    } catch (error) {
      console.error('[web-voice] Failed to create queue/connection from web:', error);
      return { success: false, error: 'Could not join the default voice channel.' };
    }
  }

  try {
    const flags: Flags = {
      dumpSingleJson: true,
      format: 'bestaudio',
      simulate: true,
    };

    const videoInfo = await youtubeDl(url, flags) as unknown as ExtendedPayload;
    if (!videoInfo.title) {
      return { success: false, error: 'Could not get video info' };
    }

    const hadCurrentSongBeforeAdd = !!queue.getCurrentSong();
    queue.addSong({
      title: videoInfo.title,
      url,
      requestedBy,
    });

    if (!playbackMessage) {
      if (!resolvedGuild) {
        resolvedGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      }
      if (resolvedGuild) {
        playbackMessage = createWebPlaybackMessage(client, resolvedGuild, requestedBy);
      }
    }

    if (playbackMessage) {
      requestNextSongPrefetch(playbackMessage);
    }

    if (!hadCurrentSongBeforeAdd && queue.getCurrentSong()?.url === url) {
      if (!playbackMessage && resolvedGuild) {
        playbackMessage = createWebPlaybackMessage(client, resolvedGuild, requestedBy);
      }
      if (!playbackMessage) {
        return { success: false, error: 'Guild not found for playback start.' };
      }
      playYouTubeUrl(url, queue.getPlayer(), playbackMessage, videoInfo.title, true);
    }

    return { success: true };
  } catch (error) {
    console.error('[web-voice] Failed to fetch video info:', error);
    return { success: false, error: 'Failed to fetch video info' };
  }
}

export async function handlePlay(message: Message, url: string) {
  console.log('Starting handlePlay with URL:', url);

  const diskInfo = checkDiskSpace();
  if (diskInfo.percentage > 95) {
    message.reply('⚠️ Error: Disk space critically low! Cannot play music. Please free up some space.');
    return;
  }

  const defaultVoiceChannelId = process.env.DEFAULT_VOICE_CHANNEL_ID?.trim();
  const memberVoiceChannel = message.member?.voice.channel;
  const configuredDefaultChannel = defaultVoiceChannelId
    ? message.guild?.channels.cache.get(defaultVoiceChannelId)
    : null;
  const targetVoiceChannel = memberVoiceChannel
    ?? (configuredDefaultChannel && configuredDefaultChannel.isVoiceBased() ? configuredDefaultChannel : null);

  console.log(
    `[voice] Play requested guild=${message.guild?.name} (${message.guild?.id}) `
    + `memberChannel=${voiceChannelLabel(message, memberVoiceChannel?.id)} `
    + `defaultChannelConfigured=${voiceChannelLabel(message, defaultVoiceChannelId)} `
    + `selectedChannel=${voiceChannelLabel(message, targetVoiceChannel?.id)}`
  );

  if (!targetVoiceChannel) {
    console.log('[voice] User not in voice channel and no valid default channel configured');
    message.reply('You need to be in a voice channel (or configure DEFAULT_VOICE_CHANNEL_ID).');
    return;
  }

  const guildId = message.guild!.id;
  let queue = queues.get(guildId);
  console.log('Queue exists:', !!queue);

  try {
    console.log('Fetching PO token');

    const isPlaylist = url.includes('playlist') || url.includes('list=');
    if (isPlaylist) {
      await handlePlaylist(message, url, queue, targetVoiceChannel.id);
      return;
    }

    const flags: Flags = {
      dumpSingleJson: true,
      format: 'bestaudio',
      simulate: true,
    };

    const videoInfo = await youtubeDl(url, flags) as unknown as ExtendedPayload;

    if (!videoInfo.requested_downloads?.[0]?.url) {
      console.error('No audio URL found in video info');
      throw new Error('No audio URL found');
    }

    const isFirstSong = !queue;

    if (!queue) {
      queue = await createQueueAndConnection(message, targetVoiceChannel.id);
    }

    console.log('Adding song to queue:', videoInfo.title);

    const queueItem = {
      title: videoInfo.title,
      url,
      requestedBy: message.author.username,
    };

    const hadCurrentSongBeforeAdd = !!queue.getCurrentSong();
    queue.addSong(queueItem);
    requestNextSongPrefetch(message);

    if (!hadCurrentSongBeforeAdd && queue.getCurrentSong()?.url === queueItem.url) {
      playYouTubeUrl(queueItem.url, queue.getPlayer(), message, queueItem.title, isFirstSong);
    } else {
      await sendOrEditMusicMessage(message, `Added to queue: ${videoInfo.title}`);
    }

  } catch (error) {
    console.error('Play command error:', error);
    message.reply('Error playing the video!');
  }
}

async function handlePlaylist(message: Message, url: string, existingQueue?: MusicQueue, channelId?: string) {
  try {
    message.reply('Processing playlist. This may take a moment...');

    const playlistFlags: Flags = {
      dumpSingleJson: true,
      flatPlaylist: true,
      simulate: true,
    };

    const playlistInfo = await youtubeDl(url, playlistFlags) as any;

    if (!playlistInfo || !playlistInfo.entries || !Array.isArray(playlistInfo.entries)) {
      throw new Error('Failed to get playlist information');
    }

    const entries = playlistInfo.entries as PlaylistEntry[];

    if (entries.length === 0) {
      message.reply('No videos found in the playlist.');
      return;
    }

    const guildId = message.guild!.id;
    let queue = existingQueue || queues.get(guildId);
    const isFirstSong = !queue;

    if (!queue) {
      const targetChannelId = channelId || message.member?.voice.channel?.id;
      console.log(
        `[voice] Playlist queue creation target channel=${voiceChannelLabel(message, targetChannelId)} `
        + `source=${channelId ? 'resolved-in-handlePlay' : 'member-voice'}`
      );
      if (!targetChannelId) {
        message.reply('No voice channel available for playlist playback.');
        return;
      }
      queue = await createQueueAndConnection(message, targetChannelId);
    }

    let addedCount = 0;
    const totalVideos = entries.length;

    message.reply(`Found ${totalVideos} videos in the playlist. Adding to queue...`);

    for (const entry of entries) {
      try {
        const videoFlags: Flags = {
          dumpSingleJson: true,
          simulate: true,
        };

        const videoInfo = await youtubeDl(entry.url, videoFlags) as unknown as ExtendedPayload;

        if (videoInfo.title) {
          const queueItem = {
            title: videoInfo.title,
            url: entry.url,
            requestedBy: message.author.username,
          };

          const hadCurrentSongBeforeAdd = !!queue.getCurrentSong();
          queue.addSong(queueItem);
          addedCount++;

          if (!hadCurrentSongBeforeAdd && queue.getCurrentSong()?.url === queueItem.url) {
            playYouTubeUrl(queueItem.url, queue.getPlayer(), message, queueItem.title, isFirstSong && addedCount === 1);
          }
        }
      } catch (error) {
        console.error(`Error processing playlist video ${entry.url}:`, error);
      }
    }

    requestNextSongPrefetch(message);
    message.reply(`Successfully added ${addedCount} out of ${totalVideos} videos from the playlist to the queue.`);

  } catch (error) {
    console.error('Playlist processing error:', error);
    message.reply('Error processing the playlist!');
  }
}

async function createQueueAndConnection(message: Message, channelId: string): Promise<MusicQueue> {
  console.log(
    `[voice] Creating new voice connection guild=${message.guild?.name} (${message.guild?.id}) `
    + `channel=${voiceChannelLabel(message, channelId)}`
  );
  const guildId = message.guild!.id;

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: message.guild!.voiceAdapterCreator as DiscordGatewayAdapterCreator,
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(
      `[voice] Connection state guild=${message.guild?.name} channel=${voiceChannelLabel(message, channelId)} `
      + `${oldState.status} -> ${newState.status}`
    );
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.log('Voice connection disconnected, attempting reconnect...');
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      console.log('Voice connection reconnecting...');
    } catch {
      console.log('Voice connection reconnect failed, destroying connection');
      connection.destroy();
      if (queues.has(guildId)) {
        queues.delete(guildId);
        clearGuildUiTracking(guildId);
        clearStartupTrace(guildId);
        clearNextSongPrefetch(guildId);
        console.log(`Cleaned up queue and tracking for guild: ${guildId}`);
      }
    }
  });

  connection.on('error', error => {
    console.error(
      `[voice] Connection error guild=${message.guild?.name} channel=${voiceChannelLabel(message, channelId)}:`,
      error
    );
  });

  const player = createAudioPlayer();

  player.on('error', error => {
    console.error('Audio Player Error:', error);
  });

  player.on('stateChange', (oldState, newState) => {
    console.log(`Audio player state changed from ${oldState.status} to ${newState.status}`);

    const trace = getStartupTrace(guildId);
    if (!trace) return;

    if (newState.status === AudioPlayerStatus.Buffering && !trace.bufferingAt) {
      trace.bufferingAt = Date.now();
      logStartupTrace(trace, 'state=buffering');
    }

    if (newState.status === AudioPlayerStatus.Playing && !trace.playingAt) {
      trace.playingAt = Date.now();
      const fromPlayCall = trace.playerPlayAt ? `${trace.playingAt - trace.playerPlayAt}ms from player.play()` : 'n/a';
      logStartupTrace(trace, 'state=playing', `startupLatency=${trace.playingAt - trace.startedAt}ms, playCallDelta=${fromPlayCall}`);
    }

    if (oldState.status === AudioPlayerStatus.Playing && newState.status === AudioPlayerStatus.Buffering) {
      if (!trace.firstRebufferAt) {
        trace.firstRebufferAt = Date.now();
      }
      logStartupTrace(
        trace,
        'rebuffer',
        `afterPlaying=${trace.playingAt ? trace.firstRebufferAt - trace.playingAt : 'n/a'}ms`
      );
    }

    if (newState.status === AudioPlayerStatus.Idle) {
      logStartupTrace(
        trace,
        'state=idle',
        trace.playingAt ? `playedFor=${Date.now() - trace.playingAt}ms` : 'before-playing'
      );
    }
  });

  const queue = new MusicQueue(player);
  queues.set(guildId, queue);

  connection.subscribe(player);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log(
      `[voice] Connection ready guild=${message.guild?.name} channel=${voiceChannelLabel(message, channelId)}`
    );
  } catch (error) {
    console.error(
      `[voice] Connection did not become ready guild=${message.guild?.name} channel=${voiceChannelLabel(message, channelId)}`,
      error
    );
    connection.destroy();
    throw error;
  }

  player.on(AudioPlayerStatus.Idle, () => {
    const nextSong = queue.getNextSong();
    if (nextSong) {
      playYouTubeUrl(nextSong.url, queue.getPlayer(), message, nextSong.title);
    } else {
      clearStartupTrace(guildId);
      clearNextSongPrefetch(guildId);
      setTimeout(() => {
        if (!queue.getCurrentSong() && !queue.hasNextSong()) {
          checkAndLeaveChannel(guildId, message.client);
        }
      }, 60_000);
    }
  });

  return queue;
}
