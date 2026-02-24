import { MusicQueue } from '../music/queue';

export const queues = new Map<string, MusicQueue>();

const guildVolumes = new Map<string, number>();

export function getVolume(guildId: string): number {
  return guildVolumes.get(guildId) ?? 50;
}

export function setVolume(guildId: string, volume: number): void {
  guildVolumes.set(guildId, Math.max(0, Math.min(100, volume)));
}
