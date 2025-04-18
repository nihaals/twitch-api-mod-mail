import { REST } from "@discordjs/rest"
import {
  Routes,
  RESTPostAPIChannelMessageJSONBody,
  RESTPatchAPIChannelMessageJSONBody,
  APIButtonComponentWithCustomId,
  ButtonStyle,
  ComponentType,
  RESTPostAPIChannelThreadsJSONBody,
  ChannelType,
  Snowflake,
  RESTPatchAPIChannelJSONBody,
  APIInteractionResponseChannelMessageWithSource,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  ThreadAutoArchiveDuration,
  APIInteractionResponseDeferredMessageUpdate,
} from "discord-api-types/v10"
import { verifyKey } from "discord-interactions"

const jsonResponse = (body: object, status: number = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  })
}

/** Validates the request's signature and returns the body if it's valid */
const getDiscordInteractionRequest = async (request: Request, env: Env): Promise<string | null> => {
  const signature = request.headers.get("X-Signature-Ed25519")
  const timestamp = request.headers.get("X-Signature-Timestamp")
  if (!signature || !timestamp) {
    return null
  }
  const body = await request.text()
  if (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY)) {
    return body
  }
  return null
}

enum ButtonCustomId {
  OPEN_THREAD = "open_thread",
  ARCHIVE_THREAD = "archive_thread",
  LOCK_THREAD = "lock_thread",
}

/** Main Discord interaction handler */
const interactionsHandler = async (interaction: any, env: Env): Promise<Response> => {
  if (interaction.type === InteractionType.Ping) {
    return jsonResponse({
      type: InteractionResponseType.Pong,
    })
  } else if (interaction.type === InteractionType.MessageComponent) {
    const rest = makeRestClient(env)
    if (interaction.data.custom_id === ButtonCustomId.OPEN_THREAD) {
      const thread = await createThread(rest, interaction.channel_id)
      // @ts-ignore
      const threadId = thread.id
      await sendStartThreadMessage(rest, threadId, env.DISCORD_MODERATOR_ROLE_ID, interaction.member.user.id)
      return jsonResponse(interactionHandledResponse)
    } else if (
      interaction.data.custom_id === ButtonCustomId.ARCHIVE_THREAD ||
      interaction.data.custom_id === ButtonCustomId.LOCK_THREAD
    ) {
      if (!interaction.member.roles.includes(env.DISCORD_MODERATOR_ROLE_ID)) {
        return jsonResponse(makeInteractionResponseMessage("You are not allowed to do that"))
      }
      // If a thread is locked we shouldn't be able to receive an interaction from it
      if (interaction.channel.thread_metadata.locked) {
        return jsonResponse(makeInteractionResponseMessage("This thread is already locked"))
      }
      // If a thread is archived we shouldn't be able to receive an interaction from it and pressing the button should
      // just immediately unarchive it
      if (
        interaction.channel.thread_metadata.archived &&
        interaction.data.custom_id === ButtonCustomId.ARCHIVE_THREAD
      ) {
        return jsonResponse(makeInteractionResponseMessage("This thread is already archived"))
      }
      await sendClosedThreadMessage(
        rest,
        interaction.channel_id,
        interaction.member.user.id,
        interaction.data.custom_id
      )
      await closeThread(rest, interaction.channel_id, interaction.data.custom_id, interaction.member.user.id)
      return jsonResponse(interactionHandledResponse)
    }
  }
  return jsonResponse({}, 400)
}

/** The "open thread" button message */
const openThreadMessage = (() => {
  const button: APIButtonComponentWithCustomId = {
    type: ComponentType.Button,
    style: ButtonStyle.Primary,
    label: "Create thread",
    emoji: {
      name: "📩",
    },
    custom_id: ButtonCustomId.OPEN_THREAD,
  }
  const body: RESTPostAPIChannelMessageJSONBody = {
    content: "Create a private thread to report something to the moderators",
    components: [{ type: ComponentType.ActionRow, components: [button] }],
    allowed_mentions: {
      parse: [],
    },
  }
  return body
})()

/** Generate ephemeral interaction response message */
const makeInteractionResponseMessage = (content: string): APIInteractionResponseChannelMessageWithSource => {
  const interactionResponse: APIInteractionResponseChannelMessageWithSource = {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      content,
      allowed_mentions: {
        parse: [],
      },
      flags: MessageFlags.Ephemeral,
    },
  }
  return interactionResponse
}

/** Interaction response equivalent of a HTTP 202 */
const interactionHandledResponse: APIInteractionResponseDeferredMessageUpdate = {
  type: InteractionResponseType.DeferredMessageUpdate,
}

/** Send the message in the public channel with the "open thread" button */
const sendOpenThreadMessage = async (rest: REST, channelId: Snowflake): Promise<object> => {
  const body: RESTPostAPIChannelMessageJSONBody = openThreadMessage
  const message = await rest.post(Routes.channelMessages(channelId), {
    body,
  })
  return message as object
}

