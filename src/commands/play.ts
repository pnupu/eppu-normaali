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
import { logYtDlpAuthContext, withYtDlpAuthFlags } from './ytdlp-auth';

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

function formatYtDlpError(error: unknown): string {
  const err = error as { message?: string; stderr?: string; stdout?: string; exitCode?: number } | null;
  if (!err) return 'unknown error';
  const parts: string[] = [];
  if (typeof err.exitCode === 'number') {
    parts.push(`exitCode=${err.exitCode}`);
  }
  if (err.message) {
    parts.push(`message=${err.message}`);
  }
  if (err.stderr) {
    parts.push(`stderr=${String(err.stderr).trim()}`);
  }
  if (err.stdout) {
    parts.push(`stdout=${String(err.stdout).trim()}`);
  }
  return parts.join(' | ') || 'unknown error';
}

function fallbackTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const videoId = parsed.searchParams.get('v');
    if (videoId) return `YouTube ${videoId}`;
  } catch {
    // ignore
  }
  return 'YouTube video';
}

async function fetchVideoInfoWithLogging(
  url: string,
  context: string
): Promise<{ title: string; degraded: boolean }> {
  const startedAt = Date.now();
  const firstFlags: Flags = {
    dumpSingleJson: true,
    format: 'bestaudio',
    simulate: true,
  };
  const secondFlags: Flags = {
    dumpSingleJson: true,
    simulate: true,
  };

  console.log(`[yt-fetch] ${context} begin url=${url}`);
  logYtDlpAuthContext();

  try {
    const videoInfo = await youtubeDl(url, withYtDlpAuthFlags(firstFlags)) as unknown as ExtendedPayload;
    if (!videoInfo.title) {
      throw new Error('Missing title in yt-dlp response');
    }
    console.log(`[yt-fetch] ${context} success mode=bestaudio title="${videoInfo.title}" in ${Date.now() - startedAt}ms`);
    return { title: videoInfo.title, degraded: false };
  } catch (error) {
    console.warn(`[yt-fetch] ${context} bestaudio failed: ${formatYtDlpError(error)}`);
  }

  try {
    const videoInfo = await youtubeDl(url, withYtDlpAuthFlags(secondFlags)) as unknown as ExtendedPayload;
    if (!videoInfo.title) {
      throw new Error('Missing title in fallback yt-dlp response');
    }
    console.log(`[yt-fetch] ${context} success mode=fallback title="${videoInfo.title}" in ${Date.now() - startedAt}ms`);
    return { title: videoInfo.title, degraded: true };
  } catch (error) {
    console.error(`[yt-fetch] ${context} fallback failed: ${formatYtDlpError(error)}`);
  }

  const fallbackTitle = fallbackTitleFromUrl(url);
  console.warn(`[yt-fetch] ${context} using synthetic title="${fallbackTitle}"`);
  return { title: fallbackTitle, degraded: true };
}
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
    const { title } = await fetchVideoInfoWithLogging(url, `web-add guild=${guildId}`);

    const hadCurrentSongBeforeAdd = !!queue.getCurrentSong();
    queue.addSong({
      title,
      url: url,
      requestedBy: requestedBy
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
      playYouTubeUrl(url, queue.getPlayer(), playbackMessage, title, true);
    }

    return { success: true };
  } catch (error) {
    console.error(`[yt-fetch] web-add unexpected failure url=${url} error=${formatYtDlpError(error)}`);
    return { success: false, error: 'Failed to fetch video info' };
  }
}

