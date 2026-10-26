import {
  DiscordGatewayAdapterCreator,
  EndBehaviorType,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import { Client } from 'discord.js';
import OpenAI, { fileFromPath } from 'openai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream';
import prism from 'prism-media';
import { startVoiceWorker, transcribeLocal, wakeScore } from './voiceWorker';
import { ensureVoiceConnectionRecovery } from '../commands/play';
import { transcriptContainsWakePhrase } from './commandExecutor';

interface VoiceCommandContext {
  guildId: string;
  userId: string;
  transcript: string;
}

type VoiceCommandHandler = (context: VoiceCommandContext) => Promise<void>;

interface SegmentAudio {
  pcm16k: Buffer<ArrayBufferLike>;
  durationMs: number;
  truncated: boolean;
}

type WakeEngine = 'openwakeword' | 'transcript';
type SttEngine = 'local' | 'openai';

class Pcm48StereoTo16Mono {
  private carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  convert(chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
    const combined = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const inputFrameBytes = 4;
    const inputFramesPerOutput = 3;
    const bytesPerOutput = inputFrameBytes * inputFramesPerOutput;
    const outputSamples = Math.floor(combined.length / bytesPerOutput);
    if (outputSamples <= 0) {
      this.carry = combined;
      return Buffer.alloc(0);
    }

    const output = Buffer.allocUnsafe(outputSamples * 2);
    for (let out = 0; out < outputSamples; out += 1) {
      const base = out * bytesPerOutput;
      let sum = 0;
      for (let frame = 0; frame < inputFramesPerOutput; frame += 1) {
        const frameBase = base + frame * inputFrameBytes;
        sum += combined.readInt16LE(frameBase);
        sum += combined.readInt16LE(frameBase + 2);
      }
      const sample = Math.max(-32768, Math.min(32767, Math.round(sum / (inputFramesPerOutput * 2))));
      output.writeInt16LE(sample, out * 2);
    }

    this.carry = combined.subarray(outputSamples * bytesPerOutput);
    return output;
  }
}

let commandHandler: VoiceCommandHandler | null = null;
const activeConnections = new WeakSet<VoiceConnection>();
const userCooldowns = new Map<string, number>();
const activeSegments = new Set<string>();

function envBool(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function envNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(value || '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  return Math.round(envNumber(value, fallback, min, max));
}

function quoteForLog(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function voiceCommandsEnabled(): boolean {
  return envBool(process.env.VOICE_COMMANDS_ENABLED, false);
}

/**
 * 'openwakeword' scores segments with a trained "Hei Eppu" model and only
 * transcribes after a wake hit. 'transcript' transcribes every segment locally
 * and looks for the wake phrase in the text — heavier, but needs no trained
 * model. Defaults to 'openwakeword' when a model path is configured.
 */
function wakeEngine(): WakeEngine {
  const configured = process.env.VOICE_WAKE_ENGINE?.trim().toLowerCase();
  if (configured === 'transcript') return 'transcript';
  if (configured === 'openwakeword') return 'openwakeword';
  return openWakeWordModelPath() ? 'openwakeword' : 'transcript';
}

function sttEngine(): SttEngine {
  return process.env.VOICE_STT_ENGINE?.trim().toLowerCase() === 'openai' ? 'openai' : 'local';
}

function sampleCollectionEnabled(): boolean {
  return envBool(process.env.VOICE_SAMPLE_COLLECTION_ENABLED, false);
}

export function isDiscordVoiceListener(connection: VoiceConnection): boolean {
  return activeConnections.has(connection)
    && (voiceCommandsEnabled() || (sampleCollectionEnabled() && !!sampleCollectionDir()));
}

function sampleCollectionDir(): string | null {
  const configured = process.env.VOICE_SAMPLE_COLLECTION_DIR?.trim();
  if (!configured) return null;
  return path.resolve(configured);
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96);
}

function openWakeWordModelPath(): string | null {
  const configured = process.env.OPENWAKEWORD_MODEL_PATH?.trim();
  if (!configured) return null;
  return path.resolve(configured);
}

function writeWavFromPcm16kMono(filePath: string, pcm: Buffer<ArrayBufferLike>): Promise<void> {
  const header = Buffer.alloc(44);
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return fs.promises.writeFile(filePath, Buffer.concat([header, pcm]));
}

async function transcribeWithOpenAI(audioPath: string, prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error('OPENAI_API_KEY is required when VOICE_STT_ENGINE=openai');
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.VOICE_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-mini-transcribe';
  const transcription = await openai.audio.transcriptions.create({
    file: await fileFromPath(audioPath),
    model,
    language: process.env.VOICE_LANGUAGE?.trim() || 'fi',
    prompt,
  });
  return typeof transcription.text === 'string' ? transcription.text.trim() : '';
}

async function transcribeSegment(audioPath: string): Promise<string> {
  const prompt = process.env.VOICE_TRANSCRIPTION_PROMPT?.trim()
    || 'Hei Eppu, soita 22. Hei Eppu, ohita. Hei Eppu, tauko. Hei Eppu, jatka. Hei Eppu, soita Eppu Normaali.';
  if (sttEngine() === 'openai') {
    return transcribeWithOpenAI(audioPath, prompt);
  }
  const language = process.env.VOICE_LANGUAGE?.trim() || 'fi';
  return transcribeLocal(audioPath, language, prompt);
}

function shouldIgnoreUser(userId: string, botUserId?: string): boolean {
  if (botUserId && userId === botUserId) return true;
  const ignored = (process.env.VOICE_IGNORE_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ignored.includes(userId);
}

function isInCooldown(guildId: string, userId: string): boolean {
  const key = `${guildId}:${userId}`;
  const until = userCooldowns.get(key) || 0;
  return until > Date.now();
}

function markCooldown(guildId: string, userId: string, cooldownMs: number): void {
  if (cooldownMs <= 0) return;
  userCooldowns.set(`${guildId}:${userId}`, Date.now() + cooldownMs);
}

function collectDiscordAudioSegment(
  connection: VoiceConnection,
  userId: string,
  silenceMs: number,
  maxSeconds: number
): Promise<SegmentAudio> {
  return new Promise((resolve, reject) => {
    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: silenceMs,
      },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const converter = new Pcm48StereoTo16Mono();
    const chunks: Buffer[] = [];
    const maxBytes = Math.max(1, Math.round(maxSeconds * 16000 * 2));
    let totalBytes = 0;
    let truncated = false;
    let settled = false;

    function settle(error?: Error) {
      if (settled) return;
      settled = true;
      opusStream.destroy();
      decoder.destroy();
      if (error) {
        reject(error);
        return;
      }
      const pcm16k = Buffer.concat(chunks, totalBytes);
      resolve({
        pcm16k,
        durationMs: Math.round(totalBytes / 2 / 16000 * 1000),
        truncated,
      });
    }

    decoder.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const converted = converter.convert(chunk);
      if (!converted.length) return;
      const remaining = maxBytes - totalBytes;
      if (converted.length >= remaining) {
        chunks.push(converted.subarray(0, Math.max(0, remaining)));
        totalBytes = maxBytes;
        truncated = true;
        settle();
        return;
      }
      chunks.push(converted);
      totalBytes += converted.length;
    });

    decoder.on('end', () => settle());
    decoder.on('error', settle);
    opusStream.on('error', settle);
    pipeline(opusStream, decoder, (error) => {
      if (error && !truncated) settle(error);
    });
  });
}

