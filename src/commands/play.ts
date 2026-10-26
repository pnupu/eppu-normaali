// src/commands/play.ts
import { Message, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Client } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  DiscordGatewayAdapterCreator,
  StreamType,
  AudioPlayerStatus,
  AudioPlayer,
  AudioResource,
  VoiceConnection,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  getVoiceConnection,
  entersState
} from '@discordjs/voice';
import {
  YTDLP_BIN,
  buildYtDlpSpawnArgs,
  formatYtDlpError,
  isYtCookieAuthErrorText,
  isYtExtractionChallengeErrorText,
  refreshYtCookiesFromBrowser,
} from '../music/ytdlp';
import { MusicQueue, type QueueItem } from '../music/queue';
import { ResolveError, resolveInput, ytDlpStreamInput, type Track } from '../music/sources';
import path from 'path';
import { spawn, ChildProcessWithoutNullStreams, execSync } from 'child_process';
import { Readable, PassThrough } from 'stream';
import fs from 'fs';
import { createHash } from 'crypto';
import { isDiscordVoiceListener, startDiscordVoiceReceiver } from '../voice/discordVoiceRuntime';
import { logUsage, type UsageLogFields } from '../usageLog';
interface NextSongPrefetch {
  guildId: string;
  url: string;
  title: string;
  filePath: string;
  ready: boolean;
  process: ChildProcessWithoutNullStreams | null;
}
type StartupSource = 'live' | 'prefetched';
interface StartupTrace {
  id: number;
  guildId: string;
  guildName: string;
  title: string;
  url: string;
  source: StartupSource;
  startedAt: number;
  baseFirstChunkAt?: number;
  primeReadyAt?: number;
  primeBytes?: number;
  primeReason?: 'bytes' | 'timeout' | 'eof';
  playerPlayAt?: number;
  bufferingAt?: number;
  playingAt?: number;
  firstRebufferAt?: number;
}
interface PrimeHooks {
  onFirstChunk?: (bytes: number) => void;
  onPrimed?: (bytes: number, reason: 'bytes' | 'timeout' | 'eof') => void;
}
export const queues = new Map<string, MusicQueue>();
const PREFETCH_DIR = path.join(__dirname, '../../tmp/prefetch');
// Prefetched files only belong to the process that downloaded them; drop leftovers from restarts.
fs.rmSync(PREFETCH_DIR, { recursive: true, force: true });
const nextSongPrefetches = new Map<string, NextSongPrefetch>();
const prefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const songStartTimes = new Map<string, number>();
const startupTraces = new Map<string, StartupTrace>();
const queueCreationPromises = new Map<string, Promise<MusicQueue>>();
let startupTraceIdCounter = 0;
// Per-guild volume (0-100). 100 plays the source at its own loudness; changes apply to the playing track live.
const guildVolumes = new Map<string, number>();
const currentResources = new Map<string, AudioResource>();
export function getVolume(guildId: string): number {
  return guildVolumes.get(guildId) ?? 100;
}
export function setVolume(guildId: string, volume: number): void {
  if (!Number.isFinite(volume)) return;
  const clamped = Math.max(0, Math.min(100, Math.round(volume)));
  guildVolumes.set(guildId, clamped);
  currentResources.get(guildId)?.volume?.setVolumeLogarithmic(clamped / 100);
}
/** Forget a guild's queue and stop its player, so the stream's ffmpeg/yt-dlp children are torn down. */
function dropQueue(guildId: string): void {
  queues.get(guildId)?.clear();
  queues.delete(guildId);
  currentResources.delete(guildId);
}
/** Milliseconds played of the current track, or null when nothing is playing. */
export function getPlaybackPositionMs(guildId: string): number | null {
  const resource = currentResources.get(guildId);
  return resource && !resource.ended ? resource.playbackDuration : null;
}
function voiceChannelBitrate(guildId: string, message: Message): number {
  const channelId = getVoiceConnection(guildId)?.joinConfig.channelId;
  const channel = channelId ? message.guild?.channels.cache.get(channelId) : null;
  const bitrate = channel && channel.isVoiceBased() ? channel.bitrate : 0;
  return bitrate >= 8000 ? bitrate : 128000;
}
/**
 * Wrap a raw PCM stream for Discord: inline volume for the web slider, and an Opus encoder
 * bitrate matching the voice channel (libopus would otherwise pick ~99 kbps for stereo).
 */
function createPlaybackResource(stream: Readable, message: Message): AudioResource {
  const guildId = message.guild!.id;
  const resource = createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true });
  resource.volume?.setVolumeLogarithmic(getVolume(guildId) / 100);
  resource.encoder?.setBitrate(voiceChannelBitrate(guildId, message));
  currentResources.set(guildId, resource);
  return resource;
}
function isExpectedStreamTeardownError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  if (!err) return false;
  const code = err.code || '';
  const message = (err.message || '').toLowerCase();
  return code === 'ERR_STREAM_PREMATURE_CLOSE'
    || code === 'EPIPE'
    || message.includes('premature close')
    || message.includes('aborted');
}
function logStreamIssue(context: string, error: unknown): void {
  if (isExpectedStreamTeardownError(error)) {
    const code = (error as { code?: string } | null)?.code || 'n/a';
    console.log(`${context} (expected teardown: ${code})`);
    return;
  }
  console.error(context, error);
}
function startupDebugEnabled(): boolean {
  const value = process.env.PLAYBACK_STARTUP_DEBUG?.trim().toLowerCase();
  if (!value) return true;
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}
function ytdlpVerboseLogsEnabled(): boolean {
  const value = process.env.YTDLP_VERBOSE_LOGS?.trim().toLowerCase();
  if (!value) return false;
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}
function ffmpegVerboseLogsEnabled(): boolean {
  const value = process.env.FFMPEG_VERBOSE_LOGS?.trim().toLowerCase();
  if (!value) return false;
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}
function ffmpegLogLevel(): string {
  const configured = process.env.FFMPEG_LOGLEVEL?.trim();
  if (configured) return configured;
  return ffmpegVerboseLogsEnabled() ? 'info' : 'error';
}
function ffmpegStatsIntervalMs(): number {
  const raw = Number.parseInt(process.env.FFMPEG_STATS_INTERVAL_MS || '5000', 10);
  if (!Number.isFinite(raw)) return 5000;
  return Math.max(1000, raw);
}
function wireFfmpegDiagnostics(
  ffmpeg: ChildProcessWithoutNullStreams,
  label: string
): void {
  const startedAt = Date.now();
  const verbose = ffmpegVerboseLogsEnabled();
  const statsIntervalMs = ffmpegStatsIntervalMs();
  let stdoutBytes = 0;
  let lastStatsBytes = 0;
  let carry = '';
  let statsTimer: ReturnType<typeof setInterval> | null = null;

  const shouldLogLine = (line: string): boolean => {
    if (!line) return false;
    if (verbose) return true;
    const lowered = line.toLowerCase();
    return lowered.includes('error')
      || lowered.includes('warning')
      || lowered.includes('drop')
      || lowered.includes('invalid')
      || lowered.includes('non-monotonous')
      || lowered.includes('clipping')
      || lowered.includes('speed=');
  };

  const logLine = (line: string) => {
    if (!shouldLogLine(line)) return;
    console.log(`[ffmpeg][${label}] +${Date.now() - startedAt}ms ${line}`);
  };

  ffmpeg.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
  });

  ffmpeg.stderr.on('data', (data) => {
    const merged = (carry + data.toString()).replace(/\r/g, '\n');
    const lines = merged.split('\n');
    carry = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      logLine(trimmed);
    }
  });

  if (verbose) {
    statsTimer = setInterval(() => {
      const delta = stdoutBytes - lastStatsBytes;
      lastStatsBytes = stdoutBytes;
      const rateBps = Math.round(delta / (statsIntervalMs / 1000));
      console.log(
        `[ffmpeg][${label}] +${Date.now() - startedAt}ms stats bytes=${stdoutBytes} rateBps=${rateBps}`
      );
    }, statsIntervalMs);
  }

  ffmpeg.on('exit', (code, signal) => {
    if (carry.trim()) {
      logLine(carry.trim());
      carry = '';
    }
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    console.log(
      `[ffmpeg][${label}] exit code=${code ?? 'null'} signal=${signal ?? 'null'} `
      + `elapsedMs=${Date.now() - startedAt} stdoutBytes=${stdoutBytes}`
    );
  });
}
function beginStartupTrace(message: Message, title: string, url: string, source: StartupSource): StartupTrace | null {
  if (!startupDebugEnabled()) return null;
  const guildId = message.guild?.id;
  if (!guildId) return null;
  const trace: StartupTrace = {
    id: ++startupTraceIdCounter,
    guildId,
    guildName: message.guild?.name || 'unknown',
    title,
    url,
    source,
    startedAt: Date.now(),
  };
  startupTraces.set(guildId, trace);
  console.log(
    `[startup][${trace.guildName}#${trace.id}] begin source=${source} title="${title}" url=${url}`
  );
  return trace;
}
function getStartupTrace(guildId: string): StartupTrace | undefined {
  return startupTraces.get(guildId);
}
function logStartupTrace(trace: StartupTrace | null | undefined, event: string, details?: string): void {
  if (!trace) return;
  const elapsed = Date.now() - trace.startedAt;
  console.log(
    `[startup][${trace.guildName}#${trace.id}] +${elapsed}ms ${event}${details ? ` | ${details}` : ''}`
  );
}
function clearStartupTrace(guildId: string): void {
  startupTraces.delete(guildId);
}
function prefetchEnabled(): boolean {
  const value = process.env.PREFETCH_NEXT_SONG?.trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}
