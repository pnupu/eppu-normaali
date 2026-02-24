import { Client, EmbedBuilder, Message } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { queues } from './play-state';
import { clearStartupTrace } from './play-startup';
import { clearNextSongPrefetch } from './play-prefetch';
import { clearGuildUiTracking } from './play-ui';
import { cleanupLogFiles } from './play-maintenance';

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
      { name: '/play url:<youtube_url>', value: 'Play a YouTube video or playlist', inline: false },
      { name: '/pause', value: 'Pause the current song', inline: true },
      { name: '/resume', value: 'Resume the paused song', inline: true },
      { name: '/skip', value: 'Skip the current song', inline: true },
      { name: '/queue', value: 'Show the current music queue', inline: false },
      { name: '/nukkumaan', value: 'Reset the bot and disconnect from all voice channels (Admin only)', inline: false },
      { name: '/cleanup', value: 'Force cleanup and disconnect from voice channels (Admin only)', inline: false },
      { name: '/help', value: 'Show this help message', inline: false },
      { name: '/web-login', value: 'Get a one-time web login link in DM', inline: false }
    )
    .setFooter({ text: 'You can also use the buttons on music messages for quick controls!' })
    .setTimestamp();

  message.reply({ embeds: [embed] });
}

export function handleCleanup(message: Message) {
  if (!message.member?.permissions.has('Administrator')) {
    message.reply('You need administrator permissions to use this command!');
    return;
  }

  try {
    message.reply('Running cleanup...');
    checkAndLeaveIfNeeded(message.client);
    message.reply('Cleanup completed! Check console for details.');
  } catch (error) {
    console.error('Cleanup command error:', error);
    message.reply('Error during cleanup!');
  }
}

export function handleNukkumaan(message: Message) {
  if (!message.member?.permissions.has('Administrator')) {
    message.reply('You need administrator permissions to use this command!');
    return;
  }

  try {
    message.client.guilds.cache.forEach(guild => {
      const queue = queues.get(guild.id);
      if (queue) {
        const player = queue.getPlayer();
        player.stop();
        queues.delete(guild.id);
      }
      clearStartupTrace(guild.id);
      clearNextSongPrefetch(guild.id);

      const me = guild.members.cache.get(message.client.user!.id);
      if (me?.voice.channel) {
        const connection = getVoiceConnection(guild.id);
        if (connection) {
          connection.destroy();
          console.log(`Destroyed connection in guild: ${guild.name}`);
        }
        me.voice.disconnect();
        console.log(`Left voice channel in guild: ${guild.name}`);
      }

      clearGuildUiTracking(guild.id);
    });

    message.reply('Bot has been reset and disconnected from all voice channels!');
  } catch (error) {
    console.error('Reset command error:', error);
    message.reply('Error during reset!');
  }
}

export function checkAndLeaveChannel(guildId: string, client: Client) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.log(`Guild ${guildId} not found, cleaning up...`);
    if (queues.has(guildId)) {
      queues.delete(guildId);
      clearGuildUiTracking(guildId);
    }
    clearStartupTrace(guildId);
    clearNextSongPrefetch(guildId);
    return;
  }

  const botMember = guild.members.cache.get(client.user!.id);
  const channel = botMember?.voice.channel;

  if (!channel) {
    console.log(`Bot not in voice channel in ${guild.name}, cleaning up...`);
    if (queues.has(guildId)) {
      queues.delete(guildId);
      clearGuildUiTracking(guildId);
    }
    clearStartupTrace(guildId);
    clearNextSongPrefetch(guildId);
    return;
  }

  const humanMembers = channel.members.filter(member => !member.user.bot).size;
  const queue = queues.get(guildId);
  const isPlaying = queue && queue.getCurrentSong() && !queue.isIdle();

  console.log(`Checking ${guild.name}: ${humanMembers} humans, playing: ${isPlaying}, queue size: ${queue ? queue.getQueue().length : 0}`);

  if (humanMembers === 0 || (!isPlaying && (!queue || (!queue.getCurrentSong() && !queue.hasNextSong())))) {
    console.log(`Leaving voice channel in ${guild.name}: ${humanMembers === 0 ? 'alone' : 'no music playing'}`);

    const connection = getVoiceConnection(guildId);
    if (connection) {
      try {
        connection.destroy();
        console.log(`Destroyed voice connection for ${guild.name}`);
      } catch (error) {
        console.error(`Error destroying connection for ${guild.name}:`, error);
      }
    }

    if (queue) {
      try {
        const player = queue.getPlayer();
        player.stop();
        console.log(`Stopped audio player for ${guild.name}`);
      } catch (error) {
        console.error(`Error stopping player for ${guild.name}:`, error);
      }
      queues.delete(guildId);
    }
    clearStartupTrace(guildId);
    clearNextSongPrefetch(guildId);
    clearGuildUiTracking(guildId);
    console.log(`Cleaned up all tracking for ${guild.name}`);
  }
}

export function checkAndLeaveIfNeeded(client: Client, specificGuildId?: string) {
  console.log(`Running checkAndLeaveIfNeeded for ${specificGuildId || 'all guilds'}`);

  cleanupLogFiles();

  if (specificGuildId) {
    const guild = client.guilds.cache.get(specificGuildId);
    if (guild) {
      const botMember = guild.members.cache.get(client.user!.id);
      if (botMember?.voice.channel) {
        checkAndLeaveChannel(guild.id, client);
      } else {
        checkAndLeaveChannel(guild.id, client);
      }
    } else {
      checkAndLeaveChannel(specificGuildId, client);
    }
  } else {
    let checkedGuilds = 0;
    let cleanedGuilds = 0;

    client.guilds.cache.forEach(guild => {
      checkedGuilds++;
      const botMember = guild.members.cache.get(client.user!.id);
      if (botMember?.voice.channel) {
        checkAndLeaveChannel(guild.id, client);
        cleanedGuilds++;
      } else {
        checkAndLeaveChannel(guild.id, client);
      }
    });

    console.log(`Checked ${checkedGuilds} guilds, cleaned up ${cleanedGuilds} voice connections`);
  }
}
