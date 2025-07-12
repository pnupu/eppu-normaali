// src/commands/play.ts
import { Message, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  DiscordGatewayAdapterCreator,
  StreamType,
  AudioPlayerStatus,
  AudioPlayer,
  VoiceConnectionStatus,
  getVoiceConnection
} from '@discordjs/voice';
import youtubeDl, { Payload, Flags } from 'youtube-dl-exec';
import { MusicQueue } from '../music/queue';
import path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import fs from 'fs';
import { execSync } from 'child_process';

interface ExtendedRequestedDownload {
  url: string;
}

interface ExtendedPayload extends Omit<Payload, 'requested_downloads'> {
  requested_downloads: ExtendedRequestedDownload[];
}

interface PlaylistEntry {
  title: string;
  url: string;
  id: string;
}

const queues = new Map<string, MusicQueue>();
const COOKIES_PATH = path.join(__dirname, '../../cookies.txt');

// Track the last bot message for each guild
const lastBotMessages = new Map<string, Message>();
// Track if we've already replied to the original play message
const hasRepliedToPlay = new Map<string, boolean>();

// Check disk space and warn if low
function checkDiskSpace(): { available: number; percentage: number } {
  try {
    const output = execSync('df -h / | tail -1', { encoding: 'utf8' });
    const parts = output.trim().split(/\s+/);
    const percentage = parseInt(parts[4].replace('%', ''));
    const available = parts[3];
    
    if (percentage > 90) {
      console.warn(`⚠️  Disk space warning: ${percentage}% used, ${available} available`);
    }
    
    return { available: parseFloat(available), percentage };
  } catch (error) {
    console.error('Could not check disk space:', error);
    return { available: 0, percentage: 0 };
  }
}

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

function createMusicControls() {
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('pause')
        .setLabel('⏸️ Pause')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('resume')
        .setLabel('▶️ Resume')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('skip')
        .setLabel('⏭️ Skip')
        .setStyle(ButtonStyle.Primary)
    );
  
  return row;
}

async function sendOrEditMusicMessage(message: Message, content: string, isFirstSong: boolean = false) {
  const guildId = message.guild!.id;
  const controls = createMusicControls();
  
  try {
    // If this is the first song and we haven't replied yet, reply to the original message
    if (isFirstSong && !hasRepliedToPlay.get(guildId)) {
      const reply = await message.reply({ content, components: [controls] });
      lastBotMessages.set(guildId, reply);
      hasRepliedToPlay.set(guildId, true);
      return;
    }
    
    // Check if we have a last bot message and if it's still the latest in the channel
    const lastBotMessage = lastBotMessages.get(guildId);
    if (lastBotMessage) {
      try {
        // Fetch the latest messages to see if our message is still the latest
        const latestMessages = await message.channel.messages.fetch({ limit: 1 });
        const latestMessage = latestMessages.first();
        
        if (latestMessage && latestMessage.id === lastBotMessage.id && latestMessage.author.id === message.client.user!.id) {
          // Our message is still the latest, edit it
          await lastBotMessage.edit({ content, components: [controls] });
          return;
        }
      } catch (error) {
        console.log('Could not fetch or edit last message, sending new one');
      }
    }
    
    // Send a new message
    const newMessage = await (message.channel as any).send({ content, components: [controls] });
    lastBotMessages.set(guildId, newMessage);
    
  } catch (error) {
    console.error('Error sending/editing music message:', error);
    // Fallback to simple message
    (message.channel as any).send(content);
  }
}

