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

export interface PlaylistSummary {
  id: string;
  name: string;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  songCount: number;
}

export interface PlaylistSong {
  id: string;
  playlistId: string;
  position: number;
  title: string;
  url: string;
  canonicalVideoId: string;
  addedBy: string;
  addedAt: number;
}

export interface PlaylistDetail extends PlaylistSummary {
  songs: PlaylistSong[];
  songNextCursor: string | null;
}

export interface PlaylistOperationResult {
  added: number;
  skippedDuplicates: number;
  failed: number;
}

export interface PlaylistListResponse {
  ok?: boolean;
  items?: PlaylistSummary[];
  nextCursor?: string | null;
  error?: string;
}

export interface PlaylistDetailResponse {
  ok?: boolean;
  playlist?: PlaylistDetail;
  error?: string;
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

export interface VoiceCommandResponse extends ApiResult {
  message?: string;
  intent?: string;
  queuedTitle?: string;
  resolvedUrl?: string;
  transcript?: string;
}

export interface VoiceKeyword {
  phrase: string;
  url: string;
  canonicalVideoId: string;
  updatedBy: string;
  updatedAt: number;
  createdAt: number;
}

export interface VoiceKeywordListResponse {
  ok?: boolean;
  items?: VoiceKeyword[];
  nextCursor?: string | null;
  error?: string;
}

export type StatusTone = 'info' | 'ok' | 'error';
export type ToastMood = 'happy' | 'stern' | 'neutral';
export type PollBadgeState = 'syncing' | 'ready' | 'live' | 'degraded';
