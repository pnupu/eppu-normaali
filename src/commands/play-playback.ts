import { AudioPlayer, StreamType, createAudioResource } from '@discordjs/voice';
import { Message } from 'discord.js';
import { NextSongPrefetch } from './play-types';
import { beginStartupTrace, logStartupTrace } from './play-startup';
import {
  createFfmpegStream,
  createPrefetchedFileStream,
  createYouTubeStream,
  inlineVolumeEnabled,
  isExpectedStreamTeardownError,
  logStreamIssue,
  primePcmStream
} from './play-streams';
import { sendOrEditMusicMessage } from './play-ui';
import {
  markSongStarted,
  requestNextSongPrefetch,
  removePrefetchFile,
  takeReadyPrefetch
} from './play-prefetch';

async function playPrefetchedSong(
  prefetched: NextSongPrefetch,
  player: AudioPlayer,
  message: Message,
  title: string,
  isFirstSong: boolean = false
) {
  try {
    let primedBytes = 0;
    let primeReason: 'bytes' | 'timeout' | 'eof' = 'eof';
    const trace = beginStartupTrace(message, title, prefetched.url, 'prefetched');
    console.log(`[prefetch] Playing prefetched file guild=${message.guild?.name} title="${title}"`);
    const baseStream = createPrefetchedFileStream(prefetched.filePath, removePrefetchFile);
    baseStream.once('data', (chunk) => {
      if (!trace || trace.baseFirstChunkAt) return;
      trace.baseFirstChunkAt = Date.now();
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      logStartupTrace(trace, 'base-first-chunk', `bytes=${size}`);
    });
    baseStream.on('error', (error: Error & { code?: string }) => {
      logStreamIssue('[prefetch] Stream issue while playing prefetched file', error);
    });
    const stream = await primePcmStream(baseStream, `prefetched:${title}`, {
      onFirstChunk: (bytes) => {
        logStartupTrace(trace, 'prime-first-chunk', `bytes=${bytes}`);
      },
      onPrimed: (bytes, reason) => {
        primedBytes = bytes;
        primeReason = reason;
        if (!trace) return;
        trace.primeReadyAt = Date.now();
        trace.primeBytes = bytes;
        trace.primeReason = reason;
        logStartupTrace(trace, 'prime-ready', `bytes=${bytes}, reason=${reason}`);
      },
    });

    if (primedBytes <= 0) {
      throw new Error(`Prefetched stream produced no audio bytes (reason=${primeReason})`);
    }

    logStartupTrace(trace, 'create-audio-resource');
    const withInlineVolume = inlineVolumeEnabled();
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
      inlineVolume: withInlineVolume
    });

    if (withInlineVolume) {
      resource.volume?.setVolume(0.5);
    }
    if (trace) {
      trace.playerPlayAt = Date.now();
    }
    logStartupTrace(trace, 'player.play()');
    player.play(resource);
    markSongStarted(message);

    await sendOrEditMusicMessage(message, `Now playing: ${title}`, isFirstSong);
    requestNextSongPrefetch(message);
  } catch (error) {
    console.error('[prefetch] Failed to play prefetched file, falling back to live stream:', error);
    removePrefetchFile(prefetched.filePath);
    await playYouTubeUrlDirect(prefetched.url, player, message, title, isFirstSong);
  }
}

async function playYouTubeUrlDirect(youtubeUrl: string, player: AudioPlayer, message: Message, title: string, isFirstSong: boolean = false) {
  try {
    let primedBytes = 0;
    let primeReason: 'bytes' | 'timeout' | 'eof' = 'eof';
    const trace = beginStartupTrace(message, title, youtubeUrl, 'live');
    console.log('Streaming directly from YouTube URL with FFmpeg:', youtubeUrl);

    const baseStream = createYouTubeStream(youtubeUrl);
    baseStream.once('data', (chunk) => {
      if (!trace || trace.baseFirstChunkAt) return;
      trace.baseFirstChunkAt = Date.now();
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      logStartupTrace(trace, 'base-first-chunk', `bytes=${size}`);
    });

    baseStream.on('error', (error: Error & { code?: string }) => {
      logStreamIssue('YouTube stream issue', error);
    });
    const stream = await primePcmStream(baseStream, title, {
      onFirstChunk: (bytes) => {
        logStartupTrace(trace, 'prime-first-chunk', `bytes=${bytes}`);
      },
      onPrimed: (bytes, reason) => {
        primedBytes = bytes;
        primeReason = reason;
        if (!trace) return;
        trace.primeReadyAt = Date.now();
        trace.primeBytes = bytes;
        trace.primeReason = reason;
        logStartupTrace(trace, 'prime-ready', `bytes=${bytes}, reason=${reason}`);
      },
    });

    if (primedBytes <= 0) {
      throw new Error(`Live stream produced no audio bytes (reason=${primeReason})`);
    }

    logStartupTrace(trace, 'create-audio-resource');
    const withInlineVolume = inlineVolumeEnabled();
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
      inlineVolume: withInlineVolume
    });

    if (withInlineVolume) {
      resource.volume?.setVolume(0.5);
    }
    if (trace) {
      trace.playerPlayAt = Date.now();
    }
    logStartupTrace(trace, 'player.play()');
    player.play(resource);
    markSongStarted(message);

    await sendOrEditMusicMessage(message, `Now playing: ${title}`, isFirstSong);
    requestNextSongPrefetch(message);
  } catch (error) {
    console.error('Error in playYouTubeUrlDirect:', error);
    (message.channel as any).send(`Failed to play: ${title}, skipping...`);
    player.stop();
  }
}

export async function playYouTubeUrl(
  youtubeUrl: string,
  player: AudioPlayer,
  message: Message,
  title: string,
  isFirstSong: boolean = false
) {
  try {
    const guildId = message.guild?.id;
    if (guildId) {
      const prefetched = takeReadyPrefetch(guildId, youtubeUrl);
      if (prefetched) {
        await playPrefetchedSong(prefetched, player, message, title, isFirstSong);
        return;
      }
    }

    console.log('Attempting to stream directly from YouTube URL:', youtubeUrl);
    await playYouTubeUrlDirect(youtubeUrl, player, message, title, isFirstSong);

  } catch (error) {
    console.error('Error streaming YouTube URL:', error);
    message.reply('Error streaming from YouTube');
  }
}

export async function playSong(url: string, player: AudioPlayer, message: Message, title: string, isFirstSong: boolean = false) {
  try {
    console.log('Creating FFmpeg stream for URL:', url);
    console.log('URL length:', url.length);
    console.log('URL starts with:', url.substring(0, 100));
    console.log('FFmpeg starting at timestamp:', Date.now());

    const stream = createFfmpegStream(url);

    stream.on('error', (error) => {
      if (isExpectedStreamTeardownError(error)) {
        console.log('Audio stream closed during skip/transition');
        return;
      }
      console.error('Stream error:', error);
      message.reply('Error with audio stream');
    });

    const withInlineVolume = inlineVolumeEnabled();
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
      inlineVolume: withInlineVolume
    });

    if (withInlineVolume) {
      resource.volume?.setVolume(0.5);
    }
    player.play(resource);

    await sendOrEditMusicMessage(message, `Now playing: ${title}`, isFirstSong);
  } catch (error) {
    console.error('Error in playSong:', error);
    message.reply('Error playing the audio');
  }
}