async function handleSpeakingSegment(
  connection: VoiceConnection,
  guildId: string,
  userId: string,
  commandsActive: boolean,
  modelPath: string | null,
  threshold: number,
  collectionDir: string | null
): Promise<void> {
  const silenceMs = envInt(process.env.VOICE_SEGMENT_SILENCE_MS, 900, 250, 5000);
  const maxSeconds = envNumber(process.env.VOICE_MAX_SEGMENT_SECONDS, 8, 1, 30);
  const minDurationMs = envInt(process.env.VOICE_MIN_SEGMENT_MS, 450, 100, 5000);
  const cooldownMs = envInt(process.env.VOICE_COMMAND_COOLDOWN_MS, 3000, 0, 60000);
  const debug = envBool(process.env.VOICE_DEBUG, false);

  if (cooldownMs > 0 && isInCooldown(guildId, userId)) {
    if (debug) console.log(`[discord-voice] cooldown guild=${guildId} user=${userId}`);
    return;
  }

  const segment = await collectDiscordAudioSegment(connection, userId, silenceMs, maxSeconds);
  if (segment.durationMs < minDurationMs) {
    if (debug) console.log(`[discord-voice] ignored short segment guild=${guildId} user=${userId} durationMs=${segment.durationMs}`);
    return;
  }

  const audioPath = path.join(os.tmpdir(), `eppu-discord-voice-${guildId}-${userId}-${Date.now()}.wav`);
  try {
    await writeWavFromPcm16kMono(audioPath, segment.pcm16k);

    if (collectionDir) {
      await fs.promises.mkdir(collectionDir, { recursive: true });
      const label = safeFilePart(process.env.VOICE_SAMPLE_COLLECTION_LABEL?.trim() || 'unknown');
      const sampleName = [
        label,
        safeFilePart(guildId),
        safeFilePart(userId),
        String(Date.now()),
        `${segment.durationMs}ms`,
      ].join('_') + '.wav';
      const samplePath = path.join(collectionDir, sampleName);
      await fs.promises.copyFile(audioPath, samplePath);
      console.log(
        `[discord-voice] saved training sample path=${samplePath} guild=${guildId} `
        + `user=${userId} durationMs=${segment.durationMs} truncated=${segment.truncated}`
      );
    }

    if (!commandsActive) return;

    let transcript = '';
    if (wakeEngine() === 'openwakeword') {
      if (!modelPath) return;
      const wake = await wakeScore(audioPath, threshold);
      if (!wake.detected) {
        if (debug) {
          console.log(
            `[discord-voice] wake miss guild=${guildId} user=${userId} `
            + `score=${wake.score.toFixed(3)} durationMs=${segment.durationMs}`
          );
        }
        return;
      }
      markCooldown(guildId, userId, cooldownMs);
      console.log(
        `[discord-voice] wake detected guild=${guildId} user=${userId} `
        + `model=${wake.model || '-'} score=${wake.score.toFixed(3)} durationMs=${segment.durationMs} `
        + `truncated=${segment.truncated}`
      );
      transcript = await transcribeSegment(audioPath);
    } else {
      transcript = await transcribeSegment(audioPath);
      if (!transcript || !transcriptContainsWakePhrase(transcript)) {
        if (debug) {
          console.log(
            `[discord-voice] no wake phrase guild=${guildId} user=${userId} `
            + `durationMs=${segment.durationMs} text="${quoteForLog(transcript || '-')}"`
          );
        }
        return;
      }
      markCooldown(guildId, userId, cooldownMs);
    }

    console.log(`[discord-voice] transcript guild=${guildId} user=${userId} text="${quoteForLog(transcript || '-')}"`);
    if (!transcript) return;
    if (!commandHandler) {
      console.error('[discord-voice] No command handler registered.');
      return;
    }
    await commandHandler({ guildId, userId, transcript });
  } finally {
    fs.rm(audioPath, { force: true }, () => {});
  }
}

