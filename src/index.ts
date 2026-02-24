import { ChatInputCommandInteraction, Client, Events, GatewayIntentBits, Guild, Message, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { config } from 'dotenv';
import { handlePlay, handlePause, handleResume, handleSkip, handleQueue, handleNukkumaan, handleHelp, handleCleanup, checkAndLeaveIfNeeded } from './commands/play';
import { startWebServer } from './web/server';
import { createDiscordLoginLink } from './web/auth';

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
    .setDescription('Toista YouTube-osoite')
    .addStringOption(option =>
      option
        .setName('url')
        .setDescription('YouTube-osoite')
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
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
}

async function interactionReply(interaction: ChatInputCommandInteraction, payload: any) {
  const content = typeof payload === 'string' ? { content: payload } : payload;
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(content);
  }
  return interaction.reply(content);
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
  const baseUrl = getWebBaseUrl();
  if (!baseUrl) {
    await interaction.reply({
      content: 'WEB_BASE_URL puuttuu tai on virheellinen botin ympäristöasetuksissa.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.guildId) {
    await interaction.reply({
      content: 'Suorita tämä komento Discord-palvelimellasi.',
      flags: MessageFlags.Ephemeral,
    });
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
  
  try {
    await interaction.user.send(
      `Epun kertakäyttöinen verkkokirjautumislinkki:\n${loginUrl}\n\nLinkki toimii kerran ja vanhenee <t:${expiresAtUnix}:R>`
    );
    await interaction.reply({
      content: 'Lähetin sinulle yksityisviestillä kertakäyttöisen kirjautumislinkin.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error('Failed to DM web login link:', error);
    await interaction.reply({
      content: 'Yksityisviestin lähetys epäonnistui. Tarkista yksityisyysasetukset ja yritä uudelleen.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

client.once(Events.ClientReady, async () => {
  console.log('Bot is ready!');

  await registerGuildCommands(client);
  
  // Start web UI server
  startWebServer(client);
  
  // Start periodic check every 15 minutes for inactive voice connections
  setInterval(() => {
    console.log('Running periodic cleanup check...');
    checkAndLeaveIfNeeded(client);
  }, 15 * 60 * 1000); // 15 minutes
});

// Handle button interactions
client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
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
