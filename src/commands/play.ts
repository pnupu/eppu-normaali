import { Message } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  DiscordGatewayAdapterCreator,
  StreamType
} from '@discordjs/voice';
import youtubeDl from 'youtube-dl-exec';

export async function handlePlay(message: Message, url: string) {
  if (!message.member?.voice.channel) {
    message.reply('You need to be in a voice channel!');
    return;
  }

  try {
    const videoInfo = await youtubeDl(url, {
      dumpSingleJson: true,
      format: 'bestaudio'
    });

    if (!videoInfo.requested_downloads?.[0]?.url as unknown) {
      throw new Error('No audio URL found');
    }

    const connection = joinVoiceChannel({
      channelId: message.member.voice.channel.id,
      guildId: message.guild!.id,
      adapterCreator: message.guild!.voiceAdapterCreator as DiscordGatewayAdapterCreator,
    });

    const player = createAudioPlayer();
    const resource = createAudioResource(videoInfo.requested_downloads[0].url, {
      inputType: StreamType.Arbitrary,
    });
    
    connection.subscribe(player);
    player.play(resource);

    message.reply(`Now playing: ${videoInfo.title}`);
  } catch (error) {
    console.error(error);
    message.reply('Error playing the video!');
  }
}