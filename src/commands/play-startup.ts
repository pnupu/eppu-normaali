import { Message } from 'discord.js';
import { StartupSource, StartupTrace } from './play-types';

const startupTraces = new Map<string, StartupTrace>();
let startupTraceIdCounter = 0;

function startupDebugEnabled(): boolean {
  const value = process.env.PLAYBACK_STARTUP_DEBUG?.trim().toLowerCase();
  if (!value) return true;
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}

export function beginStartupTrace(
  message: Message,
  title: string,
  url: string,
  source: StartupSource
): StartupTrace | null {
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

export function getStartupTrace(guildId: string): StartupTrace | undefined {
  return startupTraces.get(guildId);
}

export function logStartupTrace(trace: StartupTrace | null | undefined, event: string, details?: string): void {
  if (!trace) return;
  const elapsed = Date.now() - trace.startedAt;
  console.log(
    `[startup][${trace.guildName}#${trace.id}] +${elapsed}ms ${event}${details ? ` | ${details}` : ''}`
  );
}

export function clearStartupTrace(guildId: string): void {
  startupTraces.delete(guildId);
}
