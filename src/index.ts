import { ChatInputCommandInteraction, Client, DiscordAPIError, Events, GatewayIntentBits, Guild, Message, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { config } from 'dotenv';
import { handlePlay, handlePause, handleResume, handleSkip, handleQueue, handleNukkumaan, handleHelp, handleCleanup, checkAndLeaveIfNeeded } from './commands/play';
import { startWebServer } from './web/server';
import { createDiscordLoginLink } from './web/auth';
import { DEFAULT_VOICE_KEYWORDS, executeVoiceCommand } from './voice/commandExecutor';
import { setDiscordVoiceCommandHandler, startDefaultDiscordVoiceReceiver } from './voice/discordVoiceRuntime';
import { loadVoiceKeywordMap } from './web/voiceKeywords';
import { flushUsageLog, logUsage, type UsageLogFields } from './usageLog';

config();

function clampNegativeTimeouts() {
  const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
    if (typeof timeout === 'number' && timeout < 0) {
      // Match Node's native fallback behavior for negative timeout values.
      return originalSetTimeout(handler, 1, ...args);
    }
    return originalSetTimeout(handler, timeout as number, ...args);
  }) as typeof setTimeout;
}

clampNegativeTimeouts();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const WEB_LOGIN_COMMAND = 'web-login';
const PLAY_COMMAND = 'play';
const PAUSE_COMMAND = 'pause';
const RESUME_COMMAND = 'resume';
const SKIP_COMMAND = 'skip';
const QUEUE_COMMAND = 'queue';
const HELP_COMMAND = 'help';
const CLEANUP_COMMAND = 'cleanup';
const NUKKUMAAN_COMMAND = 'nukkumaan';

