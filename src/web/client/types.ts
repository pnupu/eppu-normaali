export interface QueueSong {
  title: string;
  url: string;
  requestedBy: string;
}

export interface GuildPlaybackState {
  guildName: string;
  currentSong: QueueSong | null;
  queue: QueueSong[];
  paused: boolean;
  volume: number;
}

export type PlaybackStateMap = Record<string, GuildPlaybackState>;

export interface WebSearchResult {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  channel: string | null;
  thumbnail: string | null;
}

export interface WebConfig {
  authRequired?: boolean;
  localMode?: boolean;
  exposureMode?: string;
  requireAccessToken?: boolean;
  defaultGuildId?: string | null;
}

export interface AuthProfile {
  email?: string | null;
  name?: string | null;
  isAdmin?: boolean;
  localMode?: boolean;
}

export interface ApiResult {
  ok?: boolean;
  error?: string;
  paused?: boolean;
}

export type StatusTone = 'info' | 'ok' | 'error';
export type ToastMood = 'happy' | 'stern' | 'neutral';
export type PollBadgeState = 'syncing' | 'ready' | 'live' | 'degraded';