export async function handlePlay(message: Message, url: string) {
  console.log('Starting handlePlay with URL:', url);
  
  // Check disk space before proceeding
  const diskInfo = checkDiskSpace();
  if (diskInfo.percentage > 95) {
    message.reply('⚠️ Error: Disk space critically low! Cannot play music. Please free up some space.');
    return;
  }
  
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
    
    // Check if URL is a playlist
    const isPlaylist = url.includes('playlist') || url.includes('list=');
    
    if (isPlaylist) {
      await handlePlaylist(message, url, queue);
      return;
    }
    
    // Handle single video
    console.log('Fetching video info with token');
    const flags: Flags = {
      dumpSingleJson: true,
      format: 'bestaudio',
      simulate: true,    // Don't download, just simulate
    };

    const videoInfo = await youtubeDl(url, flags) as unknown as ExtendedPayload;

    if (!videoInfo.requested_downloads?.[0]?.url) {
      console.error('No audio URL found in video info');
      throw new Error('No audio URL found');
    }

    const isFirstSong = !queue;
    
    if (!queue) {
      queue = await createQueueAndConnection(message);
    }

    console.log('Adding song to queue:', videoInfo.title);
    
    // Store the original YouTube URL instead of the direct audio URL
    // We'll get a fresh audio URL when we actually play it
    const queueItem = {
      title: videoInfo.title,
      url: url, // Store original YouTube URL
      requestedBy: message.author.username
    };

    queue.addSong(queueItem);
    
    // If this is the current song (no other song playing), start playing immediately
    if (queue.getCurrentSong()?.url === queueItem.url) {
      // Start playing immediately with fresh URL - no delay
      playYouTubeUrl(queueItem.url, queue.getPlayer(), message, queueItem.title, isFirstSong);
    } else {
      await sendOrEditMusicMessage(message, `Added to queue: ${videoInfo.title}`);
    }

  } catch (error) {
    console.error('Play command error:', error);
    message.reply('Error playing the video!');
  }
}

async function handlePlaylist(message: Message, url: string, existingQueue?: MusicQueue) {
  try {
    message.reply('Processing playlist. This may take a moment...');
    
    // Get playlist info
    const playlistFlags: Flags = {
      dumpSingleJson: true,
      flatPlaylist: true,
      simulate: true,    // Don't download, just get info
    };
    
    const playlistInfo = await youtubeDl(url, playlistFlags) as any;
    
    if (!playlistInfo || !playlistInfo.entries || !Array.isArray(playlistInfo.entries)) {
      throw new Error('Failed to get playlist information');
    }
    
    const entries = playlistInfo.entries as PlaylistEntry[];
    
    if (entries.length === 0) {
      message.reply('No videos found in the playlist.');
      return;
    }
    
    // Create queue if it doesn't exist
    const guildId = message.guild!.id;
    let queue = existingQueue || queues.get(guildId);
    const isFirstSong = !queue;
    
    if (!queue) {
      queue = await createQueueAndConnection(message);
    }
    
    // Process each video in the playlist
    let addedCount = 0;
    const totalVideos = entries.length;
    
    message.reply(`Found ${totalVideos} videos in the playlist. Adding to queue...`);
    
    // Add YouTube URLs to queue (we'll get fresh audio URLs when playing)
    for (const entry of entries) {
      try {
        // Just get the title, store the YouTube URL for later
        const videoFlags: Flags = {
          dumpSingleJson: true,
          simulate: true,
        };
        
        const videoInfo = await youtubeDl(entry.url, videoFlags) as unknown as ExtendedPayload;
        
        if (videoInfo.title) {
          const queueItem = {
            title: videoInfo.title,
            url: entry.url, // Store YouTube URL, not direct audio URL
            requestedBy: message.author.username
          };
          
          queue.addSong(queueItem);
          addedCount++;
          
          // Start playing the first song if it's the current song
          if (queue.getCurrentSong()?.url === queueItem.url) {
            playYouTubeUrl(queueItem.url, queue.getPlayer(), message, queueItem.title, isFirstSong && addedCount === 1);
          }
        }
      } catch (error) {
        console.error(`Error processing playlist video ${entry.url}:`, error);
        // Continue with next video even if one fails
      }
    }
    
    message.reply(`Successfully added ${addedCount} out of ${totalVideos} videos from the playlist to the queue.`);
    
  } catch (error) {
    console.error('Playlist processing error:', error);
    message.reply('Error processing the playlist!');
  }
}