export function setDiscordVoiceCommandHandler(handler: VoiceCommandHandler): void {
  commandHandler = handler;
}

export function startDiscordVoiceReceiver(connection: VoiceConnection, guildId: string, botUserId?: string | null): void {
  const commandsEnabled = voiceCommandsEnabled();
  const collectionDir = sampleCollectionEnabled() ? sampleCollectionDir() : null;
  if (!commandsEnabled && !collectionDir) return;
  if (activeConnections.has(connection)) return;

  const engine = wakeEngine();
  const modelPath = commandsEnabled ? openWakeWordModelPath() : null;
  if (commandsEnabled && engine === 'openwakeword') {
    if (!modelPath) {
      console.error('[discord-voice] OPENWAKEWORD_MODEL_PATH is required when VOICE_WAKE_ENGINE=openwakeword. '
        + 'Set VOICE_WAKE_ENGINE=transcript to run without a trained wake model.');
      return;
    }
    if (!fs.existsSync(modelPath)) {
      console.error(`[discord-voice] OPENWAKEWORD_MODEL_PATH does not exist: ${modelPath}`);
      return;
    }
  }

  const threshold = envNumber(process.env.OPENWAKEWORD_THRESHOLD, 0.55, 0, 1);
  activeConnections.add(connection);
  if (commandsEnabled) startVoiceWorker();
  console.log(
    `[discord-voice] Listening on Discord voice guild=${guildId} `
    + `commands=${commandsEnabled} wakeEngine=${engine} stt=${sttEngine()} threshold=${threshold} `
    + `model=${modelPath || '-'} sampleCollectionDir=${collectionDir || '-'}`
  );

  const onSpeakingStart = (userId: string) => {
    const collectionStillEnabled = sampleCollectionEnabled() && !!sampleCollectionDir();
    if (!voiceCommandsEnabled() && !collectionStillEnabled) return;
    if (shouldIgnoreUser(userId, botUserId || undefined)) return;
    const segmentKey = `${guildId}:${userId}`;
    if (activeSegments.has(segmentKey)) return;
    activeSegments.add(segmentKey);
    void handleSpeakingSegment(
      connection,
      guildId,
      userId,
      voiceCommandsEnabled(),
      voiceCommandsEnabled() ? modelPath : null,
      threshold,
      collectionStillEnabled ? sampleCollectionDir() : null
    )
      .catch((error) => {
        console.error(`[discord-voice] Failed to process speaking segment guild=${guildId} user=${userId}:`, error);
      })
      .finally(() => {
        activeSegments.delete(segmentKey);
      });
  };

  connection.receiver.speaking.on('start', onSpeakingStart);
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    connection.receiver.speaking.off('start', onSpeakingStart);
  });
}

