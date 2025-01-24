// src/music/queue.ts
import { AudioPlayer, AudioResource } from '@discordjs/voice';

interface QueueItem {
  title: string;
  url: string;
  requestedBy: string;
}

export class MusicQueue {
  private queue: QueueItem[] = [];
  private currentSong: QueueItem | null = null;
  private player: AudioPlayer;
  private isPaused = false;

  constructor(player: AudioPlayer) {
    this.player = player;
  }

  addSong(song: QueueItem) {
    this.queue.push(song);
  }

  getCurrentSong(): QueueItem | null {
    return this.currentSong;
  }

  getNextSong(): QueueItem | null {
    if (this.queue.length === 0) return null;
    this.currentSong = this.queue.shift() || null;
    return this.currentSong;
  }

  pause() {
    if (!this.isPaused) {
      this.player.pause();
      this.isPaused = true;
      return true;
    }
    return false;
  }

  resume() {
    if (this.isPaused) {
      this.player.unpause();
      this.isPaused = false;
      return true;
    }
    return false;
  }

  skip() {
    this.player.stop();
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
}