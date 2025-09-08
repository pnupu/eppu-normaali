// src/voice/voiceIntegration.ts
import { Message, Client } from 'discord.js';
import { VoiceCommandHandler } from './voiceCommands';
import { FavoritesManager } from '../music/favorites';
import { MusicSearch } from '../music/search';
import { handlePlay, handlePause, handleResume, handleSkip, handleQueue } from '../commands/play';
import { VoiceFeedback } from './voiceFeedback';

export class VoiceIntegration {
  private voiceHandler: VoiceCommandHandler;
  private favoritesManager: FavoritesManager;
  private searchEngine: MusicSearch;
  private voiceFeedback: VoiceFeedback;
  private client: Client;
  private currentGuildMessage: Map<string, Message> = new Map();

  constructor(client: Client) {
    this.client = client;
    this.voiceHandler = new VoiceCommandHandler();
    this.favoritesManager = new FavoritesManager();
    this.searchEngine = new MusicSearch();
    this.voiceFeedback = new VoiceFeedback();
    
    this.setupVoiceCommandHandlers();
  }

  private setupVoiceCommandHandlers(): void {
    // Override the voice command handlers to use Discord message context
    this.voiceHandler['handlePlayCommand'] = this.handlePlayCommand.bind(this);
    this.voiceHandler['handlePauseCommand'] = this.handlePauseCommand.bind(this);
    this.voiceHandler['handleResumeCommand'] = this.handleResumeCommand.bind(this);
    this.voiceHandler['handleSkipCommand'] = this.handleSkipCommand.bind(this);
    this.voiceHandler['handleStopCommand'] = this.handleStopCommand.bind(this);
    this.voiceHandler['handleQueueCommand'] = this.handleQueueCommand.bind(this);
    this.voiceHandler['handleAddFavoriteCommand'] = this.handleAddFavoriteCommand.bind(this);
    this.voiceHandler['handlePlayFavoritesCommand'] = this.handlePlayFavoritesCommand.bind(this);
    this.voiceHandler['handleShowFavoritesCommand'] = this.handleShowFavoritesCommand.bind(this);
    this.voiceHandler['handleSearchCommand'] = this.handleSearchCommand.bind(this);
    this.voiceHandler['handleHelpCommand'] = this.handleHelpCommand.bind(this);
  }

  public startListening(): void {
    this.voiceHandler.startListening();
  }

  public stopListening(): void {
    this.voiceHandler.stopListening();
  }

  public setCurrentGuildMessage(guildId: string, message: Message): void {
    this.currentGuildMessage.set(guildId, message);
  }

  // Voice command handlers with Discord integration
  private async handlePlayCommand(command: any): Promise<void> {
    const songQuery = command.parameters.song;
    if (!songQuery) {
      await this.voiceFeedback.speakFinnish('Mikä kappale?');
      return;
    }

    // Get the current guild message
    const guildId = this.getCurrentGuildId();
    const message = this.currentGuildMessage.get(guildId);
    if (!message) {
      await this.voiceFeedback.speakFinnish('En löydä äänikanavaa');
      return;
    }

    // Search for the song
    const searchResults = await this.searchEngine.searchSongs(songQuery, 1);
    if (searchResults.length === 0) {
      await this.voiceFeedback.speakFinnish('Kappaletta ei löytynyt');
      return;
    }

    const song = searchResults[0];
    await this.voiceFeedback.speakFinnish(`Toistetaan: ${song.title}`);
    
    // Use the existing handlePlay function
    await handlePlay(message, song.url);
  }

  private async handlePauseCommand(): Promise<void> {
    const message = this.getCurrentMessage();
    if (!message) {
      await this.voiceFeedback.speakFinnish('En löydä äänikanavaa');
      return;
    }

    handlePause(message);
    await this.voiceFeedback.speakFinnish('Tauotetaan musiikki');
  }

  private async handleResumeCommand(): Promise<void> {
    const message = this.getCurrentMessage();
    if (!message) {
      await this.voiceFeedback.speakFinnish('En löydä äänikanavaa');
      return;
    }

    handleResume(message);
    await this.voiceFeedback.speakFinnish('Jatketaan musiikkia');
  }

  private async handleSkipCommand(): Promise<void> {
    const message = this.getCurrentMessage();
    if (!message) {
      await this.voiceFeedback.speakFinnish('En löydä äänikanavaa');
      return;
    }

    handleSkip(message);
    await this.voiceFeedback.speakFinnish('Seuraava kappale');
  }

  private async handleStopCommand(): Promise<void> {
    const message = this.getCurrentMessage();
    if (!message) {
      await this.voiceFeedback.speakFinnish('En löydä äänikanavaa');
      return;
    }

    handlePause(message); // Stop by pausing
    await this.voiceFeedback.speakFinnish('Lopetetaan musiikki');
  }

  private async handleQueueCommand(): Promise<void> {
    const message = this.getCurrentMessage();
    if (!message) {
      await this.voiceFeedback.speakFinnish('En löydä äänikanavaa');
      return;
    }

    handleQueue(message);
    await this.voiceFeedback.speakFinnish('Näytetään jono');
  }

