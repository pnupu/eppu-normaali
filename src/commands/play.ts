// src/commands/play.ts
import { Message } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  DiscordGatewayAdapterCreator,
  StreamType,
  AudioPlayerStatus,
  AudioPlayer,
  VoiceConnectionStatus
} from '@discordjs/voice';
import youtubeDl, { Payload, Flags } from 'youtube-dl-exec';
import { MusicQueue } from '../music/queue';
import path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import fs from 'fs';

interface ExtendedRequestedDownload {
  url: string;
}

interface ExtendedPayload extends Omit<Payload, 'requested_downloads'> {
  requested_downloads: ExtendedRequestedDownload[];
}

const queues = new Map<string, MusicQueue>();
const COOKIES_PATH = path.join(__dirname, '../../cookies.txt');

async function getPoToken(): Promise<string> {
  try {
    const response = await fetch('http://localhost:8080/token');
    const data = await response.text();
    return data.trim();
  } catch (error) {
    console.error('Failed to fetch PO token:', error);
    throw error;
  }
}

export async function handlePlay(message: Message, url: string) {
  console.log('Starting handlePlay with URL:', url);
  if (!message.member?.voice.channel) {
    console.log('User not in voice channel');
    message.reply('You need to be in a voice channel!');
    return;
  }

  const guildId = message.guild!.id;
  let queue = queues.get(guildId);
  console.log('Queue exists:', !!queue);

  try {
    console.log('Fetching PO token');
    const poToken = await getPoToken();
    
    console.log('Fetching video info with token');
    const flags: Flags = {
      dumpSingleJson: true,
      format: 'bestaudio',
      cookies: COOKIES_PATH,
      addHeader: [`extractor-args:youtube:player-client=web,default;po_token=web+${poToken}`]
    };

    const videoInfo = await youtubeDl(url, flags) as unknown as ExtendedPayload;

    if (!videoInfo.requested_downloads?.[0]?.url) {
      console.error('No audio URL found in video info');
      throw new Error('No audio URL found');
    }

    if (!queue) {
      console.log('Creating new voice connection and queue');
      const connection = joinVoiceChannel({
        channelId: message.member.voice.channel.id,
        guildId: guildId,
        adapterCreator: message.guild!.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      });

      connection.on('stateChange', (oldState, newState) => {
        console.log(`Connection state changed from ${oldState.status} to ${newState.status}`);
      });

      connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
        console.log('Voice Connection Disconnected:', oldState, newState);
      });

      connection.on('error', error => {
        console.error('Voice Connection Error:', error);
      });

      const player = createAudioPlayer();
      
      player.on('error', error => {
        console.error('Audio Player Error:', error);
      });

      player.on('stateChange', (oldState, newState) => {
        console.log(`Audio player state changed from ${oldState.status} to ${newState.status}`);
      });

      queue = new MusicQueue(player);
      queues.set(guildId, queue);
      
      connection.subscribe(player);

      player.on(AudioPlayerStatus.Idle, () => {
        const nextSong = queue!.getNextSong();
        if (nextSong) {
          playSong(nextSong.url, queue!.getPlayer(), message, nextSong.title);
        }
      });
    }

    console.log('Adding song to queue:', videoInfo.title);
    const queueItem = {
      title: videoInfo.title,
      url: videoInfo.requested_downloads[0].url,
      requestedBy: message.author.username
    };

    if (queue.getCurrentSong()) {
      queue.addSong(queueItem);
      message.reply(`Added to queue: ${videoInfo.title}`);
    } else {
      queue.addSong(queueItem);
      const nextSong = queue.getNextSong();
      if (nextSong) {
        playSong(nextSong.url, queue.getPlayer(), message, nextSong.title);
      }
    }

  } catch (error) {
    console.error('Play command error:', error);
    message.reply('Error playing the video!');
  }
}

function createFfmpegStream(url: string): Readable {
  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', url,
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-loglevel', 'error',
    'pipe:1'
  ]);

  ffmpeg.stderr.on('data', data => {
    console.error(`FFmpeg stderr: ${data}`);
  });

  return ffmpeg.stdout;
}

async function playSong(url: string, player: AudioPlayer, message: Message, title: string) {
  try {
    console.log('Creating FFmpeg stream for URL:', url);
    const stream = createFfmpegStream(url);
    
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });

    resource.volume?.setVolume(1);
    player.play(resource);
    message.reply(`Now playing: ${title}`);
  } catch (error) {
    console.error('Error in playSong:', error);
    message.reply('Error playing the audio');
  }
}

export function handlePause(message: Message) {
  const queue = queues.get(message.guild!.id);
  if (!queue) {
    message.reply('No music is playing!');
    return;
  }

  if (queue.pause()) {
    message.reply('Paused the music!');
  } else {
    message.reply('The music is already paused!');
  }
}

export function handleResume(message: Message) {
  const queue = queues.get(message.guild!.id);
  if (!queue) {
    message.reply('No music is queued!');
    return;
  }

  if (queue.resume()) {
    message.reply('Resumed the music!');
  } else {
    message.reply('The music is already playing!');
  }
}

export function handleSkip(message: Message) {
  const queue = queues.get(message.guild!.id);
  if (!queue) {
    message.reply('No music is playing!');
    return;
  }

  queue.skip();
  message.reply('Skipped the current song!');
}

export function handleQueue(message: Message) {
  const queue = queues.get(message.guild!.id);
  if (!queue) {
    message.reply('No music is queued!');
    return;
  }

  const currentSong = queue.getCurrentSong();
  const queueList = queue.getQueue();

  let response = 'Music Queue:\n';
  if (currentSong) {
    response += `Now Playing: ${currentSong.title} (requested by ${currentSong.requestedBy})\n\n`;
  }

  if (queueList.length === 0) {
    response += 'No songs in queue.';
  } else {
    response += queueList
      .map((song, index) => `${index + 1}. ${song.title} (requested by ${song.requestedBy})`)
      .join('\n');
  }

  message.reply(response);
}

export async function handleCookies(message: Message, cookiesContent?: string) {
  try {
    if (!message.member?.permissions.has('Administrator')) {
      message.reply('You need administrator permissions to use this command!');
      return;
    }

    if (!cookiesContent) {
      // If no content provided, read and show current cookies
      const currentCookies = await fs.promises.readFile(COOKIES_PATH, 'utf-8');
      message.reply('Current cookies content:\n```\n' + currentCookies + '\n```');
      return;
    }

    // Write new cookies content
    await fs.promises.writeFile(COOKIES_PATH, cookiesContent);
    message.reply('Cookies file has been updated successfully!');
  } catch (error) {
    console.error('Error handling cookies command:', error);
    message.reply('Error updating cookies file!');
  }
}