export async function handlePlay(message: Message, url: string) {
  console.log('Starting handlePlay with URL:', url);
  
  // Check disk space before proceeding
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
    console.log(`[play] Resolving video metadata url=${url}`);

    // Check if URL is a playlist
    const isPlaylist = url.includes('playlist') || url.includes('list=');
    
    if (isPlaylist) {
      await handlePlaylist(message, url, queue, targetVoiceChannel.id);
      return;
    }
    
    // Handle single video
    const { title } = await fetchVideoInfoWithLogging(url, `play guild=${guildId}`);

    const isFirstSong = !queue;
    
    if (!queue) {
      queue = await createQueueAndConnection(message, targetVoiceChannel.id);
    }

    console.log('Adding song to queue:', title);
    
    // Store the original YouTube URL instead of the direct audio URL
    // We'll get a fresh audio URL when we actually play it
    const queueItem = {
      title,
      url: url, // Store original YouTube URL
      requestedBy: message.author.username
    };

    const hadCurrentSongBeforeAdd = !!queue.getCurrentSong();
    queue.addSong(queueItem);
    requestNextSongPrefetch(message);
    
    // If this is the current song (no other song playing), start playing immediately
    if (!hadCurrentSongBeforeAdd && queue.getCurrentSong()?.url === queueItem.url) {
      // Start playing immediately with fresh URL - no delay
      playYouTubeUrl(queueItem.url, queue.getPlayer(), message, queueItem.title, isFirstSong);
    } else {
      await sendOrEditMusicMessage(message, `Added to queue: ${queueItem.title}`);
    }

  } catch (error) {
    console.error(`[play] command error url=${url} error=${formatYtDlpError(error)}`);
    message.reply('Error playing the video!');
  }
}

async function handlePlaylist(message: Message, url: string, existingQueue?: MusicQueue, channelId?: string) {
  try {
    message.reply('Processing playlist. This may take a moment...');
    
    // Get playlist info
    const playlistFlags: Flags = {
      dumpSingleJson: true,
      flatPlaylist: true,
      simulate: true,    // Don't download, just get info
    };
    
    console.log(`[yt-fetch] playlist begin url=${url}`);
    const playlistInfo = await youtubeDl(url, withYtDlpAuthFlags(playlistFlags)) as any;
    console.log(
      `[yt-fetch] playlist success url=${url} entries=${Array.isArray(playlistInfo?.entries) ? playlistInfo.entries.length : 0}`
    );
    
    if (!playlistInfo || !playlistInfo.entries || !Array.isArray(playlistInfo.entries)) {
      throw new Error('Failed to get playlist information');
    }
    
    const entries = playlistInfo.entries as PlaylistEntry[];
    
    if (entries.length === 0) {
      message.reply('No videos found in the playlist.');
      return;
    }
    
    // Create queue if it doesn't exist
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
    
    // Process each video in the playlist
    let addedCount = 0;
    const totalVideos = entries.length;
    
    message.reply(`Found ${totalVideos} videos in the playlist. Adding to queue...`);
    
    // Add YouTube URLs to queue (we'll get fresh audio URLs when playing)
    for (const entry of entries) {
      try {
        const { title } = await fetchVideoInfoWithLogging(
          entry.url,
          `playlist-entry guild=${guildId}`
        );
        const queueItem = {
          title,
          url: entry.url, // Store YouTube URL, not direct audio URL
          requestedBy: message.author.username
        };

        const hadCurrentSongBeforeAdd = !!queue.getCurrentSong();
        queue.addSong(queueItem);
        addedCount++;

        // Start playing the first song if it's the current song
        if (!hadCurrentSongBeforeAdd && queue.getCurrentSong()?.url === queueItem.url) {
          playYouTubeUrl(queueItem.url, queue.getPlayer(), message, queueItem.title, isFirstSong && addedCount === 1);
        }
      } catch (error) {
        console.error(`[yt-fetch] playlist entry failed url=${entry.url} error=${formatYtDlpError(error)}`);
        // Continue with next video even if one fails
      }
    }

    requestNextSongPrefetch(message);
    
    message.reply(`Successfully added ${addedCount} out of ${totalVideos} videos from the playlist to the queue.`);
    
  } catch (error) {
    console.error(`[yt-fetch] playlist processing error url=${url} error=${formatYtDlpError(error)}`);
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
    guildId: guildId,
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
      // Reconnecting successfully
      console.log('Voice connection reconnecting...');
    } catch {
      // Reconnect failed, destroy the connection
      console.log('Voice connection reconnect failed, destroying connection');
      connection.destroy();
      const guildId = message.guild!.id;
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
      // Wait before disconnecting so users can queue more songs
      setTimeout(() => {
        // Re-check: if a song was added during the delay, don't leave
        if (!queue.getCurrentSong() && !queue.hasNextSong()) {
          checkAndLeaveChannel(guildId, message.client);
        }
      }, 60_000); // Wait 60 seconds before leaving
    }
  });
  
  return queue;
}
