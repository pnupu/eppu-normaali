import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';
import { handlePlay } from './commands/play';

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
  
  if (message.content.startsWith('!play')) {
    const url = message.content.split(' ')[1];
    if (!url) {
      message.reply('Please provide a YouTube URL!');
      return;
    }
    await handlePlay(message, url);
  }
});

client.login(process.env.DISCORD_TOKEN);