function prefetchWarmupMs(): number {
  const raw = Number.parseInt(process.env.PREFETCH_WARMUP_MS || '3500', 10);
  if (!Number.isFinite(raw)) return 3500;
  return Math.max(0, raw);
}
function ensurePrefetchDir(): void {
  fs.mkdirSync(PREFETCH_DIR, { recursive: true });
}
function hashForFileName(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}
function removePrefetchFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('[prefetch] Failed to remove file:', filePath, error);
  }
}
function playbackPrimeBytes(): number {
  const raw = Number.parseInt(process.env.PLAYBACK_PRIME_BYTES || '192000', 10);
  if (!Number.isFinite(raw)) return 192000;
  return Math.max(96000, raw);
}
function playbackPrimeTimeoutMs(): number {
  const raw = Number.parseInt(process.env.PLAYBACK_PRIME_TIMEOUT_MS || '1800', 10);
  if (!Number.isFinite(raw)) return 1800;
  return Math.max(0, raw);
}
async function primePcmStream(source: Readable, label: string, hooks?: PrimeHooks): Promise<Readable> {
  const targetBytes = playbackPrimeBytes();
  if (targetBytes <= 0) {
    return source;
  }
  const timeoutMs = playbackPrimeTimeoutMs();
  const output = new PassThrough();
  // discord.js destroys the resource stream on stop/skip; pass that upstream so the
  // ffmpeg/yt-dlp feeding `source` get killed instead of blocking on a full pipe forever.
  output.once('close', () => source.destroy());
  return new Promise((resolve) => {
    let primed = false;
    let bufferedBytes = 0;
    const buffers: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let zeroByteTimeoutAttempts = 0;
    const cleanup = () => {
      source.removeListener('data', onData);
      source.removeListener('end', onEnd);
      source.removeListener('error', onError);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const flushAndPipe = (reason: 'bytes' | 'timeout' | 'eof') => {
      if (primed) return;
      primed = true;
      // Prevent flowing-mode drops while switching from manual buffering to piping.
      source.pause();
      cleanup();
      for (const chunk of buffers) {
        output.write(chunk);
      }
      source.pipe(output);
      source.resume();
      hooks?.onPrimed?.(bufferedBytes, reason);
      resolve(output);
    };
    const armPrimeTimer = () => {
      if (timeoutMs <= 0) return;
      timer = setTimeout(() => {
        if (primed) return;
        if (bufferedBytes === 0) {
          zeroByteTimeoutAttempts += 1;
          console.log(
            `[playback] Prime timeout reached for ${label} with 0 bytes `
            + `(attempt ${zeroByteTimeoutAttempts}), waiting for first audio bytes`
          );
          timer = null;
          armPrimeTimer();
          return;
        }
        console.log(`[playback] Prime timeout reached for ${label}, starting with ${bufferedBytes} bytes`);
        flushAndPipe('timeout');
      }, timeoutMs);
    };
    const onData = (chunk: Buffer | string) => {
      if (primed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bufferedBytes === 0) {
        hooks?.onFirstChunk?.(buf.length);
      }
      buffers.push(buf);
      bufferedBytes += buf.length;
      if (bufferedBytes >= targetBytes) {
        flushAndPipe('bytes');
      }
    };
    const onEnd = () => {
      if (primed) return;
      primed = true;
      cleanup();
      for (const chunk of buffers) {
        output.write(chunk);
      }
      hooks?.onPrimed?.(bufferedBytes, 'eof');
      output.end();
      resolve(output);
    };
    const onError = (error: Error) => {
      if (!primed) {
        // Nobody listens on `output` yet, so destroying it with an error would be an uncaught
        // 'error' event and crash the bot. End it empty instead: the player goes idle and the
        // queue advances to the next song.
        primed = true;
        cleanup();
        console.warn(`[playback] Stream failed before audio started for ${label}: ${error.message}`);
        hooks?.onPrimed?.(bufferedBytes, 'eof');
        output.end();
        resolve(output);
        return;
      }
      output.destroy(error);
    };
    source.on('data', onData);
    source.on('end', onEnd);
    source.on('error', onError);
    armPrimeTimer();
  });
}
function clearPrefetchTimer(guildId: string): void {
  const timer = prefetchTimers.get(guildId);
  if (!timer) return;
  clearTimeout(timer);
  prefetchTimers.delete(guildId);
}
function clearNextSongPrefetch(guildId: string, keepFile = false): void {
  clearPrefetchTimer(guildId);
  const state = nextSongPrefetches.get(guildId);
  if (!state) return;
  if (state.process && state.process.exitCode === null && !state.process.killed) {
    state.process.kill('SIGTERM');
  }
  if (!keepFile) {
    removePrefetchFile(state.filePath);
  }
  nextSongPrefetches.delete(guildId);
}
function markSongStarted(message: Message): void {
  const guildId = message.guild?.id;
  if (!guildId) return;
  songStartTimes.set(guildId, Date.now());
}
function takeReadyPrefetch(guildId: string, url: string): NextSongPrefetch | null {
  const state = nextSongPrefetches.get(guildId);
  if (!state) return null;
  if (state.url !== url || !state.ready) return null;
  nextSongPrefetches.delete(guildId);
  return state;
}
function startNextSongPrefetch(message: Message): void {
  if (!prefetchEnabled()) return;
  const guildId = message.guild?.id;
  if (!guildId) return;
  const queue = queues.get(guildId);
  if (!queue) {
    clearNextSongPrefetch(guildId);
    return;
  }
  const nextSong = queue.getQueue()[0];
  if (!nextSong?.url) {
    clearNextSongPrefetch(guildId);
    return;
  }
  const existing = nextSongPrefetches.get(guildId);
  if (existing?.url === nextSong.url) {
    return;
  }
  if (existing) {
    clearNextSongPrefetch(guildId);
  }
  ensurePrefetchDir();
  // Container depends on the source (webm, m4a, mpegts); ffmpeg probes the content, not the extension.
  const fileName = `${guildId}-${hashForFileName(nextSong.url)}.audio`;
  const filePath = path.join(PREFETCH_DIR, fileName);
  removePrefetchFile(filePath);
  console.log(`[prefetch] Starting next-song prefetch guild=${message.guild?.name} url=${nextSong.url}`);
  const process = spawn(YTDLP_BIN, buildYtDlpSpawnArgs([
    '-f', 'bestaudio',
    '--no-warnings',
    '--no-progress',
    '-o', filePath,
    ...ytDlpStreamInput(nextSong),
  ]));
  const state: NextSongPrefetch = {
    guildId,
    url: nextSong.url,
    title: nextSong.title,
    filePath,
    ready: false,
    process,
  };
  nextSongPrefetches.set(guildId, state);
  let sawCookieAuthError = false;
  process.on('error', (error) => {
    console.error(`[prefetch] yt-dlp prefetch process error guild=${message.guild?.name}:`, error);
    clearNextSongPrefetch(guildId);
  });
  process.stderr.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (!line) return;
    if (isYtCookieAuthErrorText(line)) {
      sawCookieAuthError = true;
    }
    if (line.toLowerCase().includes('error')) {
      console.error(`[prefetch] yt-dlp stderr guild=${message.guild?.name}: ${line}`);
    }
  });
  process.on('exit', (code) => {
    const current = nextSongPrefetches.get(guildId);
    if (!current || current.url !== nextSong.url) return;
    if (code === 0 && fs.existsSync(filePath)) {
      current.ready = true;
      current.process = null;
      console.log(
        `[prefetch] Ready guild=${message.guild?.name} title="${nextSong.title}" file=${path.basename(filePath)}`
      );
      return;
    }
    if (sawCookieAuthError) {
      void refreshYtCookiesFromBrowser(
        `prefetch-auth-error guild=${guildId}`,
        nextSong.url
      );
    }
    console.log(`[prefetch] Failed guild=${message.guild?.name} code=${code ?? 'null'} title="${nextSong.title}"`);
    clearNextSongPrefetch(guildId);
  });
}
function requestNextSongPrefetch(message: Message): void {
  if (!prefetchEnabled()) return;
  const guildId = message.guild?.id;
  if (!guildId) return;
  clearPrefetchTimer(guildId);
  const queue = queues.get(guildId);
  if (!queue) {
    clearNextSongPrefetch(guildId);
    return;
  }
  const warmup = prefetchWarmupMs();
  const startedAt = songStartTimes.get(guildId);
  const delay = startedAt
    ? Math.max(0, warmup - (Date.now() - startedAt))
    : (queue.getCurrentSong() ? warmup : 0);
  if (delay <= 0) {
    startNextSongPrefetch(message);
    return;
  }
  console.log(`[prefetch] Delay prefetch guild=${message.guild?.name} by ${delay}ms`);
  const timer = setTimeout(() => {
    prefetchTimers.delete(guildId);
    startNextSongPrefetch(message);
  }, delay);
  prefetchTimers.set(guildId, timer);
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
  if (!prefetchEnabled()) return;
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

async function ensureQueueAndConnection(message: Message, channelId: string): Promise<MusicQueue> {
  const guildId = message.guild?.id;
  if (!guildId) {
    throw new Error('Cannot create queue without guild');
  }

  const existing = queues.get(guildId);
  if (existing) {
    return existing;
  }

  const pending = queueCreationPromises.get(guildId);
  if (pending) {
    console.log(`[voice] Waiting for in-flight queue creation guild=${message.guild?.name}`);
    return pending;
  }

  const creation = createQueueAndConnection(message, channelId)
    .finally(() => {
      if (queueCreationPromises.get(guildId) === creation) {
        queueCreationPromises.delete(guildId);
      }
    });
  queueCreationPromises.set(guildId, creation);
  return creation;
}

export interface EnqueueResult {
  success: boolean;
  error?: string;
  added: number;
  skipped: number;
  /** Playlist, album or set name when the input was a collection. */
  name: string | null;
  firstTitle: string | null;
}

function userFacingResolveError(error: unknown): string {
  if (error instanceof ResolveError) return error.message;
  return 'Kappaleen haku epäonnistui. Yritä hetken päästä uudelleen.';
}

/** Add tracks to the queue; starts playback when nothing was playing. */
function enqueueTracks(
  queue: MusicQueue,
  tracks: Track[],
  requestedBy: string,
  message: Message,
  usageContext: UsageLogFields,
  isFirstSong: boolean
): void {
  const wasIdle = !queue.getCurrentSong();
  tracks.forEach((track, index) => {
    queue.addSong({ ...track, requestedBy });
    logUsage('queue.song_added', {
      ...usageContext,
      title: track.title,
      url: track.url,
      trackSource: track.source,
      requestedBy,
      queueHadCurrentSong: !wasIdle,
      startedPlayback: wasIdle && index === 0,
      ...(tracks.length > 1 ? { playlistPosition: index + 1 } : {}),
      ...queueUsageMetrics(queue),
    });
  });
  const current = queue.getCurrentSong();
  if (wasIdle && current) {
    void playTrack(current, queue.getPlayer(), message, isFirstSong);
  } else {
    requestNextSongPrefetch(message);
  }
}

/**
 * Queue songs from the web UI (or voice commands). Pass `tracks` when they are already known
 * (search results, saved playlists) to skip resolution; otherwise `input` is resolved as a link or search text.
 */
export async function enqueueFromWeb(
  client: Client,
  guildId: string,
  request: { input?: string; tracks?: Track[] },
  requestedBy: string,
  usageSource: string = 'web'
): Promise<EnqueueResult> {
  const usageContext: UsageLogFields = { source: usageSource, guildId, requestedBy, input: request.input ?? null };
  const fail = (error: string, reason: string, extra: UsageLogFields = {}): EnqueueResult => {
    logUsage('queue.song_add_failed', { ...usageContext, reason, error, ...extra });
    return { success: false, error, added: 0, skipped: 0, name: null, firstTitle: null };
  };

  let tracks = request.tracks ?? [];
  let name: string | null = null;
  let skipped = 0;
  if (tracks.length === 0) {
    const input = request.input?.trim();
    if (!input) return fail('Kirjoita hakusana tai liitä linkki.', 'empty_input');
    const startedAt = Date.now();
    try {
      ({ tracks, name, skipped } = await resolveInput(input));
      console.log(
        `[resolve] guild=${guildId} input="${input}" tracks=${tracks.length} skipped=${skipped} in ${Date.now() - startedAt}ms`
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : formatYtDlpError(error);
      console.error(`[resolve] guild=${guildId} input="${input}" failed in ${Date.now() - startedAt}ms: ${detail}`);
      return fail(userFacingResolveError(error), 'resolve_failed', { detail });
    }
  }

  let queue = queues.get(guildId);
  const isFirstSong = !queue;
  let guild: any = client.guilds.cache.get(guildId) || null;
  if (!queue) {
    const target = await resolveDefaultVoiceChannelForGuild(client, guildId);
    if (target.error || !target.channelId) {
      return fail(target.error || 'Oletusäänikanavaa ei löytynyt.', 'default_voice_channel_unavailable');
    }
    guild = target.guild;
    console.log(`[web-voice] Bootstrapping queue for guild=${guild?.name || guildId} channelId=${target.channelId}`);
    try {
      queue = await ensureQueueAndConnection(createWebPlaybackMessage(client, guild, requestedBy), target.channelId);
    } catch (error) {
      console.error('[web-voice] Failed to create queue/connection from web:', error);
      return fail('Eppu ei päässyt äänikanavalle.', 'voice_connection_failed');
    }
  }
  guild = guild || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return fail('Palvelinta ei löytynyt.', 'guild_not_found');

  enqueueTracks(
    queue,
    tracks,
    requestedBy,
    createWebPlaybackMessage(client, guild, requestedBy),
    { ...usageContext, guildName: guild.name },
    isFirstSong
  );
  return { success: true, added: tracks.length, skipped, name, firstTitle: tracks[0]?.title ?? null };
}
// Track the last bot message for each guild
const lastBotMessages = new Map<string, Message>();
// Track if we've already replied to the original play message
const hasRepliedToPlay = new Map<string, boolean>();
// Check disk space and warn if low
function checkDiskSpace(): { available: number; percentage: number } {
  try {
    const output = execSync('df -h / | tail -1', { encoding: 'utf8' });
    const parts = output.trim().split(/\s+/);
    const percentage = parseInt(parts[4].replace('%', ''));
    const available = parts[3];
    
    if (percentage > 90) {
      console.warn(`⚠️  Disk space warning: ${percentage}% used, ${available} available`);
    }
    
    return { available: parseFloat(available), percentage };
  } catch (error) {
    console.error('Could not check disk space:', error);
    return { available: 0, percentage: 0 };
  }
}
// Clean up log files to prevent them from growing too large
function cleanupLogFiles() {
  try {
    const logFiles = ['eppu-out.log', 'eppu-error.log'];
    const maxSize = 10 * 1024 * 1024; // 10MB
    
    logFiles.forEach(logFile => {
      const logPath = path.join(__dirname, '../../', logFile);
      if (fs.existsSync(logPath)) {
        const stats = fs.statSync(logPath);
        if (stats.size > maxSize) {
          console.log(`Log file ${logFile} is ${(stats.size / 1024 / 1024).toFixed(2)}MB, truncating...`);
          fs.truncateSync(logPath, 0);
        }
      }
    });
  } catch (error) {
    console.error('Error cleaning up log files:', error);
  }
}
function createMusicControls() {
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('pause')
        .setLabel('⏸️ Pause')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('resume')
        .setLabel('▶️ Resume')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('skip')
        .setLabel('⏭️ Skip')
        .setStyle(ButtonStyle.Primary)
    );
  
  return row;
}
async function sendOrEditMusicMessage(message: Message, content: string, isFirstSong: boolean = false) {
  const guildId = message.guild!.id;
  const controls = createMusicControls();
  
  try {
    // If this is the first song and we haven't replied yet, reply to the original message
    if (isFirstSong && !hasRepliedToPlay.get(guildId)) {
      const reply = await message.reply({ content, components: [controls], allowedMentions: { parse: [], repliedUser: false } });
      lastBotMessages.set(guildId, reply);
      hasRepliedToPlay.set(guildId, true);
      return;
    }
    
    // Check if we have a last bot message and if it's still the latest in the channel
    const lastBotMessage = lastBotMessages.get(guildId);
    if (lastBotMessage) {
      try {
        // Fetch the latest messages to see if our message is still the latest
        const latestMessages = await message.channel.messages.fetch({ limit: 1 });
        const latestMessage = latestMessages.first();
        
        if (latestMessage && latestMessage.id === lastBotMessage.id && latestMessage.author.id === message.client.user!.id) {
          // Our message is still the latest, edit it
          await lastBotMessage.edit({ content, components: [controls], allowedMentions: { parse: [], repliedUser: false } });
          return;
        }
      } catch (error) {
        console.log('Could not fetch or edit last message, sending new one');
      }
    }
    
    // Send a new message
    const newMessage = await (message.channel as any).send({ content, components: [controls], allowedMentions: { parse: [], repliedUser: false } });
    lastBotMessages.set(guildId, newMessage);
    
  } catch (error) {
    console.error('Error sending/editing music message:', error);
    // Fallback to simple message
    (message.channel as any).send({ content, allowedMentions: { parse: [] } });
  }
}
function voiceChannelLabel(message: Message, channelId: string | undefined): string {
  if (!channelId) return 'none';
  const channel = message.guild?.channels.cache.get(channelId);
  const channelName = channel?.isTextBased() || channel?.isVoiceBased() ? channel.name : 'unknown';
  return `${channelName} (${channelId})`;
}

function queueStateSnapshot(guildId: string): string {
  const queue = queues.get(guildId);
  if (!queue) return 'queue=none';
  const currentSong = queue.getCurrentSong();
  const currentTitle = currentSong?.title || 'none';
  const queuedCount = queue.getQueue().length;
  const hasNext = queue.hasNextSong();
  const queueIdle = queue.isIdle();
  const playerState = queue.getPlayer().state.status;
  return `queueCurrent="${currentTitle}" queuedCount=${queuedCount} hasNext=${hasNext} queueIdle=${queueIdle} playerState=${playerState}`;
}

function queueUsageMetrics(queue: MusicQueue | undefined | null): UsageLogFields {
  if (!queue) return { queuePresent: false };
  const currentSong = queue.getCurrentSong();
  return {
    queuePresent: true,
    currentTitle: currentSong?.title ?? null,
    currentUrl: currentSong?.url ?? null,
    queuedCount: queue.getQueue().length,
    hasNextSong: queue.hasNextSong(),
    paused: queue.isPausedState(),
    playerState: queue.getPlayer().state.status,
  };
}

function messageUsageContext(message: Message, source: string): UsageLogFields {
  const channel = message.channel as any;
  const author = message.author as any;
  const voiceChannel = message.member?.voice?.channel as any;
  return {
    source,
    guildId: message.guild?.id ?? null,
    guildName: message.guild?.name ?? null,
    channelId: channel?.id ?? null,
    channelName: channel?.name ?? null,
    voiceChannelId: voiceChannel?.id ?? null,
    voiceChannelName: voiceChannel?.name ?? null,
    userId: author?.id ?? null,
    username: author?.globalName || author?.username || null,
  };
}

function hasGuildTrackingState(guildId: string): boolean {
  return queues.has(guildId)
    || hasRepliedToPlay.has(guildId)
    || lastBotMessages.has(guildId)
    || startupTraces.has(guildId)
    || nextSongPrefetches.has(guildId);
}

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function reconnectAttemptLimit(): number {
  const raw = Number.parseInt(process.env.VOICE_RECONNECT_ATTEMPTS || '5', 10);
  if (!Number.isFinite(raw)) return 5;
  return Math.min(12, Math.max(1, raw));
}

function reconnectBackoffBaseMs(): number {
  const raw = Number.parseInt(process.env.VOICE_RECONNECT_BACKOFF_MS || '1500', 10);
  if (!Number.isFinite(raw)) return 1500;
  return Math.max(200, raw);
}

function voiceDisconnectReasonLabel(reason: unknown): string {
  if (typeof reason !== 'number') return String(reason ?? 'unknown');
  switch (reason) {
    case VoiceConnectionDisconnectReason.WebSocketClose:
      return 'WebSocketClose';
    case VoiceConnectionDisconnectReason.AdapterUnavailable:
      return 'AdapterUnavailable';
    case VoiceConnectionDisconnectReason.EndpointRemoved:
      return 'EndpointRemoved';
    case VoiceConnectionDisconnectReason.Manual:
      return 'Manual';
    default:
      return `Unknown(${reason})`;
  }
}
export async function handlePlay(message: Message, url: string) {
  console.log('Starting handlePlay with URL:', url);
  const usageContext = {
    ...messageUsageContext(message, 'discord'),
    commandName: 'play',
    url,
  };
  logUsage('play.requested', usageContext);
  
  // Check disk space before proceeding
  const diskInfo = checkDiskSpace();
  if (diskInfo.percentage > 95) {
    logUsage('play.rejected', {
      ...usageContext,
      reason: 'disk_space_critical',
      diskUsedPercent: diskInfo.percentage,
      diskAvailable: diskInfo.available,
    });
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
    logUsage('play.rejected', {
      ...usageContext,
      reason: 'no_voice_channel',
      defaultVoiceChannelId,
    });
    message.reply('You need to be in a voice channel (or configure DEFAULT_VOICE_CHANNEL_ID).');
    return;
  }
  const guildId = message.guild!.id;
  const resolveStartedAt = Date.now();
  let resolved;
  try {
    resolved = await resolveInput(url);
    console.log(
      `[resolve] play guild=${guildId} input="${url}" tracks=${resolved.tracks.length} `
      + `skipped=${resolved.skipped} in ${Date.now() - resolveStartedAt}ms`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : formatYtDlpError(error);
    console.error(`[resolve] play guild=${guildId} input="${url}" failed: ${detail}`);
    logUsage('play.failed', { ...usageContext, error: detail });
    message.reply({ content: userFacingResolveError(error), allowedMentions: { parse: [], repliedUser: false } });
    return;
  }

  try {
    let queue = queues.get(guildId);
    const isFirstSong = !queue;
    if (!queue) {
      queue = await ensureQueueAndConnection(message, targetVoiceChannel.id);
    }
    const hadCurrentSong = !!queue.getCurrentSong();
    enqueueTracks(queue, resolved.tracks, message.author.username, message, usageContext, isFirstSong);
    if (resolved.name) {
      const skippedNote = resolved.skipped ? ` (${resolved.skipped} ei saatavilla)` : '';
      message.reply({ content: `Lisättiin ${resolved.tracks.length} kappaletta listalta ${resolved.name}${skippedNote}.`, allowedMentions: { parse: [], repliedUser: false } });
      logUsage('playlist.added', { ...usageContext, addedCount: resolved.tracks.length, skipped: resolved.skipped });
    } else if (hadCurrentSong) {
      await sendOrEditMusicMessage(message, `Added to queue: ${resolved.tracks[0].title}`);
    }
  } catch (error) {
    console.error('Play command error:', error);
    logUsage('play.failed', { ...usageContext, error });
    message.reply('Eppu ei päässyt äänikanavalle.');
  }
}
const recoveryConnections = new WeakSet<VoiceConnection>();
export function ensureVoiceConnectionRecovery(connection: VoiceConnection, guildId: string, guildName: string): void {
  if (recoveryConnections.has(connection)) return;
  recoveryConnections.add(connection);
  connection.on('stateChange', (oldState, newState) => {
    console.log(
      `[voice] Connection state guild=${guildName} channel=${connection.joinConfig.channelId} `
      + `${oldState.status} -> ${newState.status}`
    );
  });
  connection.on('error', error => {
    console.error(`[voice] Connection error guild=${guildName} channel=${connection.joinConfig.channelId}:`, error);
  });
  connection.on(VoiceConnectionStatus.Disconnected, async (_oldState, newState) => {
    const disconnectedState = newState as unknown as { reason?: unknown; closeCode?: unknown };
    const reason = disconnectedState.reason;
    const closeCode = typeof disconnectedState.closeCode === 'number' ? disconnectedState.closeCode : null;
    const reconnectWindowMsRaw = Number.parseInt(process.env.VOICE_RECONNECT_WINDOW_MS || '15000', 10);
    const reconnectWindowMs = Number.isFinite(reconnectWindowMsRaw) ? Math.max(2000, reconnectWindowMsRaw) : 15000;
    const maxAttempts = reconnectAttemptLimit();
    const backoffBaseMs = reconnectBackoffBaseMs();
    console.warn(
      `[voice] Connection disconnected guild=${guildName}, attempting reconnect `
      + `within ${reconnectWindowMs}ms reason=${voiceDisconnectReasonLabel(reason)} `
      + `closeCode=${closeCode ?? 'n/a'} maxAttempts=${maxAttempts} `
      + `| ${queueStateSnapshot(guildId)}`
    );

    // 4014 means Discord told us to disconnect (channel move/kick/etc). Give it one connect window.
    if (reason === VoiceConnectionDisconnectReason.WebSocketClose && closeCode === 4014) {
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, reconnectWindowMs);
        console.log(`[voice] 4014 disconnect transitioned to connecting guild=${guildName}`);
        return;
      } catch (error) {
        console.warn(`[voice] 4014 reconnect window expired guild=${guildName}`, error);
      }
    }

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (connection.state.status === VoiceConnectionStatus.Destroyed) {
          console.warn(`[voice] Connection already destroyed before rejoin attempt guild=${guildName}`);
          return;
        }

        const accepted = connection.rejoin();
        console.warn(
          `[voice] Rejoin attempt guild=${guildName} attempt=${attempt}/${maxAttempts} `
          + `accepted=${accepted} internalAttempts=${connection.rejoinAttempts} `
          + `state=${connection.state.status}`
        );

        if (!accepted) {
          await waitMs(Math.min(backoffBaseMs * attempt, 10_000));
          continue;
        }

        try {
          await entersState(connection, VoiceConnectionStatus.Ready, reconnectWindowMs);
          console.log(`[voice] Rejoin succeeded guild=${guildName} after attempt=${attempt}`);
          return;
        } catch (error) {
          console.warn(
            `[voice] Rejoin attempt failed guild=${guildName} attempt=${attempt} `
            + `state=${connection.state.status}`,
            error
          );
          await waitMs(Math.min(backoffBaseMs * attempt, 10_000));
        }
      }
    } catch (error) {
      console.error(`[voice] Unexpected reconnect handler error guild=${guildName}`, error);
    }

    console.error(
      `[voice] Reconnect exhausted guild=${guildName} connectionState=${connection.state.status} `
      + `| ${queueStateSnapshot(guildId)}`
    );
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      console.log('Voice connection reconnect failed, destroying connection');
      connection.destroy();
    }
    if (queues.has(guildId)) {
      dropQueue(guildId);
      hasRepliedToPlay.delete(guildId);
      lastBotMessages.delete(guildId);
      clearStartupTrace(guildId);
      clearNextSongPrefetch(guildId);
      console.log(`Cleaned up queue and tracking for guild: ${guildId}`);
    }
  });
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
    selfDeaf: false,
  });
  ensureVoiceConnectionRecovery(connection, guildId, message.guild!.name);
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
    startDiscordVoiceReceiver(connection, guildId, message.client.user?.id);
  } catch (error) {
    console.error(
      `[voice] Connection did not become ready guild=${message.guild?.name} channel=${voiceChannelLabel(message, channelId)}`,
      error
    );
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        connection.destroy();
      } catch (destroyError) {
        console.warn('[voice] Ignored destroy failure after readiness timeout:', destroyError);
      }
    }
    if (queues.get(guildId) === queue) {
      dropQueue(guildId);
    }
    clearStartupTrace(guildId);
    clearNextSongPrefetch(guildId);
    hasRepliedToPlay.delete(guildId);
    lastBotMessages.delete(guildId);
    throw error;
  }
  player.on(AudioPlayerStatus.Idle, () => {
    console.log(`[voice] Audio player entered idle guild=${message.guild?.name} | ${queueStateSnapshot(guildId)}`);
    const finishedSong = queue.getCurrentSong();
    logUsage('playback.idle', {
      ...messageUsageContext(message, 'playback'),
      title: finishedSong?.title ?? null,
      url: finishedSong?.url ?? null,
      ...queueUsageMetrics(queue),
    });
    const nextSong = queue.getNextSong();
    if (nextSong) {
      console.log(`[voice] Advancing to next song guild=${message.guild?.name} title="${nextSong.title}"`);
      logUsage('playback.advance', {
        ...messageUsageContext(message, 'playback'),
        title: nextSong.title,
        url: nextSong.url,
        ...queueUsageMetrics(queue),
      });
      void playTrack(nextSong, queue.getPlayer(), message);
    } else {
      clearStartupTrace(guildId);
      clearNextSongPrefetch(guildId);
      // Wait before disconnecting so users can queue more songs
      console.log(`[voice] No next song guild=${message.guild?.name}, scheduling leave check in 60000ms`);
      setTimeout(() => {
        console.log(`[voice] Running delayed leave check guild=${message.guild?.name} | ${queueStateSnapshot(guildId)}`);
        // Re-check: if a song was added during the delay, don't leave
        if (!queue.getCurrentSong() && !queue.hasNextSong()) {
          checkAndLeaveChannel(guildId, message.client);
        } else {
          console.log(`[voice] Delayed leave cancelled guild=${message.guild?.name}, queue refilled`);
        }
      }, 60_000); // Wait 60 seconds before leaving
    }
  });
  
  return queue;
}
function createTrackStream(track: QueueItem): Readable {
  const youtubeUrl = track.url;
  // The android client fallback only applies to YouTube itself.
  const fallbackAllowed = track.source === 'youtube';
  const passthrough = new PassThrough();
  const children: ChildProcessWithoutNullStreams[] = [];
  passthrough.once('close', () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
  let settled = false;
  let startedFallback = false;

  const finishWithError = (error: Error) => {
    if (settled) return;
    settled = true;
    passthrough.destroy(error);
  };
  const finishSuccess = () => {
    if (settled) return;
    settled = true;
    passthrough.end();
  };

  const startAttempt = (mode: 'default' | 'android-fallback') => {
    const usingFallback = mode === 'android-fallback';
    const ytdlpArgs = usingFallback
      ? [
          '--extractor-args', 'youtube:player_client=android',
          '-f', '18/best',
          '-o', '-',
          '--quiet',
          '--no-warnings',
          '--no-progress',
          youtubeUrl,
        ]
      : buildYtDlpSpawnArgs([
          '-f', 'bestaudio',
          '-o', '-',
          '--quiet',
          '--no-warnings',
          '--no-progress',
          ...ytDlpStreamInput(track),
        ]);
    console.log(
      usingFallback
        ? `Piping yt-dlp -> ffmpeg with android fallback for: ${youtubeUrl}`
        : `Piping yt-dlp -> ffmpeg for: ${youtubeUrl} (source=${track.source})`
    );
    const ytdlp = spawn(YTDLP_BIN, ytdlpArgs);
    children.push(ytdlp);
    const ffmpeg = spawn('ffmpeg', [
      '-re',
      '-i', 'pipe:0',
      '-analyzeduration', '0',
      '-probesize', '32768',
      '-loglevel', ffmpegLogLevel(),
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-acodec', 'pcm_s16le',
      '-bufsize', '64k',
      'pipe:1'
    ]);
    children.push(ffmpeg);
    let ytdlpStdoutBytes = 0;
    let ffmpegProducedOutput = false;
    let ytdlpExited = false;
    let ffmpegExited = false;
    let sawCookieAuthError = false;
    let sawChallengeError = false;
    let stderrText = '';
    const ytdlpStatsEnabled = ffmpegVerboseLogsEnabled();
    const ytdlpStatsIntervalMs = ffmpegStatsIntervalMs();
    let ytdlpLastStatsBytes = 0;
    let ytdlpStatsTimer: ReturnType<typeof setInterval> | null = null;

    ytdlp.stdout.on('data', (chunk: Buffer) => {
      ytdlpStdoutBytes += chunk.length;
    });
    ytdlp.stdout.pipe(ffmpeg.stdin, { end: true });
    ffmpeg.stdin.on('error', (error) => {
      logStreamIssue('FFmpeg stdin error', error);
    });
    if (ytdlpStatsEnabled) {
      const ytdlpStartedAt = Date.now();
      ytdlpStatsTimer = setInterval(() => {
        const delta = ytdlpStdoutBytes - ytdlpLastStatsBytes;
        ytdlpLastStatsBytes = ytdlpStdoutBytes;
        const rateBps = Math.round(delta / (ytdlpStatsIntervalMs / 1000));
        console.log(
          `[yt-dlp][stream:${mode}] +${Date.now() - ytdlpStartedAt}ms stats bytes=${ytdlpStdoutBytes} rateBps=${rateBps}`
        );
      }, ytdlpStatsIntervalMs);
    }
    ytdlp.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (!line) return;
      stderrText += `${line}\n`;
      if (stderrText.length > 8192) stderrText = stderrText.slice(-8192);
      if (isYtCookieAuthErrorText(line)) {
        sawCookieAuthError = true;
      }
      if (isYtExtractionChallengeErrorText(line)) {
        sawChallengeError = true;
      }
      const lowered = line.toLowerCase();
      if (ytdlpVerboseLogsEnabled()) {
        console.log(`yt-dlp[${mode}]:`, line);
        return;
      }
      if (lowered.includes('error') || lowered.includes('warning')) {
        console.warn(`yt-dlp[${mode}]:`, line);
      }
    });
    ytdlp.on('error', error => {
      console.error(`yt-dlp process error [${mode}]:`, error);
    });
    ffmpeg.on('error', error => {
      console.error(`FFmpeg process error [${mode}]:`, error);
    });
    wireFfmpegDiagnostics(ffmpeg, `yt-pipe:${mode}:${youtubeUrl}`);
    ffmpeg.stdout.on('data', () => {
      ffmpegProducedOutput = true;
    });
    ffmpeg.stdout.on('error', error => {
      logStreamIssue('FFmpeg stdout error', error);
    });
    ffmpeg.stdout.pipe(passthrough, { end: false });

    const maybeStartFallback = () => {
      if (settled || usingFallback || startedFallback || !fallbackAllowed) return false;
      startedFallback = true;
      console.warn(`[yt-dlp] Stream fallback engaged for ${youtubeUrl}`);
      if (!ffmpegExited && ffmpeg.exitCode === null) {
        ffmpeg.kill();
      }
      startAttempt('android-fallback');
      return true;
    };

    ytdlp.on('exit', (code) => {
      if (ytdlpStatsTimer) {
        clearInterval(ytdlpStatsTimer);
        ytdlpStatsTimer = null;
      }
      ytdlpExited = true;
      if (code !== 0) console.log(`yt-dlp exited with code ${code} [${mode}]`);
      if (code !== 0 && !ffmpegExited) {
        if (sawCookieAuthError) {
          void refreshYtCookiesFromBrowser(`stream-auth-error:${mode}`, youtubeUrl);
        } else if (sawChallengeError || ytdlpStdoutBytes === 0) {
          void refreshYtCookiesFromBrowser(`stream-extractor-error:${mode}`, youtubeUrl);
        }
        if ((sawChallengeError || ytdlpStdoutBytes === 0) && maybeStartFallback()) {
          return;
        }
      }
      if (usingFallback && code !== 0 && !ffmpegProducedOutput) {
        finishWithError(new Error(`yt-dlp fallback failed: ${stderrText.trim() || `exit ${code}`}`));
      }
    });
    ffmpeg.on('exit', (code) => {
      ffmpegExited = true;
      if (code !== 0) console.log(`FFmpeg exited with code ${code} [${mode}]`);
      if (ytdlpStatsTimer) {
        clearInterval(ytdlpStatsTimer);
        ytdlpStatsTimer = null;
      }
      if (!ytdlpExited && ytdlp.exitCode === null) {
        ytdlp.kill();
      }
      if (code === 0 && (usingFallback || !startedFallback)) {
        finishSuccess();
        return;
      }
      if (!ffmpegProducedOutput && maybeStartFallback()) {
        return;
      }
      // A fallback attempt that is running owns the output from here on.
      if (startedFallback && !usingFallback) {
        return;
      }
      // Nothing else will produce audio: end the track (or fail it) so the queue can advance.
      if (ffmpegProducedOutput) {
        finishSuccess();
      } else {
        finishWithError(new Error(`ffmpeg ${mode} failed for ${youtubeUrl}: ${stderrText.trim() || `exit ${code}`}`));
      }
    });
  };

  startAttempt('default');
  return passthrough;
}
function createPrefetchedFileStream(filePath: string): Readable {
  const ffmpeg = spawn('ffmpeg', [
    '-re',
    '-i', filePath,
    '-analyzeduration', '0',
    '-probesize', '32768',
    '-loglevel', ffmpegLogLevel(),
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-acodec', 'pcm_s16le',
    '-bufsize', '64k',
    'pipe:1'
  ]);
  wireFfmpegDiagnostics(ffmpeg, `prefetch:${path.basename(filePath)}`);
  ffmpeg.on('error', error => {
    console.error('[prefetch] FFmpeg process error for prefetched file:', error);
  });
  ffmpeg.on('exit', (code, signal) => {
    if (code !== 0 && !signal) {
      console.error(`[prefetch] FFmpeg exited with code ${code} for prefetched file ${path.basename(filePath)}`);
    }
    removePrefetchFile(filePath);
  });
  const passthrough = new PassThrough();
  ffmpeg.stdout.pipe(passthrough);
  passthrough.once('close', () => {
    if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) ffmpeg.kill('SIGKILL');
  });
  return passthrough;
}
/** Start playing a queue item, from the prefetched file when one is ready, else streaming live. */
async function playTrack(track: QueueItem, player: AudioPlayer, message: Message, isFirstSong: boolean = false) {
  const guildId = message.guild!.id;
  const prefetched = takeReadyPrefetch(guildId, track.url);
  const startupSource: StartupSource = prefetched ? 'prefetched' : 'live';
  try {
    const trace = beginStartupTrace(message, track.title, track.url, startupSource);
    console.log(`[playback] Starting ${startupSource} guild=${message.guild?.name} source=${track.source} title="${track.title}"`);
    const baseStream = prefetched ? createPrefetchedFileStream(prefetched.filePath) : createTrackStream(track);
    baseStream.once('data', (chunk) => {
      if (!trace || trace.baseFirstChunkAt) return;
      trace.baseFirstChunkAt = Date.now();
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      logStartupTrace(trace, 'base-first-chunk', `bytes=${size}`);
    });
    baseStream.on('error', (error: Error & { code?: string }) => {
      logStreamIssue(`[playback] ${startupSource} stream issue`, error);
    });
    const stream = await primePcmStream(baseStream, `${startupSource}:${track.title}`, {
      onFirstChunk: (bytes) => {
        logStartupTrace(trace, 'prime-first-chunk', `bytes=${bytes}`);
      },
      onPrimed: (bytes, reason) => {
        if (!trace) return;
        trace.primeReadyAt = Date.now();
        trace.primeBytes = bytes;
        trace.primeReason = reason;
        logStartupTrace(trace, 'prime-ready', `bytes=${bytes}, reason=${reason}`);
      },
    });
    const queue = queues.get(guildId);
    if (queue?.getPlayer() !== player) {
      // The queue was cleared (reset, disconnect) while this track was starting.
      stream.destroy();
      return;
    }
    logStartupTrace(trace, 'create-audio-resource');
    const resource = createPlaybackResource(stream, message);
    if (trace) {
      trace.playerPlayAt = Date.now();
    }
    logStartupTrace(trace, 'player.play()');
    player.play(resource);
    if (queue.consumePendingSkip()) {
      // Skip was pressed while the track was still starting; the Idle handler advances the queue.
      console.log(`[playback] Skip requested during startup, skipping "${track.title}"`);
      player.stop();
      return;
    }
    logUsage('playback.started', {
      ...messageUsageContext(message, 'playback'),
      title: track.title,
      url: track.url,
      trackSource: track.source,
      startupSource,
    });
    markSongStarted(message);
    await sendOrEditMusicMessage(message, `Now playing: ${track.title}`, isFirstSong);
    requestNextSongPrefetch(message);
  } catch (error) {
    console.error(`[playback] Failed to start ${startupSource} playback:`, error);
    logUsage('playback.failed', {
      ...messageUsageContext(message, 'playback'),
      title: track.title,
      url: track.url,
      trackSource: track.source,
      startupSource,
      error,
    });
    if (prefetched) {
      removePrefetchFile(prefetched.filePath);
      await playTrack(track, player, message, isFirstSong);
      return;
    }
    (message.channel as any).send({ content: `Failed to play: ${track.title}, skipping...`, allowedMentions: { parse: [] } });
    player.stop();
  }
}
export function handlePause(message: Message) {
  const queue = queues.get(message.guild!.id);
  const usageContext = {
    ...messageUsageContext(message, 'discord'),
    commandName: 'pause',
  };
  if (!queue) {
    logUsage('queue.pause', {
      ...usageContext,
      ok: false,
      reason: 'no_queue',
    });
    message.reply('No music is playing!');
    return;
  }
  if (queue.pause()) {
    logUsage('queue.pause', {
      ...usageContext,
      ok: true,
      ...queueUsageMetrics(queue),
    });
    message.reply('Paused the music!');
  } else {
    logUsage('queue.pause', {
      ...usageContext,
      ok: false,
      reason: 'already_paused',
      ...queueUsageMetrics(queue),
    });
    message.reply('The music is already paused!');
  }
}
export function handleResume(message: Message) {
  const queue = queues.get(message.guild!.id);
  const usageContext = {
    ...messageUsageContext(message, 'discord'),
    commandName: 'resume',
  };
  if (!queue) {
    logUsage('queue.resume', {
      ...usageContext,
      ok: false,
      reason: 'no_queue',
    });
    message.reply('No music is queued!');
    return;
  }
  if (queue.resume()) {
    logUsage('queue.resume', {
      ...usageContext,
      ok: true,
      ...queueUsageMetrics(queue),
    });
    message.reply('Resumed the music!');
  } else {
    logUsage('queue.resume', {
      ...usageContext,
      ok: false,
      reason: 'already_playing',
      ...queueUsageMetrics(queue),
    });
    message.reply('The music is already playing!');
  }
}
export function handleSkip(message: Message) {
  const queue = queues.get(message.guild!.id);
  const usageContext = {
    ...messageUsageContext(message, 'discord'),
    commandName: 'skip',
  };
  if (!queue) {
    logUsage('queue.skip', {
      ...usageContext,
      ok: false,
      reason: 'no_queue',
    });
    message.reply('No music is playing!');
    return;
  }
  const skippedSong = queue.getCurrentSong();
  queue.skip();
  logUsage('queue.skip', {
    ...usageContext,
    ok: true,
    skippedTitle: skippedSong?.title ?? null,
    skippedUrl: skippedSong?.url ?? null,
    ...queueUsageMetrics(queue),
  });
  message.reply('Skipped the current song!');
}
export function handleQueue(message: Message) {
  const queue = queues.get(message.guild!.id);
  const usageContext = {
    ...messageUsageContext(message, 'discord'),
    commandName: 'queue',
  };
  if (!queue) {
    logUsage('queue.view', {
      ...usageContext,
      ok: false,
      reason: 'no_queue',
    });
    message.reply('No music is queued!');
    return;
  }
  logUsage('queue.view', {
    ...usageContext,
    ok: true,
    ...queueUsageMetrics(queue),
  });
  const currentSong = queue.getCurrentSong();
  const queueList = queue.getQueue();
  let response = 'Music Queue:\n';
  if (currentSong) {
    response += `Now Playing: ${currentSong.title} (requested by ${currentSong.requestedBy})\n\n`;
  }
  if (queueList.length === 0) {
    response += 'No songs in queue.';
  } else {
    response += queueList
      .map((song, index) => `${index + 1}. ${song.title} (requested by ${song.requestedBy})`)
      .join('\n');
  }
  message.reply({ content: response, allowedMentions: { parse: [], repliedUser: false } });
}
export function handleHelp(message: Message) {
  logUsage('help.view', {
    ...messageUsageContext(message, 'discord'),
    commandName: 'help',
  });
  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle('🎵 Music Bot Commands')
    .setDescription('Here are all the available commands:')
    .addFields(
      { name: '/play url:<linkki tai hakusana>', value: 'YouTube, SoundCloud or Spotify link (track, playlist, album), or search text', inline: false },
      { name: '/pause', value: 'Pause the current song', inline: true },
      { name: '/resume', value: 'Resume the paused song', inline: true },
      { name: '/skip', value: 'Skip the current song', inline: true },
      { name: '/queue', value: 'Show the current music queue', inline: false },
      { name: '/nukkumaan', value: 'Reset the bot and disconnect from all voice channels (Admin only)', inline: false },
      { name: '/cleanup', value: 'Force cleanup and disconnect from voice channels (Admin only)', inline: false },
      { name: '/help', value: 'Show this help message', inline: false },
      { name: '/web-login', value: 'Get a one-time web login link in DM', inline: false }
    )
    .setFooter({ text: 'You can also use the buttons on music messages for quick controls!' })
    .setTimestamp();
  message.reply({ embeds: [embed] });
}
export function handleCleanup(message: Message) {
  const usageContext = {
    ...messageUsageContext(message, 'discord'),
    commandName: 'cleanup',
  };
  if (!message.member?.permissions.has('Administrator')) {
    logUsage('cleanup.rejected', {
      ...usageContext,
      reason: 'missing_admin_permission',
    });
    message.reply('You need administrator permissions to use this command!');
    return;
  }
  try {
    message.reply('Running cleanup...');
    checkAndLeaveIfNeeded(message.client);
    logUsage('cleanup.requested', usageContext);
    message.reply('Cleanup completed! Check console for details.');
  } catch (error) {
    console.error('Cleanup command error:', error);
    logUsage('cleanup.failed', {
      ...usageContext,
      error,
    });
    message.reply('Error during cleanup!');
  }
}
export function handleNukkumaan(message: Message) {
  const usageContext = {
    ...messageUsageContext(message, 'discord'),
    commandName: 'nukkumaan',
  };
  if (!message.member?.permissions.has('Administrator')) {
    logUsage('reset.rejected', {
      ...usageContext,
      reason: 'missing_admin_permission',
    });
    message.reply('You need administrator permissions to use this command!');
    return;
  }
  try {
    // Check all guilds where the bot is in voice channels
    message.client.guilds.cache.forEach(guild => {
      const queue = queues.get(guild.id);
      if (queue) {
        // Stop the player and clear the queue
        dropQueue(guild.id);
        logUsage('reset.queue_cleared', {
          ...usageContext,
          guildId: guild.id,
          guildName: guild.name,
        });
      }
      clearStartupTrace(guild.id);
      clearNextSongPrefetch(guild.id);
      // Check if bot is in a voice channel
      const me = guild.members.cache.get(message.client.user!.id);
      if (me?.voice.channel) {
        // Force disconnect from voice channel
        const connection = getVoiceConnection(guild.id);
        if (connection) {
          connection.destroy();
          console.log(`Destroyed connection in guild: ${guild.name}`);
          logUsage('voice.connection_destroyed', {
            ...usageContext,
            guildId: guild.id,
            guildName: guild.name,
            reason: 'reset',
          });
        }
        me.voice.disconnect();
        console.log(`Left voice channel in guild: ${guild.name}`);
      }
      
      // Reset tracking for this guild
      hasRepliedToPlay.delete(guild.id);
      lastBotMessages.delete(guild.id);
    });
    logUsage('reset.completed', usageContext);
    message.reply('Bot has been reset and disconnected from all voice channels!');
  } catch (error) {
    console.error('Reset command error:', error);
    logUsage('reset.failed', {
      ...usageContext,
      error,
    });
    message.reply('Error during reset!');
  }
}
function checkAndLeaveChannel(guildId: string, client: Client): boolean {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.log(`Guild ${guildId} not found, cleaning up...`);
    const hadTracking = hasGuildTrackingState(guildId);
    if (hadTracking) {
      logUsage('voice.cleanup', {
        source: 'periodic_cleanup',
        guildId,
        reason: 'guild_not_found',
      });
    }
    // Clean up even if guild not found
    if (queues.has(guildId)) {
      dropQueue(guildId);
      hasRepliedToPlay.delete(guildId);
      lastBotMessages.delete(guildId);
    }
    clearStartupTrace(guildId);
    clearNextSongPrefetch(guildId);
    return hadTracking;
  }
  const botMember = guild.members.cache.get(client.user!.id);
  const channel = botMember?.voice.channel;
  
  if (!channel) {
    console.log(`Bot not in voice channel in ${guild.name}, cleaning up...`);
    const hadTracking = hasGuildTrackingState(guildId);
    if (hadTracking) {
      logUsage('voice.cleanup', {
        source: 'periodic_cleanup',
        guildId,
        guildName: guild.name,
        reason: 'bot_not_in_voice_channel',
      });
    }
    // Clean up if not in voice channel
    if (queues.has(guildId)) {
      dropQueue(guildId);
      hasRepliedToPlay.delete(guildId);
      lastBotMessages.delete(guildId);
    }
    clearStartupTrace(guildId);
    clearNextSongPrefetch(guildId);
    return hadTracking;
  }
  const humanMembers = channel.members.filter(member => !member.user.bot).size;
  const connection = getVoiceConnection(guildId);
  const connectionState = connection?.state.status;
  if (queueCreationPromises.has(guildId)) {
    console.log(
      `[voice-cleanup] Skip cleanup for ${guild.name}: queue creation in progress `
      + `(connectionState=${connectionState ?? 'none'})`
    );
    return false;
  }
  if (connectionState === VoiceConnectionStatus.Connecting || connectionState === VoiceConnectionStatus.Signalling) {
    console.log(
      `[voice-cleanup] Skip cleanup for ${guild.name}: voice connection bootstrapping `
      + `(state=${connectionState})`
    );
    return false;
  }
  const queue = queues.get(guildId);
  const hasCurrentSong = !!queue?.getCurrentSong();
  const hasNextSong = !!queue?.hasNextSong();
  const isIdle = queue?.isIdle() ?? true;
  const isPlaying = !!(hasCurrentSong && !isIdle);
  const shouldLeaveBecauseAlone = humanMembers === 0;
  const shouldLeaveBecauseNoPlayback = !isPlaying && (!queue || (!hasCurrentSong && !hasNextSong));
  console.log(
    `[voice-cleanup] Evaluate guild=${guild.name} humans=${humanMembers} `
    + `isPlaying=${isPlaying} hasCurrentSong=${hasCurrentSong} hasNextSong=${hasNextSong} `
    + `queueIdle=${isIdle} ${queueStateSnapshot(guildId)}`
  );
  // Leave if bot is alone OR if no music is playing and queue is empty
  // A receiver must stay connected even between songs or while its channel is empty.
  if (connection && isDiscordVoiceListener(connection)) {
    if (shouldLeaveBecauseAlone || shouldLeaveBecauseNoPlayback) {
      dropQueue(guildId);
      clearStartupTrace(guildId);
      clearNextSongPrefetch(guildId);
      hasRepliedToPlay.delete(guildId);
      lastBotMessages.delete(guildId);
      const defaultChannelId = process.env.DEFAULT_VOICE_CHANNEL_ID?.trim();
      const defaultChannel = defaultChannelId ? guild.channels.cache.get(defaultChannelId) : null;
      if (defaultChannel?.isVoiceBased() && connection.joinConfig.channelId !== defaultChannel.id) {
        console.log(`[voice-cleanup] Returning voice listener to default channel in ${guild.name}`);
        connection.rejoin({ channelId: defaultChannel.id, selfDeaf: false, selfMute: connection.joinConfig.selfMute });
      }
    }
    console.log(`[voice-cleanup] Keeping voice listener for ${guild.name}`);
    return false;
  }
  if (shouldLeaveBecauseAlone || shouldLeaveBecauseNoPlayback) {
    const leaveReason = shouldLeaveBecauseAlone ? 'alone' : 'no music playing';
    console.log(`[voice-cleanup] Leaving voice channel in ${guild.name}: ${leaveReason}`);
    
    if (connection) {
      try {
        connection.destroy();
        console.log(`[voice-cleanup] Destroyed voice connection for ${guild.name}`);
        logUsage('voice.connection_destroyed', {
          source: 'periodic_cleanup',
          guildId,
          guildName: guild.name,
          channelId: channel.id,
          channelName: channel.name,
          reason: leaveReason,
        });
      } catch (error) {
        console.error(`[voice-cleanup] Error destroying connection for ${guild.name}:`, error);
      }
    }
    
    if (queue) {
      try {
        const player = queue.getPlayer();
        player.stop();
        console.log(`[voice-cleanup] Stopped audio player for ${guild.name}`);
      } catch (error) {
        console.error(`[voice-cleanup] Error stopping player for ${guild.name}:`, error);
      }
      dropQueue(guildId);
    }
    clearStartupTrace(guildId);
    clearNextSongPrefetch(guildId);
    logUsage('voice.cleanup', {
      source: 'periodic_cleanup',
      guildId,
      guildName: guild.name,
      channelId: channel.id,
      channelName: channel.name,
      reason: leaveReason,
      humans: humanMembers,
      ...queueUsageMetrics(queue),
    });
    
    // Reset tracking for this guild
    hasRepliedToPlay.delete(guildId);
    lastBotMessages.delete(guildId);
    console.log(`[voice-cleanup] Cleaned up all tracking for ${guild.name}`);
    return true;
  }
  console.log(`[voice-cleanup] Keeping voice connection for ${guild.name}`);
  return false;
}
export function checkAndLeaveIfNeeded(client: Client, specificGuildId?: string) {
  console.log(`Running checkAndLeaveIfNeeded for ${specificGuildId || 'all guilds'}`);
  
  // Clean up log files first
  cleanupLogFiles();
  
  if (specificGuildId) {
    const guild = client.guilds.cache.get(specificGuildId);
    let cleaned = false;
    if (guild) {
      const botMember = guild.members.cache.get(client.user!.id);
      if (botMember?.voice.channel) {
        cleaned = checkAndLeaveChannel(guild.id, client);
      } else {
        // Bot not in voice channel, clean up anyway
        cleaned = checkAndLeaveChannel(guild.id, client);
      }
    } else {
      // Guild not found, clean up anyway
      cleaned = checkAndLeaveChannel(specificGuildId, client);
    }
    console.log(`[voice-cleanup] Specific guild check complete guildId=${specificGuildId} cleaned=${cleaned}`);
  } else {
    // Check all guilds
    let checkedGuilds = 0;
    let cleanedGuilds = 0;
    
    client.guilds.cache.forEach(guild => {
      checkedGuilds++;
      const botMember = guild.members.cache.get(client.user!.id);
      if (botMember?.voice.channel) {
        const cleaned = checkAndLeaveChannel(guild.id, client);
        if (cleaned) cleanedGuilds++;
      } else {
        // Bot not in voice channel, clean up anyway
        const cleaned = checkAndLeaveChannel(guild.id, client);
        if (cleaned) cleanedGuilds++;
      }
    });
    
    console.log(`Checked ${checkedGuilds} guilds, cleaned up ${cleanedGuilds} voice connections`);
  }
}