async function createQueueAndConnection(message: Message): Promise<MusicQueue> {
  console.log('Creating new voice connection and queue');
  const guildId = message.guild!.id;
  
  const connection = joinVoiceChannel({
    channelId: message.member!.voice.channel!.id,
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

  const queue = new MusicQueue(player);
  queues.set(guildId, queue);
  
  connection.subscribe(player);

  player.on(AudioPlayerStatus.Idle, () => {
    const nextSong = queue.getNextSong();
    if (nextSong) {
      playYouTubeUrl(nextSong.url, queue.getPlayer(), message, nextSong.title);
    } else {
      // No more songs in queue, check if we should disconnect
      const channel = message.guild!.members.cache.get(message.client.user!.id)?.voice.channel;
      if (channel) {
        const humanMembers = channel.members.filter(member => !member.user.bot).size;
        if (humanMembers === 0) {
          connection.destroy();
          queues.delete(guildId);
          // Reset tracking for this guild
          hasRepliedToPlay.delete(guildId);
          lastBotMessages.delete(guildId);
        }
      }
    }
  });
  
  return queue;
}

function createFfmpegStream(url: string): Readable {
  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-headers', 'Accept: */*',
    '-headers', 'Accept-Language: en-US,en;q=0.9',
    '-headers', 'Accept-Encoding: identity',
    '-headers', 'Range: bytes=0-',
    '-headers', 'Connection: keep-alive',
    '-headers', 'Sec-Fetch-Dest: video',
    '-headers', 'Sec-Fetch-Mode: no-cors',
    '-headers', 'Sec-Fetch-Site: cross-site',
    '-i', url,
    '-analyzeduration', '0',
    '-probesize', '32',        // Minimize probe size to reduce memory usage
    '-loglevel', 'info',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-acodec', 'pcm_s16le',
    '-bufsize', '64k',         // Small buffer size to reduce memory usage
    'pipe:1'
  ]);

  // Handle process errors
  ffmpeg.on('error', error => {
    console.error('FFmpeg process error:', error);
  });

  // Handle process exit
  ffmpeg.on('exit', (code, signal) => {
    if (code !== 0) {
      console.log(`FFmpeg process exited with code ${code} and signal ${signal}`);
    }
  });

  // Handle stderr to see what FFmpeg is complaining about
  ffmpeg.stderr.on('data', (data) => {
    const errorMessage = data.toString();
    console.error('FFmpeg stderr:', errorMessage);
    
    // Check for specific error patterns
    if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
      console.error('FFmpeg: Access forbidden - URL may have expired');
    }
    if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
      console.error('FFmpeg: URL not found - URL may have expired');
    }
  });

  // Handle stdout errors
  const stdout = ffmpeg.stdout;
  stdout.on('error', error => {
    console.error('FFmpeg stdout error:', error);
  });

  return stdout;
}

function createYouTubeStream(youtubeUrl: string): Readable {
  // Use youtube-dl to pipe directly to FFmpeg
  const youtubeDlProcess = spawn('youtube-dl', [
    '--format', 'bestaudio',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--referer', 'https://www.youtube.com/',
    '--output', '-',
    youtubeUrl
  ]);

  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-analyzeduration', '0',
    '-probesize', '32',
    '-loglevel', 'info',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-acodec', 'pcm_s16le',
    '-bufsize', '64k',
    'pipe:1'
  ]);

  // Pipe youtube-dl output to FFmpeg input
  youtubeDlProcess.stdout.pipe(ffmpeg.stdin);

  // Handle youtube-dl errors
  youtubeDlProcess.on('error', error => {
    console.error('YouTube-dl process error:', error);
  });

  youtubeDlProcess.stderr.on('data', (data) => {
    console.error('YouTube-dl stderr:', data.toString());
  });

  youtubeDlProcess.on('exit', (code, signal) => {
    if (code !== 0) {
      console.log(`YouTube-dl process exited with code ${code} and signal ${signal}`);
    }
  });

  // Handle process errors
  ffmpeg.on('error', error => {
    console.error('FFmpeg process error:', error);
  });

  // Handle process exit
  ffmpeg.on('exit', (code, signal) => {
    if (code !== 0) {
      console.log(`FFmpeg process exited with code ${code} and signal ${signal}`);
    }
  });

  // Handle stderr to see what FFmpeg is complaining about
  ffmpeg.stderr.on('data', (data) => {
    const errorMessage = data.toString();
    console.error('FFmpeg stderr:', errorMessage);
    
    // Check for specific error patterns
    if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
      console.error('FFmpeg: Access forbidden - URL may have expired');
    }
    if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
      console.error('FFmpeg: URL not found - URL may have expired');
    }
  });

  // Handle stdout errors
  const stdout = ffmpeg.stdout;
  stdout.on('error', error => {
    console.error('FFmpeg stdout error:', error);
  });

  return stdout;
}

async function playYouTubeUrlDirect(youtubeUrl: string, player: AudioPlayer, message: Message, title: string, isFirstSong: boolean = false) {
  try {
    console.log('Streaming directly from YouTube URL with FFmpeg:', youtubeUrl);
    
    // Use FFmpeg with youtube-dl to stream directly
    const stream = createYouTubeStream(youtubeUrl);
    
    // Add error handling for the stream
    stream.on('error', (error: Error) => {
      console.error('YouTube stream error:', error);
      message.reply('Error with YouTube stream');
    });
    
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });

    resource.volume?.setVolume(0.5);
    player.play(resource);
    
    await sendOrEditMusicMessage(message, `Now playing: ${title}`, isFirstSong);
  } catch (error) {
    console.error('Error in playYouTubeUrlDirect:', error);
    message.reply('Error streaming from YouTube');
  }
}

async function playYouTubeUrl(youtubeUrl: string, player: AudioPlayer, message: Message, title: string, isFirstSong: boolean = false) {
  try {
    console.log('Attempting to stream directly from YouTube URL:', youtubeUrl);
    
    // Try streaming directly from YouTube URL using youtube-dl in FFmpeg
    await playYouTubeUrlDirect(youtubeUrl, player, message, title, isFirstSong);
    
  } catch (error) {
    console.error('Error streaming YouTube URL:', error);
    message.reply('Error streaming from YouTube');
  }
}

async function playSong(url: string, player: AudioPlayer, message: Message, title: string, isFirstSong: boolean = false) {
  try {
    console.log('Creating FFmpeg stream for URL:', url);
    console.log('URL length:', url.length);
    console.log('URL starts with:', url.substring(0, 100));
    console.log('FFmpeg starting at timestamp:', Date.now());
    
    const stream = createFfmpegStream(url);
    
    // Add error handling for the stream
    stream.on('error', (error) => {
      console.error('Stream error:', error);
      message.reply('Error with audio stream');
    });
    
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });

    resource.volume?.setVolume(0.5); // Set volume to 50% to avoid distortion
    player.play(resource);
    
    await sendOrEditMusicMessage(message, `Now playing: ${title}`, isFirstSong);
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

export function handleHelp(message: Message) {
  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle('🎵 Music Bot Commands')
    .setDescription('Here are all the available commands:')
    .addFields(
      { name: '!play <url>', value: 'Play a YouTube video or playlist', inline: false },
      { name: '!pause', value: 'Pause the current song', inline: true },
      { name: '!resume', value: 'Resume the paused song', inline: true },
      { name: '!skip', value: 'Skip the current song', inline: true },
      { name: '!queue', value: 'Show the current music queue', inline: false },
      { name: '!reset', value: 'Reset the bot and disconnect from all voice channels (Admin only)', inline: false },
      { name: '!help', value: 'Show this help message', inline: false }
    )
    .setFooter({ text: 'You can also use the buttons on music messages for quick controls!' })
    .setTimestamp();

  message.reply({ embeds: [embed] });
}


export function handleReset(message: Message) {
  if (!message.member?.permissions.has('Administrator')) {
    message.reply('You need administrator permissions to use this command!');
    return;
  }

  try {
    // Check all guilds where the bot is in voice channels
    message.client.guilds.cache.forEach(guild => {
      const queue = queues.get(guild.id);
      if (queue) {
        // Stop the player and clear the queue
        const player = queue.getPlayer();
        player.stop();
        queues.delete(guild.id);
      }

      // Check if bot is in a voice channel
      const me = guild.members.cache.get(message.client.user!.id);
      if (me?.voice.channel) {
        // Force disconnect from voice channel
        const connection = getVoiceConnection(guild.id);
        if (connection) {
          connection.destroy();
          console.log(`Destroyed connection in guild: ${guild.name}`);
        }
        me.voice.disconnect();
        console.log(`Left voice channel in guild: ${guild.name}`);
      }
      
      // Reset tracking for this guild
      hasRepliedToPlay.delete(guild.id);
      lastBotMessages.delete(guild.id);
    });

    message.reply('Bot has been reset and disconnected from all voice channels!');
  } catch (error) {
    console.error('Reset command error:', error);
    message.reply('Error during reset!');
  }
}


