export type TrackSource = 'youtube' | 'soundcloud' | 'spotify';
export type SearchSource = 'youtube' | 'soundcloud';

export interface Track {
  source: TrackSource;
  key: string;
  title: string;
  url: string;
  duration: number | null;
  thumbnail: string | null;
}

export interface QueueSong extends Track {
  requestedBy: string;
}

export interface GuildPlaybackState {
  guildName: string;
  currentSong: QueueSong | null;
  queue: QueueSong[];
  paused: boolean;
  volume: number;
  positionMs: number | null;
}

export type PlaybackStateMap = Record<string, GuildPlaybackState>;

export interface PlaylistSummary {
  id: string;
  name: string;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  songCount: number;
}

export interface PlaylistSong extends Track {
  id: string;
  playlistId: string;
  position: number;
  addedBy: string;
  addedAt: number;
}

export interface PlaylistDetail extends PlaylistSummary {
  songs: PlaylistSong[];
  songNextCursor: string | null;
}

export interface BulkResult {
  added: number;
  skippedDuplicates: number;
  failed: number;
}

export interface EnqueueResponse {
  ok: true;
  added: number;
  skipped: number;
  name: string | null;
  firstTitle: string | null;
}

export interface WebConfig {
  authRequired?: boolean;
  localMode?: boolean;
  exposureMode?: string;
  requireAccessToken?: boolean;
  defaultGuildId?: string | null;
}

export type ToastMood = 'happy' | 'stern' | 'neutral';
