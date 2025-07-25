import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';
import { handlePlay, handlePause, handleResume, handleSkip, handleQueue, handleReset, handleHelp } from './commands/play';

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
    case '!reset':
      handleReset(message);
      break;
    case '!help':
      handleHelp(message);
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

client.login(process.env.DISCORD_TOKEN);