export async function startDefaultDiscordVoiceReceiver(client: Client): Promise<void> {
  const commandsEnabled = voiceCommandsEnabled();
  const collectionDir = sampleCollectionEnabled() ? sampleCollectionDir() : null;
  if (!commandsEnabled && !collectionDir) return;

  const guildId = process.env.VOICE_GUILD_ID?.trim()
    || process.env.DISCORD_GUILD_ID?.trim()
    || process.env.WEB_LOGIN_GUILD_ID?.trim();
  const channelId = process.env.DEFAULT_VOICE_CHANNEL_ID?.trim();
  if (!guildId || !channelId) {
    console.warn('[discord-voice] DEFAULT_VOICE_CHANNEL_ID and VOICE_GUILD_ID or DISCORD_GUILD_ID are required for auto-join listening.');
    return;
  }

  const existing = getVoiceConnection(guildId);
  if (existing) {
    startDiscordVoiceReceiver(existing, guildId, client.user?.id);
    return;
  }

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.warn(`[discord-voice] Could not resolve guild for auto-join listening: ${guildId}`);
    return;
  }

  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isVoiceBased()) {
    console.warn(`[discord-voice] DEFAULT_VOICE_CHANNEL_ID is not a voice channel: ${channelId}`);
    return;
  }

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
    selfDeaf: false,
  });

  ensureVoiceConnectionRecovery(connection, guildId, guild.name);
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log(`[discord-voice] Auto-joined voice channel for listening guild=${guildId} channel=${channelId}`);
    startDiscordVoiceReceiver(connection, guildId, client.user?.id);
  } catch (error) {
    console.error(`[discord-voice] Failed to auto-join voice channel guild=${guildId} channel=${channelId}:`, error);
    connection.destroy();
  }
}