const GUILD_COMMANDS = [
  new SlashCommandBuilder()
    .setName(WEB_LOGIN_COMMAND)
    .setDescription('Saat kertakäyttöisen kirjautumislinkin yksityisviestillä'),
  new SlashCommandBuilder()
    .setName(PLAY_COMMAND)
    .setDescription('Toista kappale tai soittolista YouTubesta, SoundCloudista tai Spotifysta')
    .addStringOption(option =>
      option
        .setName('url')
        .setDescription('Linkki tai hakusana')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName(PAUSE_COMMAND)
    .setDescription('Laita toisto tauolle'),
  new SlashCommandBuilder()
    .setName(RESUME_COMMAND)
    .setDescription('Jatka toistoa'),
  new SlashCommandBuilder()
    .setName(SKIP_COMMAND)
    .setDescription('Ohita nykyinen kappale'),
  new SlashCommandBuilder()
    .setName(QUEUE_COMMAND)
    .setDescription('Näytä nykyinen jono'),
  new SlashCommandBuilder()
    .setName(HELP_COMMAND)
    .setDescription('Näytä komento-ohje'),
  new SlashCommandBuilder()
    .setName(CLEANUP_COMMAND)
    .setDescription('Pakota voice-yhteyksien siivous')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName(NUKKUMAAN_COMMAND)
    .setDescription('Nollaa botti ja poistu voice-kanavilta')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(cmd => cmd.toJSON());

function envBool(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isUnknownInteractionError(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === 10062;
}

async function safeDeferReply(interaction: ChatInputCommandInteraction, ephemeral = false): Promise<boolean> {
  try {
    if (ephemeral) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
      await interaction.deferReply();
    }
    return true;
  } catch (error) {
    if (isUnknownInteractionError(error)) {
      console.warn(`Ignored expired interaction during deferReply (id=${interaction.id})`);
      return false;
    }
    throw error;
  }
}

async function safeEditReply(interaction: ChatInputCommandInteraction, content: string): Promise<boolean> {
  try {
    await interaction.editReply(content);
    return true;
  } catch (error) {
    if (isUnknownInteractionError(error)) {
      console.warn(`Ignored expired interaction during editReply (id=${interaction.id})`);
      return false;
    }
    throw error;
  }
}

function getWebBaseUrl(): string | null {
  const baseUrl = process.env.WEB_BASE_URL?.trim();
  if (!baseUrl) return null;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function buildWebLoginUrl(baseUrl: string, loginToken: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('login_token', loginToken);

  if (envBool(process.env.WEB_REQUIRE_TOKEN)) {
    const accessToken = process.env.WEB_ACCESS_TOKEN?.trim();
    if (accessToken) {
      url.searchParams.set('token', accessToken);
    }
  }

  return url.toString();
}

function displayNameForUser(user: { globalName?: string | null; username?: string | null } | null | undefined): string | null {
  return user?.globalName || user?.username || null;
}

function interactionUsageContext(interaction: any): UsageLogFields {
  return {
    source: 'discord',
    guildId: interaction.guildId ?? null,
    guildName: interaction.guild?.name ?? null,
    channelId: interaction.channelId ?? null,
    userId: interaction.user?.id ?? null,
    username: displayNameForUser(interaction.user),
  };
}

async function resolveTargetGuild(client: Client): Promise<Guild | null> {
  const targetGuildId = process.env.WEB_LOGIN_GUILD_ID || process.env.DISCORD_GUILD_ID;
  if (targetGuildId) {
    try {
      return await client.guilds.fetch(targetGuildId);
    } catch {
      return null;
    }
  }

  const firstGuild = client.guilds.cache.first();
  if (!firstGuild) return null;
  try {
    return await client.guilds.fetch(firstGuild.id);
  } catch {
    return null;
  }
}

async function registerGuildCommands(client: Client) {
  const guild = await resolveTargetGuild(client);
  if (!guild) {
    console.warn('Could not resolve target guild for slash command registration.');
    return;
  }

  try {
    await guild.commands.set(GUILD_COMMANDS);
    console.log(`Registered ${GUILD_COMMANDS.length} slash commands in guild: ${guild.name}`);
    logUsage('discord.commands_registered', {
      source: 'discord',
      guildId: guild.id,
      guildName: guild.name,
      commandCount: GUILD_COMMANDS.length,
    });
  } catch (error) {
    console.error('Failed to register slash commands:', error);
    logUsage('discord.commands_register_failed', {
      source: 'discord',
      guildId: guild.id,
      guildName: guild.name,
      error,
    });
  }
}

async function interactionReply(interaction: ChatInputCommandInteraction, payload: any) {
  const content = typeof payload === 'string' ? { content: payload } : payload;
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.followUp(content);
    }
    return await interaction.reply(content);
  } catch (error) {
    if (isUnknownInteractionError(error)) {
      console.warn(`Ignored expired interaction during reply/followUp (id=${interaction.id})`);
      return null;
    }
    throw error;
  }
}

async function interactionToMessage(interaction: ChatInputCommandInteraction): Promise<Message> {
  let guildMember: any = null;
  if (interaction.guild) {
    try {
      guildMember = await interaction.guild.members.fetch(interaction.user.id);
    } catch (error) {
      console.warn(
        `Failed to fetch guild member for slash command user=${interaction.user.id} guild=${interaction.guildId}`,
        error
      );
    }
  }

  const fallbackMember: any = {
    permissions: {
      has: (permission: any) => !!interaction.memberPermissions?.has(permission),
    },
    voice: { channel: null },
  };

  const member = (guildMember || interaction.member || fallbackMember) as any;
  if (!member.permissions?.has) member.permissions = fallbackMember.permissions;
  if (!member.voice) member.voice = fallbackMember.voice;

  return {
    guild: interaction.guild!,
    member: member as Message['member'],
    author: interaction.user as Message['author'],
    channel: interaction.channel as Message['channel'],
    client: interaction.client,
    reply: (payload: any) => interactionReply(interaction, payload),
  } as unknown as Message;
}

async function handleWebLoginCommand(interaction: ChatInputCommandInteraction) {
  try {
    const deferred = await safeDeferReply(interaction, true);
    if (!deferred) return;
  } catch (error) {
    console.warn('Failed to defer /web-login reply', error);
    return;
  }

  const baseUrl = getWebBaseUrl();
  if (!baseUrl) {
    logUsage('web_login.failed', {
      ...interactionUsageContext(interaction),
      reason: 'invalid_web_base_url',
      commandName: WEB_LOGIN_COMMAND,
    });
    await safeEditReply(interaction, 'WEB_BASE_URL puuttuu tai on virheellinen botin ympäristöasetuksissa.');
    return;
  }

  if (!interaction.guildId) {
    logUsage('web_login.failed', {
      ...interactionUsageContext(interaction),
      reason: 'missing_guild',
      commandName: WEB_LOGIN_COMMAND,
    });
    await safeEditReply(interaction, 'Suorita tämä komento Discord-palvelimellasi.');
    return;
  }

  const { token, expiresAt } = await createDiscordLoginLink(
    interaction.user.id,
    interaction.user.globalName || interaction.user.username,
    interaction.guildId,
    !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  );
  const loginUrl = buildWebLoginUrl(baseUrl, token);
  const expiresAtUnix = Math.floor(expiresAt / 1000);
  const replyMessage =
    `Epun kertakäyttöinen verkkokirjautumislinkki:\n${loginUrl}\n\n` +
    `Linkki toimii kerran ja vanhenee <t:${expiresAtUnix}:R>`;
  
  try {
    await interaction.user.send(replyMessage);
    await safeEditReply(interaction, `${replyMessage}\n\nLähetin saman linkin myös yksityisviestillä.`);
    logUsage('web_login.created', {
      ...interactionUsageContext(interaction),
      commandName: WEB_LOGIN_COMMAND,
      expiresAt: new Date(expiresAt),
      dmSent: true,
    });
  } catch (error) {
    console.error('Failed to DM web login link:', error);
    await safeEditReply(interaction, `${replyMessage}\n\nYksityisviestin lähetys epäonnistui, mutta tämä viesti näkyy vain sinulle.`);
    logUsage('web_login.created', {
      ...interactionUsageContext(interaction),
      commandName: WEB_LOGIN_COMMAND,
      expiresAt: new Date(expiresAt),
      dmSent: false,
      dmError: error,
    });
  }
}

client.once(Events.ClientReady, async () => {
  console.log('Bot is ready!');
  logUsage('bot.ready', {
    source: 'discord',
    botUserId: client.user?.id ?? null,
    botTag: client.user?.tag ?? null,
    guildCount: client.guilds.cache.size,
  });

  if (envBool(process.env.REGISTER_SLASH_COMMANDS_ON_STARTUP)) {
    await registerGuildCommands(client);
  } else {
    console.log('Slash command registration skipped (REGISTER_SLASH_COMMANDS_ON_STARTUP is not enabled).');
    logUsage('discord.commands_registration_skipped', {
      source: 'discord',
      reason: 'startup_registration_disabled',
    });
  }

  setDiscordVoiceCommandHandler(async ({ guildId, userId, transcript }) => {
    const startedAt = Date.now();
    let voiceKeywordMap = DEFAULT_VOICE_KEYWORDS;
    try {
      voiceKeywordMap = { ...DEFAULT_VOICE_KEYWORDS, ...await loadVoiceKeywordMap() };
    } catch (error) {
      console.error('[discord-voice] Failed to load persisted voice keywords, using defaults:', error);
    }

    const user = await client.users.fetch(userId).catch(() => null);
    const requestedBy = user?.globalName || user?.username || `Discord Voice ${userId}`;
    try {
      const result = await executeVoiceCommand(client, guildId, requestedBy, transcript, voiceKeywordMap);
      console.log(
        `[discord-voice] command guild=${guildId} user=${userId} intent=${result.intent} `
        + `ok=${result.ok} status=${result.status} message="${result.message}" `
        + `${result.resolvedUrl ? `url=${result.resolvedUrl}` : ''}`
      );
      logUsage('voice.command', {
        source: 'discord_voice',
        guildId,
        userId,
        username: requestedBy,
        transcript,
        intent: result.intent,
        ok: result.ok,
        status: result.status,
        message: result.message,
        queuedTitle: result.queuedTitle,
        resolvedUrl: result.resolvedUrl,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logUsage('voice.command', {
        source: 'discord_voice',
        guildId,
        userId,
        username: requestedBy,
        transcript,
        ok: false,
        error,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  });

  await startDefaultDiscordVoiceReceiver(client);
  
  // Start web UI server
  startWebServer(client);
  
  // Start periodic check every 15 minutes for inactive voice connections
  setInterval(() => {
    console.log('Running periodic cleanup check...');
    checkAndLeaveIfNeeded(client);
  }, 15 * 60 * 1000); // 15 minutes
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  console.warn(
    `[gateway] shardDisconnect id=${shardId} code=${event.code} wasClean=${event.wasClean} `
    + `reason=${event.reason || 'n/a'}`
  );
});

client.on(Events.ShardReconnecting, (shardId) => {
  console.warn(`[gateway] shardReconnecting id=${shardId}`);
});

client.on(Events.ShardResume, (replayedEvents, shardId) => {
  console.log(`[gateway] shardResume id=${shardId} replayedEvents=${replayedEvents}`);
});

client.on(Events.ShardReady, (shardId) => {
  console.log(`[gateway] shardReady id=${shardId}`);
});

// Handle button interactions
client.on('interactionCreate', async (interaction) => {
  let activeUsageContext: UsageLogFields = {};
  try {
    if (interaction.isChatInputCommand()) {
      activeUsageContext = {
        ...interactionUsageContext(interaction),
        commandName: interaction.commandName,
      };
      logUsage('discord.slash_command', activeUsageContext);
      switch (interaction.commandName) {
        case WEB_LOGIN_COMMAND:
          await handleWebLoginCommand(interaction);
          return;
        case PLAY_COMMAND: {
          const url = interaction.options.getString('url', true);
          await interaction.deferReply();
          await handlePlay(await interactionToMessage(interaction), url);
          return;
        }
        case PAUSE_COMMAND:
          await interaction.deferReply();
          handlePause(await interactionToMessage(interaction));
          return;
        case RESUME_COMMAND:
          await interaction.deferReply();
          handleResume(await interactionToMessage(interaction));
          return;
        case SKIP_COMMAND:
          await interaction.deferReply();
          handleSkip(await interactionToMessage(interaction));
          return;
        case QUEUE_COMMAND:
          await interaction.deferReply();
          handleQueue(await interactionToMessage(interaction));
          return;
        case HELP_COMMAND:
          await interaction.deferReply();
          handleHelp(await interactionToMessage(interaction));
          return;
        case CLEANUP_COMMAND:
          await interaction.deferReply();
          handleCleanup(await interactionToMessage(interaction));
          return;
        case NUKKUMAAN_COMMAND:
          await interaction.deferReply();
          handleNukkumaan(await interactionToMessage(interaction));
          return;
      }
    }

    if (!interaction.isButton()) return;

    activeUsageContext = {
      ...interactionUsageContext(interaction),
      customId: interaction.customId,
    };
    logUsage('discord.button', activeUsageContext);

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
  } catch (error) {
    console.error('interactionCreate handler failed:', error);
    logUsage('discord.interaction_failed', {
      ...activeUsageContext,
      error,
    });

    if (!interaction.isRepliable()) return;

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: 'Komennon käsittely epäonnistui.',
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: 'Komennon käsittely epäonnistui.',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      // Ignore follow-up failures (for example, expired interactions).
    }
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
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down gracefully...');
  logUsage('bot.shutdown', { source: 'process', signal });

  client.destroy();
  await flushUsageLog();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

client.login(process.env.DISCORD_TOKEN);
