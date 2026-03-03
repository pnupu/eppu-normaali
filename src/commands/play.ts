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
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  getVoiceConnection,
  entersState
} from '@discordjs/voice';
import youtubeDl, { Payload, Flags } from 'youtube-dl-exec';
import { MusicQueue } from '../music/queue';
import path from 'path';
import { spawn, ChildProcessWithoutNullStreams, execSync } from 'child_process';
import { Readable, PassThrough } from 'stream';
import fs from 'fs';
import { createHash } from 'crypto';
interface ExtendedRequestedDownload {
  url: string;
}
interface ExtendedPayload extends Omit<Payload, 'requested_downloads'> {
  requested_downloads: ExtendedRequestedDownload[];
}
interface PlaylistEntry {
  title: string;
  url: string;
  id: string;
}
interface SearchEntry {
  id?: string;
  title?: string;
  url?: string;
  duration?: number;
  uploader?: string;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string }>;
}
interface SearchPayload {
  entries?: SearchEntry[];
}
export interface WebSearchResult {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  channel: string | null;
  thumbnail: string | null;
}
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
const YTDLP_BIN = path.join(__dirname, '../../node_modules/youtube-dl-exec/bin/yt-dlp');
const DEFAULT_COOKIES_PATH = path.join(__dirname, '../../cookies.txt');
const nextSongPrefetches = new Map<string, NextSongPrefetch>();
const prefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const songStartTimes = new Map<string, number>();
const startupTraces = new Map<string, StartupTrace>();
const queueCreationPromises = new Map<string, Promise<MusicQueue>>();
let startupTraceIdCounter = 0;
// Per-guild volume tracking (0-100)
const guildVolumes = new Map<string, number>();
export function getVolume(guildId: string): number {
  return guildVolumes.get(guildId) ?? 50;
}
export function setVolume(guildId: string, volume: number): void {
  guildVolumes.set(guildId, Math.max(0, Math.min(100, volume)));
}
function formatYtDlpError(error: unknown): string {
  const err = error as { message?: string; stderr?: string; stdout?: string; exitCode?: number } | null;
  if (!err) return 'unknown error';
  const parts: string[] = [];
  if (typeof err.exitCode === 'number') parts.push(`exitCode=${err.exitCode}`);
  if (err.message) parts.push(`message=${String(err.message).trim()}`);
  if (err.stderr) parts.push(`stderr=${String(err.stderr).trim()}`);
  if (err.stdout) parts.push(`stdout=${String(err.stdout).trim()}`);
  return parts.join(' | ') || 'unknown error';
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
interface YtDlpRuntimeOptions {
  jsRuntimes: string;
  cookiesFilePath: string;
  cookiesFile: string | null;
  cookiesFromBrowser: string | null;
  cookieSource: 'file' | 'browser' | 'none';
}
let runtimeOptionsLogged = false;
function getYtDlpRuntimeOptions(): YtDlpRuntimeOptions {
  const jsRuntimes = process.env.YTDLP_JS_RUNTIMES?.trim() || 'node';
  const cookiesFromBrowserRaw = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  const cookiesFromBrowser = cookiesFromBrowserRaw && cookiesFromBrowserRaw.length > 0
    ? cookiesFromBrowserRaw
    : null;
  const configuredCookiesPath = process.env.YTDLP_COOKIES_FILE?.trim();
  const cookiesPathCandidate = configuredCookiesPath && configuredCookiesPath.length > 0
    ? configuredCookiesPath
    : DEFAULT_COOKIES_PATH;
  const cookiesFile = fs.existsSync(cookiesPathCandidate) ? cookiesPathCandidate : null;
  const cookieSource: YtDlpRuntimeOptions['cookieSource'] = cookiesFile
    ? 'file'
    : (cookiesFromBrowser ? 'browser' : 'none');

  if (!runtimeOptionsLogged) {
    runtimeOptionsLogged = true;
    const cookiesMode = cookieSource === 'file'
      ? `file:${cookiesFile}`
      : (cookieSource === 'browser' ? `browser:${cookiesFromBrowser}` : 'none');
    console.log(`[yt-dlp] runtime js-runtimes=${jsRuntimes} cookies=${cookiesMode}`);
    if (!cookiesFromBrowser && configuredCookiesPath && !cookiesFile) {
      console.warn(`[yt-dlp] Configured cookies file not found: ${configuredCookiesPath}`);
    }
    if (cookiesFile && cookiesFromBrowser) {
      console.log('[yt-dlp] Both cookie file and browser cookies configured; preferring cookies file.');
    }
  }

  return {
    jsRuntimes,
    cookiesFilePath: cookiesPathCandidate,
    cookiesFile,
    cookiesFromBrowser,
    cookieSource,
  };
}
type YtCookieSourceOverride = 'default' | 'file' | 'browser';
function resolveCookieSource(
  runtime: YtDlpRuntimeOptions,
  override: YtCookieSourceOverride = 'default'
): YtDlpRuntimeOptions['cookieSource'] {
  if (override === 'file') {
    return runtime.cookiesFile ? 'file' : 'none';
  }
  if (override === 'browser') {
    return runtime.cookiesFromBrowser ? 'browser' : 'none';
  }
  return runtime.cookieSource;
}
function buildYtDlpFlags(base: Flags, overrideCookieSource: YtCookieSourceOverride = 'default'): Flags {
  const runtime = getYtDlpRuntimeOptions();
  const merged = { ...base } as Flags & { cookiesFromBrowser?: string };
  merged.jsRuntimes = runtime.jsRuntimes as Flags['jsRuntimes'];
  const cookieSource = resolveCookieSource(runtime, overrideCookieSource);
  if (cookieSource === 'file' && runtime.cookiesFile) {
    merged.cookies = runtime.cookiesFile;
  } else if (cookieSource === 'browser' && runtime.cookiesFromBrowser) {
    merged.cookiesFromBrowser = runtime.cookiesFromBrowser;
  }
  return merged;
}
function buildYtDlpSpawnArgs(baseArgs: string[], overrideCookieSource: YtCookieSourceOverride = 'default'): string[] {
  const runtime = getYtDlpRuntimeOptions();
  const args = [...baseArgs, '--js-runtimes', runtime.jsRuntimes];
  const cookieSource = resolveCookieSource(runtime, overrideCookieSource);
  if (cookieSource === 'file' && runtime.cookiesFile) {
    args.push('--cookies', runtime.cookiesFile);
  } else if (cookieSource === 'browser' && runtime.cookiesFromBrowser) {
    args.push('--cookies-from-browser', runtime.cookiesFromBrowser);
  }
  return args;
}
function isYtCookieAuthErrorText(text: string): boolean {
  const value = text.toLowerCase();
  return value.includes('sign in to confirm you')
    || value.includes("sign in to confirm you're not a bot")
    || value.includes('sign in to confirm you\u2019re not a bot')
    || value.includes('use --cookies-from-browser or --cookies for the authentication');
}
function isYtCookieAuthError(error: unknown): boolean {
  const text = formatYtDlpError(error);
  return isYtCookieAuthErrorText(text);
}
let cookieRefreshPromise: Promise<boolean> | null = null;
async function refreshYtCookiesFromBrowser(reason: string, urlForRefresh?: string): Promise<boolean> {
  const runtime = getYtDlpRuntimeOptions();
  const browserProfile = runtime.cookiesFromBrowser;
  if (!browserProfile) {
    console.warn(`[yt-cookie] Skipping refresh (${reason}): YTDLP_COOKIES_FROM_BROWSER not configured`);
    return false;
  }
  if (cookieRefreshPromise) {
    console.log(`[yt-cookie] Refresh already in progress, waiting (reason=${reason})`);
    return cookieRefreshPromise;
  }
  cookieRefreshPromise = new Promise<boolean>((resolve) => {
    try {
      fs.mkdirSync(path.dirname(runtime.cookiesFilePath), { recursive: true });
    } catch (error) {
      console.error(`[yt-cookie] Failed to prepare cookie dir for ${runtime.cookiesFilePath}:`, error);
    }
    const refreshUrl = (urlForRefresh && /^https?:\/\//.test(urlForRefresh))
      ? urlForRefresh
      : (process.env.YTDLP_COOKIE_REFRESH_URL?.trim() || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const args = [
      '--simulate',
      '--no-warnings',
      '--no-progress',
      '--cookies-from-browser', browserProfile,
      '--cookies', runtime.cookiesFilePath,
      '--js-runtimes', runtime.jsRuntimes,
      refreshUrl,
    ];
    console.warn(
      `[yt-cookie] Refreshing cookies reason=${reason} browser=${browserProfile} `
      + `target=${runtime.cookiesFilePath} url=${refreshUrl}`
    );
    const refreshProc = spawn(YTDLP_BIN, args);
    let stderr = '';
    refreshProc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    refreshProc.on('error', (error: Error) => {
      console.error('[yt-cookie] Cookie refresh process error:', error);
      resolve(false);
    });
    refreshProc.on('exit', (code: number | null) => {
      const wroteFile = fs.existsSync(runtime.cookiesFilePath) && fs.statSync(runtime.cookiesFilePath).size > 0;
      const ok = code === 0 && wroteFile;
      if (ok) {
        console.log(`[yt-cookie] Cookie refresh succeeded, wrote ${runtime.cookiesFilePath}`);
      } else {
        const trimmed = stderr.trim();
        console.error(
          `[yt-cookie] Cookie refresh failed code=${code ?? 'null'} `
          + `${trimmed ? `stderr=${trimmed}` : ''}`
        );
      }
      resolve(ok);
    });
  }).finally(() => {
    cookieRefreshPromise = null;
  });
  return cookieRefreshPromise;
}
async function runYtDlpJsonWithAutoCookieRefresh<T>(
  input: string,
  baseFlags: Flags,
  context: string
): Promise<T> {
  try {
    return await youtubeDl(input, buildYtDlpFlags(baseFlags)) as unknown as T;
  } catch (error) {
    const runtime = getYtDlpRuntimeOptions();
    if (!runtime.cookiesFromBrowser || !isYtCookieAuthError(error)) {
      throw error;
    }
    console.warn(`[yt-cookie] Auth challenge in ${context}, refreshing cookies and retrying once`);
    const refreshed = await refreshYtCookiesFromBrowser(`auth-error:${context}`, input);
    if (!refreshed) {
      throw error;
    }
    try {
      return await youtubeDl(input, buildYtDlpFlags(baseFlags, 'file')) as unknown as T;
    } catch (retryError) {
      if (isYtCookieAuthError(retryError) && runtime.cookiesFromBrowser) {
        console.warn(`[yt-cookie] File retry failed in ${context}, retrying once with browser cookies`);
        return await youtubeDl(input, buildYtDlpFlags(baseFlags, 'browser')) as unknown as T;
      }
      throw retryError;
    }
  }
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
function inlineVolumeEnabled(): boolean {
  const value = process.env.AUDIO_INLINE_VOLUME?.trim().toLowerCase();
  if (!value) return false;
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
        primed = true;
        cleanup();
        output.destroy(error);
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
  const fileName = `${guildId}-${hashForFileName(nextSong.url)}.webm`;
  const filePath = path.join(PREFETCH_DIR, fileName);
  removePrefetchFile(filePath);
  console.log(`[prefetch] Starting next-song prefetch guild=${message.guild?.name} url=${nextSong.url}`);
  const process = spawn(YTDLP_BIN, buildYtDlpSpawnArgs([
    '-f', 'bestaudio',
    '--no-warnings',
    '--no-progress',
    '-o', filePath,
    nextSong.url,
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

export async function addSongFromWeb(
  client: Client,
  guildId: string,
  url: string,
  requestedBy: string,
  options?: { resolvedTitle?: string }
): Promise<{ success: boolean; error?: string }> {
  let queue = queues.get(guildId);
  let playbackMessage: Message | null = null;
  let resolvedGuild: any = null;
  let resolvedChannelId: string | null = null;
  if (!queue) {
    const resolved = await resolveDefaultVoiceChannelForGuild(client, guildId);
    if (resolved.error || !resolved.channelId) {
      return { success: false, error: resolved.error || 'Could not resolve default voice channel.' };
    }
    resolvedGuild = resolved.guild;
    resolvedChannelId = resolved.channelId;
    playbackMessage = createWebPlaybackMessage(client, resolvedGuild, requestedBy);
  }
  try {
    let videoTitle = options?.resolvedTitle?.trim() || '';
    if (!videoTitle) {
      const fetchStartedAt = Date.now();
      console.log(`[yt-fetch] web-add guild=${guildId} begin url=${url}`);
      const flags = buildYtDlpFlags({
        dumpSingleJson: true,
        format: 'bestaudio',
        simulate: true,
      });
      const videoInfo = await runYtDlpJsonWithAutoCookieRefresh<ExtendedPayload>(
        url,
        flags,
        `web-add guild=${guildId}`
      );
      if (!videoInfo.title) {
        console.error(`[yt-fetch] web-add guild=${guildId} missing title in response`);
        return { success: false, error: 'Could not get video info' };
      }
      videoTitle = videoInfo.title;
      console.log(
        `[yt-fetch] web-add guild=${guildId} success title="${videoTitle}" in ${Date.now() - fetchStartedAt}ms`
      );
    } else {
      console.log(`[yt-fetch] web-add guild=${guildId} using provided title="${videoTitle}" url=${url}`);
    }

    if (!queue) {
      if (!playbackMessage || !resolvedChannelId) {
        return { success: false, error: 'Could not resolve web playback context.' };
      }
      console.log(
        `[web-voice] Bootstrapping queue for guild=${resolvedGuild?.name || guildId} (${guildId}) `
        + `channelId=${resolvedChannelId}`
      );
      try {
        queue = await ensureQueueAndConnection(playbackMessage, resolvedChannelId);
      } catch (error) {
        console.error('[web-voice] Failed to create queue/connection from web:', error);
        return { success: false, error: 'Could not join the default voice channel.' };
      }
    }

    const hadCurrentSongBeforeAdd = !!queue.getCurrentSong();
    queue.addSong({
      title: videoTitle,
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
      playYouTubeUrl(url, queue.getPlayer(), playbackMessage, videoTitle, true);
    }
    return { success: true };
  } catch (error) {
    console.error(`[yt-fetch] web-add guild=${guildId} failed: ${formatYtDlpError(error)}`);
    return { success: false, error: 'Failed to fetch video info' };
  }
}
export async function searchYouTubeFromWeb(
  query: string,
  limit: number = 6
): Promise<{ success: boolean; results?: WebSearchResult[]; error?: string }> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { success: false, error: 'Search query is empty' };
  }
  const cappedLimit = Math.max(1, Math.min(10, limit));
  const startedAt = Date.now();
  console.log(`[yt-search] begin query="${trimmedQuery}" limit=${cappedLimit}`);
  try {
    const flags = buildYtDlpFlags({
      dumpSingleJson: true,
      flatPlaylist: true,
      simulate: true,
    });
    const payload = await runYtDlpJsonWithAutoCookieRefresh<SearchPayload>(
      `ytsearch${cappedLimit}:${trimmedQuery}`,
      flags,
      `yt-search query=${trimmedQuery}`
    );
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const extractVideoId = (entryId: string, entryUrl?: string): string | null => {
      const rawCandidates = [entryId, entryUrl].filter((value): value is string => !!value);
      for (const raw of rawCandidates) {
        if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) {
          return raw;
        }
        if (!/^https?:\/\//.test(raw)) {
          continue;
        }
        try {
          const parsed = new URL(raw);
          const v = parsed.searchParams.get('v');
          if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) {
            return v;
          }
          if (parsed.hostname.includes('youtu.be')) {
            const shortId = parsed.pathname.split('/').filter(Boolean)[0];
            if (shortId && /^[a-zA-Z0-9_-]{11}$/.test(shortId)) {
              return shortId;
            }
          }
          const shortsMatch = parsed.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
          if (shortsMatch?.[1]) {
            return shortsMatch[1];
          }
        } catch {
          // Ignore invalid URL parse and continue.
        }
      }
      return null;
    };
    const results = entries
      .map((entry): WebSearchResult | null => {
        const id = (typeof entry.id === 'string' && entry.id) || (typeof entry.url === 'string' ? entry.url : '');
        if (!id || !entry.title) return null;
        const url = /^https?:\/\//.test(id) ? id : `https://www.youtube.com/watch?v=${id}`;
        const thumbFromArray = Array.isArray(entry.thumbnails)
          ? entry.thumbnails.find((t) => typeof t?.url === 'string')?.url || null
          : null;
        const videoId = extractVideoId(id, typeof entry.url === 'string' ? entry.url : undefined);
        const thumbnail = (typeof entry.thumbnail === 'string' && entry.thumbnail)
          || thumbFromArray
          || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);
        return {
          id,
          title: entry.title,
          url,
          duration: typeof entry.duration === 'number' ? entry.duration : null,
          channel: typeof entry.uploader === 'string' ? entry.uploader : null,
          thumbnail,
        };
      })
      .filter((item): item is WebSearchResult => item !== null);
    console.log(`[yt-search] success query="${trimmedQuery}" results=${results.length} in ${Date.now() - startedAt}ms`);
    return { success: true, results };
  } catch (error) {
    console.error(`[yt-search] failed query="${trimmedQuery}" error=${formatYtDlpError(error)}`);
    return { success: false, error: 'YouTube search failed' };
  }
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
async function getPoToken(): Promise<string> {
  try {
    const response = await fetch('http://localhost:8080/token');
    const data = await response.text();
    return data.trim();
  } catch (error) {
    console.error('Failed to fetch PO token:', error);
    throw error;
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
      const reply = await message.reply({ content, components: [controls] });
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
          await lastBotMessage.edit({ content, components: [controls] });
          return;
        }
      } catch (error) {
        console.log('Could not fetch or edit last message, sending new one');
      }
    }
    
    // Send a new message
    const newMessage = await (message.channel as any).send({ content, components: [controls] });
    lastBotMessages.set(guildId, newMessage);
    
  } catch (error) {
    console.error('Error sending/editing music message:', error);
    // Fallback to simple message
    (message.channel as any).send(content);
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
    console.log('Fetching PO token');
    
    // Check if URL is a playlist
    const isPlaylist = url.includes('playlist') || url.includes('list=');
    
    if (isPlaylist) {
      await handlePlaylist(message, url, queue, targetVoiceChannel.id);
      return;
    }
    
    // Handle single video
    const fetchStartedAt = Date.now();
    console.log(`[yt-fetch] play guild=${guildId} begin url=${url}`);
    console.log('Fetching video info with token');
    const flags = buildYtDlpFlags({
      dumpSingleJson: true,
      format: 'bestaudio',
      simulate: true,    // Don't download, just simulate
    });
    const videoInfo = await runYtDlpJsonWithAutoCookieRefresh<ExtendedPayload>(
      url,
      flags,
      `play guild=${guildId}`
    );
    console.log(
      `[yt-fetch] play guild=${guildId} success title="${videoInfo.title || 'unknown'}" `
      + `requestedDownloads=${videoInfo.requested_downloads?.length ?? 0} in ${Date.now() - fetchStartedAt}ms`
    );
    if (!videoInfo.requested_downloads?.[0]?.url) {
      console.error(`[yt-fetch] play guild=${guildId} missing requested_downloads url`);
      throw new Error('No audio URL found');
    }
    const isFirstSong = !queue;
    
    if (!queue) {
      queue = await ensureQueueAndConnection(message, targetVoiceChannel.id);
    }
    console.log('Adding song to queue:', videoInfo.title);
    
    // Store the original YouTube URL instead of the direct audio URL
    // We'll get a fresh audio URL when we actually play it
    const queueItem = {
      title: videoInfo.title,
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
      await sendOrEditMusicMessage(message, `Added to queue: ${videoInfo.title}`);
    }
  } catch (error) {
    console.error(`[yt-fetch] play guild=${guildId} failed: ${formatYtDlpError(error)}`);
    console.error('Play command error:', error);
    message.reply('Error playing the video!');
  }
}
async function handlePlaylist(message: Message, url: string, existingQueue?: MusicQueue, channelId?: string) {
  try {
    message.reply('Processing playlist. This may take a moment...');
    
    // Get playlist info
    const playlistFetchStartedAt = Date.now();
    console.log(`[yt-fetch] playlist begin url=${url}`);
    const playlistFlags = buildYtDlpFlags({
      dumpSingleJson: true,
      flatPlaylist: true,
      simulate: true,    // Don't download, just get info
    });
    
    const playlistInfo = await runYtDlpJsonWithAutoCookieRefresh<any>(
      url,
      playlistFlags,
      `playlist url=${url}`
    );
    console.log(
      `[yt-fetch] playlist success url=${url} entries=${Array.isArray(playlistInfo?.entries) ? playlistInfo.entries.length : 0} `
      + `in ${Date.now() - playlistFetchStartedAt}ms`
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
      queue = await ensureQueueAndConnection(message, targetChannelId);
    }
    
    // Process each video in the playlist
    let addedCount = 0;
    const totalVideos = entries.length;
    
    message.reply(`Found ${totalVideos} videos in the playlist. Adding to queue...`);
    
    // Add YouTube URLs to queue (we'll get fresh audio URLs when playing)
    for (const entry of entries) {
      try {
        const entryFetchStartedAt = Date.now();
        console.log(`[yt-fetch] playlist-entry begin url=${entry.url}`);
        // Just get the title, store the YouTube URL for later
        const videoFlags = buildYtDlpFlags({
          dumpSingleJson: true,
          simulate: true,
        });
        
        const videoInfo = await runYtDlpJsonWithAutoCookieRefresh<ExtendedPayload>(
          entry.url,
          videoFlags,
          `playlist-entry url=${entry.url}`
        );
        console.log(
          `[yt-fetch] playlist-entry success url=${entry.url} title="${videoInfo.title || 'unknown'}" `
          + `in ${Date.now() - entryFetchStartedAt}ms`
        );
        
        if (videoInfo.title) {
          const queueItem = {
            title: videoInfo.title,
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
        }
      } catch (error) {
        console.error(`[yt-fetch] playlist-entry failed url=${entry.url} error=${formatYtDlpError(error)}`);
        console.error(`Error processing playlist video ${entry.url}:`, error);
        // Continue with next video even if one fails
      }
    }
    requestNextSongPrefetch(message);
    
    message.reply(`Successfully added ${addedCount} out of ${totalVideos} videos from the playlist to the queue.`);
    
  } catch (error) {
    console.error(`[yt-fetch] playlist failed url=${url} error=${formatYtDlpError(error)}`);
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
    guildId: guildId,
    adapterCreator: message.guild!.voiceAdapterCreator as DiscordGatewayAdapterCreator,
  });
  connection.on('stateChange', (oldState, newState) => {
    console.log(
      `[voice] Connection state guild=${message.guild?.name} channel=${voiceChannelLabel(message, channelId)} `
      + `${oldState.status} -> ${newState.status}`
    );
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      const disconnectedState = newState as unknown as { reason?: unknown; closeCode?: unknown };
      console.warn(
        `[voice] Disconnected details guild=${message.guild?.name} `
        + `reason=${voiceDisconnectReasonLabel(disconnectedState.reason)} `
        + `closeCode=${disconnectedState.closeCode !== undefined ? String(disconnectedState.closeCode) : 'n/a'} `
        + `${queueStateSnapshot(guildId)}`
      );
    }
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
      `[voice] Connection disconnected guild=${message.guild?.name}, attempting reconnect `
      + `within ${reconnectWindowMs}ms reason=${voiceDisconnectReasonLabel(reason)} `
      + `closeCode=${closeCode ?? 'n/a'} maxAttempts=${maxAttempts} `
      + `| ${queueStateSnapshot(guildId)}`
    );

    // 4014 means Discord told us to disconnect (channel move/kick/etc). Give it one connect window.
    if (reason === VoiceConnectionDisconnectReason.WebSocketClose && closeCode === 4014) {
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, reconnectWindowMs);
        console.log(`[voice] 4014 disconnect transitioned to connecting guild=${message.guild?.name}`);
        return;
      } catch (error) {
        console.warn(`[voice] 4014 reconnect window expired guild=${message.guild?.name}`, error);
      }
    }

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (connection.state.status === VoiceConnectionStatus.Destroyed) {
          console.warn(`[voice] Connection already destroyed before rejoin attempt guild=${message.guild?.name}`);
          return;
        }

        const accepted = connection.rejoin();
        console.warn(
          `[voice] Rejoin attempt guild=${message.guild?.name} attempt=${attempt}/${maxAttempts} `
          + `accepted=${accepted} internalAttempts=${connection.rejoinAttempts} `
          + `state=${connection.state.status}`
        );

        if (!accepted) {
          await waitMs(Math.min(backoffBaseMs * attempt, 10_000));
          continue;
        }

        try {
          await entersState(connection, VoiceConnectionStatus.Ready, reconnectWindowMs);
          console.log(`[voice] Rejoin succeeded guild=${message.guild?.name} after attempt=${attempt}`);
          return;
        } catch (error) {
          console.warn(
            `[voice] Rejoin attempt failed guild=${message.guild?.name} attempt=${attempt} `
            + `state=${connection.state.status}`,
            error
          );
          await waitMs(Math.min(backoffBaseMs * attempt, 10_000));
        }
      }
    } catch (error) {
      console.error(`[voice] Unexpected reconnect handler error guild=${message.guild?.name}`, error);
    }

    console.error(
      `[voice] Reconnect exhausted guild=${message.guild?.name} connectionState=${connection.state.status} `
      + `| ${queueStateSnapshot(guildId)}`
    );
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      console.log('Voice connection reconnect failed, destroying connection');
      connection.destroy();
    }
    if (queues.has(guildId)) {
      queues.delete(guildId);
      hasRepliedToPlay.delete(guildId);
      lastBotMessages.delete(guildId);
      clearStartupTrace(guildId);
      clearNextSongPrefetch(guildId);
      console.log(`Cleaned up queue and tracking for guild: ${guildId}`);
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
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        connection.destroy();
      } catch (destroyError) {
        console.warn('[voice] Ignored destroy failure after readiness timeout:', destroyError);
      }
    }
    if (queues.get(guildId) === queue) {
      queues.delete(guildId);
    }
    clearStartupTrace(guildId);
    clearNextSongPrefetch(guildId);
    hasRepliedToPlay.delete(guildId);
    lastBotMessages.delete(guildId);
    throw error;
  }
  player.on(AudioPlayerStatus.Idle, () => {
    console.log(`[voice] Audio player entered idle guild=${message.guild?.name} | ${queueStateSnapshot(guildId)}`);
    const nextSong = queue.getNextSong();
    if (nextSong) {
      console.log(`[voice] Advancing to next song guild=${message.guild?.name} title="${nextSong.title}"`);
      playYouTubeUrl(nextSong.url, queue.getPlayer(), message, nextSong.title);
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
function createFfmpegStream(url: string): Readable {
  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-headers', 'Accept: */*',
    '-headers', 'Accept-Language: en-US,en;q=0.9',
    '-headers', 'Accept-Encoding: identity',
    '-headers', 'Range: bytes=0-',
    '-headers', 'Connection: keep-alive',
    '-headers', 'Sec-Fetch-Dest: video',
    '-headers', 'Sec-Fetch-Mode: no-cors',
    '-headers', 'Sec-Fetch-Site: cross-site',
    '-i', url,
    '-analyzeduration', '0',
    '-probesize', '32768',        // Minimize probe size to reduce memory usage
    '-loglevel', ffmpegLogLevel(),
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-acodec', 'pcm_s16le',
    '-bufsize', '64k',         // Small buffer size to reduce memory usage
    'pipe:1'
  ]);
  wireFfmpegDiagnostics(ffmpeg, 'direct-url');
  // Handle process errors
  ffmpeg.on('error', error => {
    console.error('FFmpeg process error:', error);
  });
  // Handle stdout errors
  const stdout = ffmpeg.stdout;
  stdout.on('error', error => {
    console.error('FFmpeg stdout error:', error);
  });
  return stdout;
}
function createYouTubeStream(youtubeUrl: string): Readable {
  // Pipe yt-dlp audio output directly into FFmpeg to avoid URL expiry/403 issues
  console.log('Piping yt-dlp -> ffmpeg for:', youtubeUrl);
  const ytdlp = spawn(YTDLP_BIN, buildYtDlpSpawnArgs([
    '-f', 'bestaudio',
    '-o', '-',
    '--quiet',
    '--no-warnings',
    '--no-progress',
    youtubeUrl
  ]));
  const ffmpeg = spawn('ffmpeg', [
    // Pace decode in real-time to avoid burst-decoding entire tracks into memory.
    // This reduces large initial CPU/memory spikes that can surface as playback hiccups.
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
  let ytdlpStdoutBytes = 0;
  ytdlp.stdout.on('data', (chunk: Buffer) => {
    ytdlpStdoutBytes += chunk.length;
  });
  ytdlp.stdout.pipe(ffmpeg.stdin, { end: true });
  ffmpeg.stdin.on('error', (error) => {
    logStreamIssue('FFmpeg stdin error', error);
  });
  let ytdlpExited = false;
  let ffmpegExited = false;
  let sawCookieAuthError = false;
  const ytdlpStatsEnabled = ffmpegVerboseLogsEnabled();
  const ytdlpStatsIntervalMs = ffmpegStatsIntervalMs();
  let ytdlpLastStatsBytes = 0;
  let ytdlpStatsTimer: ReturnType<typeof setInterval> | null = null;
  if (ytdlpStatsEnabled) {
    const ytdlpStartedAt = Date.now();
    ytdlpStatsTimer = setInterval(() => {
      const delta = ytdlpStdoutBytes - ytdlpLastStatsBytes;
      ytdlpLastStatsBytes = ytdlpStdoutBytes;
      const rateBps = Math.round(delta / (ytdlpStatsIntervalMs / 1000));
      console.log(
        `[yt-dlp][stream] +${Date.now() - ytdlpStartedAt}ms stats bytes=${ytdlpStdoutBytes} rateBps=${rateBps}`
      );
    }, ytdlpStatsIntervalMs);
  }
  ytdlp.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (!line) return;
    if (isYtCookieAuthErrorText(line)) {
      sawCookieAuthError = true;
    }
    const lowered = line.toLowerCase();
    if (ytdlpVerboseLogsEnabled()) {
      console.log('yt-dlp:', line);
      return;
    }
    if (lowered.includes('error') || lowered.includes('warning')) {
      console.warn('yt-dlp:', line);
    }
  });
  ytdlp.on('error', error => {
    console.error('yt-dlp process error:', error);
  });
  ytdlp.on('exit', (code) => {
    if (ytdlpStatsTimer) {
      clearInterval(ytdlpStatsTimer);
      ytdlpStatsTimer = null;
    }
    ytdlpExited = true;
    if (code !== 0) console.log(`yt-dlp exited with code ${code}`);
    if (code !== 0 && !ffmpegExited) {
      if (sawCookieAuthError) {
        void refreshYtCookiesFromBrowser('stream-auth-error', youtubeUrl);
        return;
      }
      if (ytdlpStdoutBytes === 0) {
        console.warn(`[yt-cookie] stream exited with code=${code} and no audio bytes, forcing cookie refresh`);
        void refreshYtCookiesFromBrowser('stream-zero-bytes-exit', youtubeUrl);
      }
    }
  });
  ffmpeg.on('error', error => {
    console.error('FFmpeg process error:', error);
  });
  ffmpeg.on('exit', (code) => {
    ffmpegExited = true;
    if (code !== 0) console.log(`FFmpeg exited with code ${code}`);
    if (ytdlpStatsTimer) {
      clearInterval(ytdlpStatsTimer);
      ytdlpStatsTimer = null;
    }
  });
  wireFfmpegDiagnostics(ffmpeg, `yt-pipe:${youtubeUrl}`);
  ffmpeg.stdout.on('error', error => {
    logStreamIssue('FFmpeg stdout error', error);
  });
  // Clean up: if FFmpeg dies first, stop yt-dlp.
  // Do not call ffmpeg.stdin.end() on yt-dlp exit: stdout is already piped
  // with { end: true }, and ending stdin early can truncate trailing audio.
  ffmpeg.on('exit', () => {
    if (!ytdlpExited && ytdlp.exitCode === null) {
      ytdlp.kill();
    }
  });
  // Pipe through a PassThrough stream so that buffered PCM data survives
  // after FFmpeg exits (Node.js destroys child process stdio on exit)
  const passthrough = new PassThrough();
  ffmpeg.stdout.pipe(passthrough);
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
  ffmpeg.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[prefetch] FFmpeg exited with code ${code} for prefetched file ${path.basename(filePath)}`);
    }
    removePrefetchFile(filePath);
  });
  const passthrough = new PassThrough();
  ffmpeg.stdout.pipe(passthrough);
  return passthrough;
}
async function playPrefetchedSong(
  prefetched: NextSongPrefetch,
  player: AudioPlayer,
  message: Message,
  title: string,
  isFirstSong: boolean = false
) {
  try {
    const trace = beginStartupTrace(message, title, prefetched.url, 'prefetched');
    console.log(`[prefetch] Playing prefetched file guild=${message.guild?.name} title="${title}"`);
    const baseStream = createPrefetchedFileStream(prefetched.filePath);
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
        if (!trace) return;
        trace.primeReadyAt = Date.now();
        trace.primeBytes = bytes;
        trace.primeReason = reason;
        logStartupTrace(trace, 'prime-ready', `bytes=${bytes}, reason=${reason}`);
      },
    });
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
    const trace = beginStartupTrace(message, title, youtubeUrl, 'live');
    console.log('Streaming directly from YouTube URL with FFmpeg:', youtubeUrl);
    const baseStream = createYouTubeStream(youtubeUrl);
    baseStream.once('data', (chunk) => {
      if (!trace || trace.baseFirstChunkAt) return;
      trace.baseFirstChunkAt = Date.now();
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      logStartupTrace(trace, 'base-first-chunk', `bytes=${size}`);
    });
    // Add error handling for the stream
    baseStream.on('error', (error: Error & { code?: string }) => {
      logStreamIssue('YouTube stream issue', error);
    });
    const stream = await primePcmStream(baseStream, title, {
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
async function playYouTubeUrl(youtubeUrl: string, player: AudioPlayer, message: Message, title: string, isFirstSong: boolean = false) {
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
    
    // Try streaming directly from YouTube URL using youtube-dl in FFmpeg
    await playYouTubeUrlDirect(youtubeUrl, player, message, title, isFirstSong);
    
  } catch (error) {
    console.error('Error streaming YouTube URL:', error);
    message.reply('Error streaming from YouTube');
  }
}
async function playSong(url: string, player: AudioPlayer, message: Message, title: string, isFirstSong: boolean = false) {
  try {
    console.log('Creating FFmpeg stream for URL:', url);
    console.log('URL length:', url.length);
    console.log('URL starts with:', url.substring(0, 100));
    console.log('FFmpeg starting at timestamp:', Date.now());
    
    const stream = createFfmpegStream(url);
    
    // Add error handling for the stream
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
      resource.volume?.setVolume(0.5); // Set volume to 50% to avoid distortion
    }
    player.play(resource);
    
    await sendOrEditMusicMessage(message, `Now playing: ${title}`, isFirstSong);
  } catch (error) {
    console.error('Error in playSong:', error);
    message.reply('Error playing the audio');
  }
}
export function handlePause(message: Message) {
  const queue = queues.get(message.guild!.id);
  if (!queue) {
    message.reply('No music is playing!');
    return;
  }
  if (queue.pause()) {
    message.reply('Paused the music!');
  } else {
    message.reply('The music is already paused!');
  }
}
export function handleResume(message: Message) {
  const queue = queues.get(message.guild!.id);
  if (!queue) {
    message.reply('No music is queued!');
    return;
  }
  if (queue.resume()) {
    message.reply('Resumed the music!');
  } else {
    message.reply('The music is already playing!');
  }
}
export function handleSkip(message: Message) {
  const queue = queues.get(message.guild!.id);
  if (!queue) {
    message.reply('No music is playing!');
    return;
  }
  queue.skip();
  message.reply('Skipped the current song!');
}
export function handleQueue(message: Message) {
  const queue = queues.get(message.guild!.id);
  if (!queue) {
    message.reply('No music is queued!');
    return;
  }
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
  message.reply(response);
}
export function handleHelp(message: Message) {
  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle('🎵 Music Bot Commands')
    .setDescription('Here are all the available commands:')
    .addFields(
      { name: '/play url:<youtube_url>', value: 'Play a YouTube video or playlist', inline: false },
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
  if (!message.member?.permissions.has('Administrator')) {
    message.reply('You need administrator permissions to use this command!');
    return;
  }
  try {
    message.reply('Running cleanup...');
    checkAndLeaveIfNeeded(message.client);
    message.reply('Cleanup completed! Check console for details.');
  } catch (error) {
    console.error('Cleanup command error:', error);
    message.reply('Error during cleanup!');
  }
}
export function handleNukkumaan(message: Message) {
  if (!message.member?.permissions.has('Administrator')) {
    message.reply('You need administrator permissions to use this command!');
    return;
  }
  try {
    // Check all guilds where the bot is in voice channels
    message.client.guilds.cache.forEach(guild => {
      const queue = queues.get(guild.id);
      if (queue) {
        // Stop the player and clear the queue
        const player = queue.getPlayer();
        player.stop();
        queues.delete(guild.id);
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
        }
        me.voice.disconnect();
        console.log(`Left voice channel in guild: ${guild.name}`);
      }
      
      // Reset tracking for this guild
      hasRepliedToPlay.delete(guild.id);
      lastBotMessages.delete(guild.id);
    });
    message.reply('Bot has been reset and disconnected from all voice channels!');
  } catch (error) {
    console.error('Reset command error:', error);
    message.reply('Error during reset!');
  }
}
function checkAndLeaveChannel(guildId: string, client: Client): boolean {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.log(`Guild ${guildId} not found, cleaning up...`);
    const hadTracking = hasGuildTrackingState(guildId);
    // Clean up even if guild not found
    if (queues.has(guildId)) {
      queues.delete(guildId);
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
    // Clean up if not in voice channel
    if (queues.has(guildId)) {
      queues.delete(guildId);
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
  if (shouldLeaveBecauseAlone || shouldLeaveBecauseNoPlayback) {
    const leaveReason = shouldLeaveBecauseAlone ? 'alone' : 'no music playing';
    console.log(`[voice-cleanup] Leaving voice channel in ${guild.name}: ${leaveReason}`);
    
    if (connection) {
      try {
        connection.destroy();
        console.log(`[voice-cleanup] Destroyed voice connection for ${guild.name}`);
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
      queues.delete(guildId);
    }
    clearStartupTrace(guildId);
    clearNextSongPrefetch(guildId);
    
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
