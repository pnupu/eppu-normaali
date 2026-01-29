import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';
import { handlePlay, handlePause, handleResume, handleSkip, handleQueue, handleNukkumaan, handleHelp, handleCleanup, checkAndLeaveIfNeeded } from './commands/play';
import { startWebServer } from './web/server';

config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});


client.once('ready', () => {
  console.log('Bot is ready!');
  
  // Start web UI server
  startWebServer(client);
  
  // Start periodic check every 15 minutes for inactive voice connections
  setInterval(() => {
    console.log('Running periodic cleanup check...');
    checkAndLeaveIfNeeded(client);
  }, 15 * 60 * 1000); // 15 minutes
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  const args = message.content.split(' ');
  const command = args[0].toLowerCase();

  switch(command) {
    case '!play':
      const url = args[1];
      if (!url) {
        message.reply('Please provide a YouTube URL!');
        return;
      }
      await handlePlay(message, url);
      break;
    case '!pause':
      handlePause(message);
      break;
    case '!resume':
      handleResume(message);
      break;
    case '!skip':
      handleSkip(message);
      break;
    case '!queue':
      handleQueue(message);
      break;
    case '!nukkumaan':
      handleNukkumaan(message);
      break;
    case '!help':
      handleHelp(message);
      break;
    case '!cleanup':
      handleCleanup(message);
      break;
  }
});

// Handle button interactions
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  switch (interaction.customId) {
    case 'pause':
      await interaction.deferUpdate();
      handlePause(interaction.message as any);
      break;
    case 'resume':
      await interaction.deferUpdate();
      handleResume(interaction.message as any);
      break;
    case 'skip':
      await interaction.deferUpdate();
      handleSkip(interaction.message as any);
      break;
  }
});

// Handle voice state updates (member leaving/joining voice channels)
client.on('voiceStateUpdate', (oldState, newState) => {
  // Check if someone left a voice channel where the bot is present
  if (oldState.channel && !newState.channel) {
    // Someone left a voice channel
    const botMember = oldState.guild.members.cache.get(client.user!.id);
    if (botMember?.voice.channel && botMember.voice.channel.id === oldState.channel.id) {
      // Bot is in the same channel, check if it should leave
      setTimeout(() => {
        checkAndLeaveIfNeeded(client, oldState.guild.id);
      }, 1000); // Small delay to ensure state updates are processed
    }
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');

  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');

  client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);