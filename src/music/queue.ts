// src/music/queue.ts
import { AudioPlayer } from '@discordjs/voice';
import type { Track } from './sources';

export interface QueueItem extends Track {
  requestedBy: string;
}

export class MusicQueue {
  private queue: QueueItem[] = [];
  private currentSong: QueueItem | null = null;
  private player: AudioPlayer;
  /** Skip pressed before the current song's audio started (the player was still idle). */
  private skipPending = false;

  constructor(player: AudioPlayer) {
    this.player = player;
  }

  addSong(song: QueueItem) {
    this.queue.push(song);
    // If there's no current song, this is the first song
    if (!this.currentSong) {
      this.currentSong = this.queue.shift() || null;
    }
  }

  getCurrentSong(): QueueItem | null {
    return this.currentSong;
  }

  getNextSong(): QueueItem | null {
    // Set current song to the next in queue
    this.currentSong = this.queue.shift() || null;
    this.skipPending = false;
    return this.currentSong;
  }

  // Pause state comes from the player itself, so it can't drift when a new track starts.
  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  skip() {
    if (this.player.state.status === 'idle' && this.currentSong) {
      this.skipPending = true;
      return;
    }
    this.player.stop();
  }

  consumePendingSkip(): boolean {
    const pending = this.skipPending;
    this.skipPending = false;
    return pending;
  }

  clear() {
    this.queue = [];
    this.currentSong = null;
    this.player.stop();
  }

  getQueue(): QueueItem[] {
    return [...this.queue];
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }

  hasNextSong(): boolean {
    return this.queue.length > 0;
  }

  isIdle(): boolean {
    return this.player.state.status === 'idle';
  }

  isPausedState(): boolean {
    return this.player.state.status === 'paused';
  }

  removeSong(index: number): boolean {
    if (index < 0 || index >= this.queue.length) return false;
    this.queue.splice(index, 1);
    return true;
  }

  moveSong(from: number, to: number): boolean {
    if (from < 0 || from >= this.queue.length || to < 0 || to >= this.queue.length) return false;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, item);
    return true;
  }
}