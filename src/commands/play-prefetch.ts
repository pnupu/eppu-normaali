import { Message } from 'discord.js';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';
import { createHash } from 'crypto';
import { NextSongPrefetch } from './play-types';
import { queues } from './play-state';

const PREFETCH_DIR = path.join(__dirname, '../../tmp/prefetch');
const YTDLP_BIN = path.join(__dirname, '../../node_modules/youtube-dl-exec/bin/yt-dlp');
const nextSongPrefetches = new Map<string, NextSongPrefetch>();
const prefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const songStartTimes = new Map<string, number>();

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

export function removePrefetchFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('[prefetch] Failed to remove file:', filePath, error);
  }
}

function clearPrefetchTimer(guildId: string): void {
  const timer = prefetchTimers.get(guildId);
  if (!timer) return;
  clearTimeout(timer);
  prefetchTimers.delete(guildId);
}

export function clearNextSongPrefetch(guildId: string, keepFile = false): void {
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

export function markSongStarted(message: Message): void {
  const guildId = message.guild?.id;
  if (!guildId) return;
  songStartTimes.set(guildId, Date.now());
}

export function takeReadyPrefetch(guildId: string, url: string): NextSongPrefetch | null {
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
  const process = spawn(YTDLP_BIN, [
    '-f', 'bestaudio',
    '--no-warnings',
    '--no-progress',
    '-o', filePath,
    nextSong.url,
  ]);

  const state: NextSongPrefetch = {
    guildId,
    url: nextSong.url,
    title: nextSong.title,
    filePath,
    ready: false,
    process,
  };
  nextSongPrefetches.set(guildId, state);

  process.on('error', (error) => {
    console.error(`[prefetch] yt-dlp prefetch process error guild=${message.guild?.name}:`, error);
    clearNextSongPrefetch(guildId);
  });

  process.stderr.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (!line) return;
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

    console.log(`[prefetch] Failed guild=${message.guild?.name} code=${code ?? 'null'} title="${nextSong.title}"`);
    clearNextSongPrefetch(guildId);
  });
}

export function requestNextSongPrefetch(message: Message): void {
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
