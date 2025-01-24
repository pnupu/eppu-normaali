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
import youtubeDl, { Payload } from 'youtube-dl-exec';
import { MusicQueue } from '../music/queue';
import path from 'path';

interface ExtendedRequestedDownload {
  url: string;
}

interface ExtendedPayload extends Omit<Payload, 'requested_downloads'> {
  requested_downloads: ExtendedRequestedDownload[];
}

const queues = new Map<string, MusicQueue>();
const COOKIES_PATH = path.join(__dirname, '../../cookies.txt');

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
    console.log('Fetching video info from URL');
    const videoInfo = await youtubeDl(url, {
      dumpSingleJson: true,
      format: 'bestaudio',
      cookies: COOKIES_PATH
    }) as unknown as ExtendedPayload;

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

async function playSong(url: string, player: AudioPlayer, message: Message, title: string) {
  try {
    console.log('Creating audio resource for URL:', url);
    const resource = createAudioResource(url, {
      inputType: StreamType.Arbitrary,
    });
    
    console.log('Playing audio resource');
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