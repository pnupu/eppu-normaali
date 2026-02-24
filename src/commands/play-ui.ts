import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Message } from 'discord.js';

const lastBotMessages = new Map<string, Message>();
const hasRepliedToPlay = new Map<string, boolean>();

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

export async function sendOrEditMusicMessage(message: Message, content: string, isFirstSong: boolean = false) {
  const guildId = message.guild!.id;
  const controls = createMusicControls();

  try {
    if (isFirstSong && !hasRepliedToPlay.get(guildId)) {
      const reply = await message.reply({ content, components: [controls] });
      lastBotMessages.set(guildId, reply);
      hasRepliedToPlay.set(guildId, true);
      return;
    }

    const lastBotMessage = lastBotMessages.get(guildId);
    if (lastBotMessage) {
      try {
        const latestMessages = await message.channel.messages.fetch({ limit: 1 });
        const latestMessage = latestMessages.first();

        if (latestMessage && latestMessage.id === lastBotMessage.id && latestMessage.author.id === message.client.user!.id) {
          await lastBotMessage.edit({ content, components: [controls] });
          return;
        }
      } catch {
        console.log('Could not fetch or edit last message, sending new one');
      }
    }

    const newMessage = await (message.channel as any).send({ content, components: [controls] });
    lastBotMessages.set(guildId, newMessage);

  } catch (error) {
    console.error('Error sending/editing music message:', error);
    (message.channel as any).send(content);
  }
}

export function voiceChannelLabel(message: Message, channelId: string | undefined): string {
  if (!channelId) return 'none';
  const channel = message.guild?.channels.cache.get(channelId);
  const channelName = channel?.isTextBased() || channel?.isVoiceBased() ? channel.name : 'unknown';
  return `${channelName} (${channelId})`;
}

export function clearGuildUiTracking(guildId: string): void {
  hasRepliedToPlay.delete(guildId);
  lastBotMessages.delete(guildId);
}