  private async handleAddFavoriteCommand(): Promise<void> {
    const message = this.getCurrentMessage();
    if (!message) {
      await this.voiceFeedback.speakFinnish('En löydä äänikanavaa');
      return;
    }

    // Get current song info from the music queue
    const guildId = message.guild!.id;
    const queue = this.voiceHandler['queues']?.get(guildId);
    const currentSong = queue?.getCurrentSong();

    if (!currentSong) {
      await this.voiceFeedback.speakFinnish('Ei kappaletta toistamassa');
      return;
    }

    try {
      await this.favoritesManager.addFavorite({
        title: currentSong.title,
        url: currentSong.url,
        artist: currentSong.requestedBy,
        addedBy: message.author.username
      });

      await this.voiceFeedback.speakFinnish('Lisätty suosikkeihin');
    } catch (error) {
      console.error('Error adding favorite:', error);
      await this.voiceFeedback.speakFinnish('Virhe suosikin lisäämisessä');
    }
  }

  private async handlePlayFavoritesCommand(): Promise<void> {
    const message = this.getCurrentMessage();
    if (!message) {
      await this.voiceFeedback.speakFinnish('En löydä äänikanavaa');
      return;
    }

    try {
      const favorites = await this.favoritesManager.getFavorites(message.author.username);
      if (favorites.length === 0) {
        await this.voiceFeedback.speakFinnish('Suosikkilista on tyhjä');
        return;
      }

      // Play the first favorite
      const favorite = favorites[0];
      await this.voiceFeedback.speakFinnish(`Toistetaan suosikki: ${favorite.title}`);
      await handlePlay(message, favorite.url);

      // Increment play count
      await this.favoritesManager.incrementPlayCount(favorite.url, message.author.username);

    } catch (error) {
      console.error('Error playing favorites:', error);
      await this.voiceFeedback.speakFinnish('Virhe suosikkien toistamisessa');
    }
  }

  private async handleShowFavoritesCommand(): Promise<void> {
    const message = this.getCurrentMessage();
    if (!message) {
      await this.voiceFeedback.speakFinnish('En löydä äänikanavaa');
      return;
    }

    try {
      const favorites = await this.favoritesManager.getFavorites(message.author.username);
      if (favorites.length === 0) {
        await this.voiceFeedback.speakFinnish('Suosikkilista on tyhjä');
        return;
      }

      let response = 'Suosikkisi:\n';
      favorites.slice(0, 10).forEach((fav, index) => {
        response += `${index + 1}. ${fav.title}\n`;
      });

      message.reply(response);
      await this.voiceFeedback.speakFinnish(`Sinulla on ${favorites.length} suosikkia`);

    } catch (error) {
      console.error('Error showing favorites:', error);
      await this.voiceFeedback.speakFinnish('Virhe suosikkien näyttämisessä');
    }
  }

  private async handleSearchCommand(command: any): Promise<void> {
    const searchQuery = command.parameters.song;
    if (!searchQuery) {
      await this.voiceFeedback.speakFinnish('Mitä etsitään?');
      return;
    }

    const message = this.getCurrentMessage();
    if (!message) {
      await this.voiceFeedback.speakFinnish('En löydä äänikanavaa');
      return;
    }

    try {
      const searchResults = await this.searchEngine.searchSongs(searchQuery, 5);
      if (searchResults.length === 0) {
        await this.voiceFeedback.speakFinnish('Hakutuloksia ei löytynyt');
        return;
      }

      // Show search results in Discord
      let response = `Hakutulokset "${searchQuery}":\n`;
      searchResults.forEach((result, index)) => {
        response += `${index + 1}. ${result.title} - ${result.uploader}\n`;
      });

      message.reply(response);
      await this.voiceFeedback.speakFinnish(`Löytyi ${searchResults.length} hakutulosta`);

      // Play the first result
      const firstResult = searchResults[0];
      await this.voiceFeedback.speakFinnish(`Toistetaan: ${firstResult.title}`);
      await handlePlay(message, firstResult.url);

    } catch (error) {
      console.error('Error searching:', error);
      await this.voiceFeedback.speakFinnish('Virhe haun suorittamisessa');
    }
  }

  private async handleHelpCommand(): Promise<void> {
    const message = this.getCurrentMessage();
    if (!message) {
      await this.voiceFeedback.speakFinnish('En löydä äänikanavaa');
      return;
    }

    const helpText = this.voiceHandler['commandParser'].getCommandHelp();
    message.reply(helpText);
    await this.voiceFeedback.speakFinnish('Näytetään ohje');
  }

  private getCurrentMessage(): Message | null {
    // Get the most recent message from any guild
    const guildId = this.getCurrentGuildId();
    return this.currentGuildMessage.get(guildId) || null;
  }

  private getCurrentGuildId(): string {
    // Return the first available guild ID
    const guildIds = Array.from(this.currentGuildMessage.keys());
    return guildIds[0] || '';
  }

  public destroy(): void {
    this.voiceHandler.destroy();
    this.favoritesManager.close();
  }
}
