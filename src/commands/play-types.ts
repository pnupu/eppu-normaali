import { ChildProcessWithoutNullStreams } from 'child_process';

export interface ExtendedRequestedDownload {
  url: string;
}

export interface ExtendedPayload {
  title: string;
  requested_downloads?: ExtendedRequestedDownload[];
}

export interface PlaylistEntry {
  title: string;
  url: string;
  id: string;
}

export interface SearchEntry {
  id?: string;
  title?: string;
  url?: string;
  duration?: number;
  uploader?: string;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string }>;
}

export interface SearchPayload {
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

export interface NextSongPrefetch {
  guildId: string;
  url: string;
  title: string;
  filePath: string;
  ready: boolean;
  process: ChildProcessWithoutNullStreams | null;
}

export type StartupSource = 'live' | 'prefetched';

export interface StartupTrace {
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

export interface PrimeHooks {
  onFirstChunk?: (bytes: number) => void;
  onPrimed?: (bytes: number, reason: 'bytes' | 'timeout' | 'eof') => void;
}