/** Send the message in the private thread with the "close thread" button and ping */
const sendStartThreadMessage = async (
  rest: REST,
  threadId: Snowflake,
  moderatorsId: Snowflake,
  authorId: Snowflake
): Promise<object> => {
  const archiveButton: APIButtonComponentWithCustomId = {
    type: ComponentType.Button,
    style: ButtonStyle.Secondary,
    label: "Archive thread",
    emoji: {
      name: "📦",
    },
    custom_id: ButtonCustomId.ARCHIVE_THREAD,
  }
  const lockButton: APIButtonComponentWithCustomId = {
    type: ComponentType.Button,
    style: ButtonStyle.Danger,
    label: "Lock thread",
    emoji: {
      name: "🔒",
    },
    custom_id: ButtonCustomId.LOCK_THREAD,
  }
  const body: RESTPostAPIChannelMessageJSONBody = {
    content: `Thread created by <@${authorId}>\n<@&${moderatorsId}> are on the way`,
    components: [{ type: ComponentType.ActionRow, components: [archiveButton, lockButton] }],
    allowed_mentions: {
      parse: [],
      roles: [moderatorsId],
      users: [authorId],
    },
  }
  const message = await rest.post(Routes.channelMessages(threadId), {
    body,
  })
  return message as object
}

/** Send the message in the private thread with the user who closed the thread */
const sendClosedThreadMessage = async (
  rest: REST,
  threadId: Snowflake,
  closerId: Snowflake,
  archiveType: ButtonCustomId.ARCHIVE_THREAD | ButtonCustomId.LOCK_THREAD
): Promise<object> => {
  const body: RESTPostAPIChannelMessageJSONBody = {
    content: `This thread has been ${archiveType === ButtonCustomId.ARCHIVE_THREAD ? "archived" : "locked"} by <@${closerId}>`,
    allowed_mentions: {
      parse: [],
    },
  }
  const message = await rest.post(Routes.channelMessages(threadId), {
    body,
  })
  return message as object
}

/** Edit the message in the public channel with the "open thread" button with the current version */
const editOpenThreadMessage = async (rest: REST, channelId: Snowflake, messageId: Snowflake): Promise<object> => {
  const body: RESTPatchAPIChannelMessageJSONBody = openThreadMessage
  const message = await rest.patch(Routes.channelMessage(channelId, messageId), {
    body,
  })
  return message as object
}

/** Get the next thread name */
const getNextThreadName = async (rest: REST, channelId: Snowflake): Promise<string> => {
  // TODO
  // Race condition
  return "mod-mail-0000"
}

/** Create the private thread used for the mod mail */
const createThread = async (rest: REST, channelId: Snowflake): Promise<object> => {
  const threadName = await getNextThreadName(rest, channelId)
  const body: RESTPostAPIChannelThreadsJSONBody = {
    name: threadName,
    type: ChannelType.PrivateThread,
    invitable: false,
    auto_archive_duration: ThreadAutoArchiveDuration.OneWeek,
  }
  const thread = await rest.post(Routes.threads(channelId), {
    body,
  })
  return thread as object
}

/** Close the private thread */
const closeThread = async (
  rest: REST,
  threadId: Snowflake,
  archiveType: ButtonCustomId.ARCHIVE_THREAD | ButtonCustomId.LOCK_THREAD,
  closerId: Snowflake
): Promise<object> => {
  const body: RESTPatchAPIChannelJSONBody = {
    archived: true,
    locked: archiveType === ButtonCustomId.LOCK_THREAD,
  }
  const thread = await rest.patch(Routes.channel(threadId), {
    body,
    headers: {
      "X-Audit-Log-Reason": `Thread ${archiveType === ButtonCustomId.ARCHIVE_THREAD ? "archived" : "locked"} by ${closerId}`,
    },
  })
  return thread as object
}

const makeRestClient = (env: Env): REST => {
  return new REST({ version: "10" }).setToken(env.DISCORD_BOT_TOKEN)
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/api/interactions") {
      const requestBody = await getDiscordInteractionRequest(request, env)
      if (!requestBody) {
        return jsonResponse({}, 401)
      }
      const interaction = JSON.parse(requestBody)
      return await interactionsHandler(interaction, env)
    } else if (request.method === "POST" && url.pathname === "/api/human/send-message") {
      // TODO: Make slash command
      const rest = makeRestClient(env)
      const message = await sendOpenThreadMessage(rest, env.DISCORD_CHANNEL_ID)
      return jsonResponse({ message }, 200)
    } else if (request.method === "POST" && url.pathname === "/api/human/edit-message") {
      // TODO: Make slash command
      const rest = makeRestClient(env)
      const message = await editOpenThreadMessage(rest, env.DISCORD_CHANNEL_ID, env.DISCORD_MESSAGE_ID)
      return jsonResponse({ message }, 200)
    } else if (request.method === "GET" && url.pathname === "/api/human/version") {
      // TODO: Make slash command
      return jsonResponse({ cf_version_info: env.CF_VERSION_METADATA }, 200)
    } else {
      return jsonResponse({}, 404)
    }
  },
}
