/**
 * Claudia iMessage Extension
 *
 * Bridges iMessage to Claudia via the `imsg` CLI tool.
 * Uses JSON-RPC over stdio to watch for new messages and send replies.
 *
 * Features:
 * - Watches for incoming messages using `imsg rpc`
 * - Filters by allowed senders (for safety!)
 * - Routes responses back via source routing
 * - Sends replies using the same chat_id
 */

import type { ClaudiaExtension, ExtensionContext, GatewayEvent } from '@claudia/shared';
import { ImsgRpcClient, type ImsgMessage } from './imsg-client';

// ============================================================================
// Configuration
// ============================================================================

export interface IMessageConfig {
  /** Path to imsg CLI (default: "imsg") */
  cliPath?: string;
  /** Path to Messages database */
  dbPath?: string;
  /** Allowed sender addresses - ONLY process messages from these senders */
  allowedSenders?: string[];
  /** Include attachments in messages */
  includeAttachments?: boolean;
  /** Include recent history as context (number of messages, 0 = disabled) */
  historyLimit?: number;
}

const DEFAULT_CONFIG: IMessageConfig = {
  cliPath: 'imsg',
  dbPath: undefined, // Uses default ~/Library/Messages/chat.db
  allowedSenders: [], // Empty = process no messages (safe default!)
  includeAttachments: false,
  historyLimit: 0,
};

// ============================================================================
// iMessage Extension
// ============================================================================

export function createIMessageExtension(config: IMessageConfig = {}): ClaudiaExtension {
  const cfg: IMessageConfig = { ...DEFAULT_CONFIG, ...config };

  let client: ImsgRpcClient | null = null;
  let ctx: ExtensionContext | null = null;
  let lastRowId: number | null = null;

  // Track pending responses by source (so we can send replies)
  const pendingResponses = new Map<string, { chatId: number; text: string }>();

  /**
   * Check if a sender is allowed
   */
  function isAllowedSender(sender: string): boolean {
    if (!cfg.allowedSenders?.length) {
      return false; // No allowed senders = deny all (safe default)
    }
    return cfg.allowedSenders.some((allowed) => {
      // Exact match
      if (sender === allowed) return true;
      // Normalize phone numbers (strip +1, etc.)
      const normalizedSender = sender.replace(/^\+1/, '').replace(/\D/g, '');
      const normalizedAllowed = allowed.replace(/^\+1/, '').replace(/\D/g, '');
      return normalizedSender === normalizedAllowed;
    });
  }

  /**
   * Build the source identifier for routing
   * Format: imessage/{chat_id}
   */
  function buildSource(chatId: number): string {
    return `imessage/${chatId}`;
  }

  /**
   * Handle an incoming message
   */
  async function handleMessage(message: ImsgMessage): Promise<void> {
    ctx?.log.info(`Received message from ${message.sender} in chat ${message.chat_id}`);

    // Filter: only process messages from allowed senders
    if (!isAllowedSender(message.sender)) {
      ctx?.log.info(`Ignoring message from ${message.sender} (not in allowed list)`);
      return;
    }

    // Filter: skip our own messages
    if (message.is_from_me) {
      ctx?.log.info('Ignoring message from self');
      return;
    }

    // Filter: skip empty messages
    if (!message.text?.trim()) {
      ctx?.log.info('Ignoring empty message');
      return;
    }

    ctx?.log.info(`Processing message: "${message.text?.substring(0, 50)}..."`);

    // Track last rowid for resuming
    lastRowId = message.rowid;

    // Build source for routing
    const source = buildSource(message.chat_id);

    // Store chat info for response routing
    pendingResponses.set(source, {
      chatId: message.chat_id,
      text: '',
    });

    // Emit event to trigger gateway prompt
    // The gateway will send this to the session with the source attached
    ctx?.emit('imessage.message', {
      source,
      chatId: message.chat_id,
      sender: message.sender,
      text: message.text,
      isGroup: message.is_group,
      participants: message.participants,
    });

    // Also emit a prompt request that the gateway can handle
    // This uses the internal event bus to request a prompt
    ctx?.emit('imessage.prompt_request', {
      content: message.text,
      source,
      metadata: {
        chatId: message.chat_id,
        sender: message.sender,
        isGroup: message.is_group,
      },
    });
  }

  return {
    id: 'imessage',
    name: 'iMessage',
    methods: ['imessage.send', 'imessage.status', 'imessage.chats'],
    events: ['imessage.message', 'imessage.sent', 'imessage.error', 'imessage.prompt_request'],
    sourceRoutes: ['imessage'], // Handle all "imessage/*" sources

    async start(context: ExtensionContext) {
      ctx = context;
      ctx.log.info('Starting iMessage extension...');

      // Merge config from context
      if (context.config) {
        Object.assign(cfg, context.config);
      }

      ctx.log.info(`Allowed senders: ${cfg.allowedSenders?.join(', ') || '(none - will ignore all messages)'}`);

      // Create and start the imsg client
      client = new ImsgRpcClient({
        cliPath: cfg.cliPath,
        dbPath: cfg.dbPath,
        onMessage: handleMessage,
        onError: (err) => {
          ctx?.log.error(`imsg error: ${err.message}`);
          ctx?.emit('imessage.error', { error: err.message });
        },
        log: ctx.log,
      });

      await client.start();

      // List chats to verify connection
      try {
        const chats = await client.listChats(5);
        ctx.log.info(`Connected! Found ${chats.length} recent chats`);
        for (const chat of chats) {
          ctx.log.info(`  [${chat.id}] ${chat.name || chat.identifier} (${chat.participants.join(', ')})`);
        }
      } catch (err) {
        ctx.log.error(`Failed to list chats: ${err}`);
      }

      // Subscribe to watch for new messages
      try {
        const subId = await client.subscribe({
          attachments: cfg.includeAttachments,
        });
        ctx.log.info(`Subscribed to message watch (subscription: ${subId})`);
      } catch (err) {
        ctx.log.error(`Failed to subscribe: ${err}`);
      }

      ctx.log.info('iMessage extension started');
    },

    async stop() {
      ctx?.log.info('Stopping iMessage extension...');
      await client?.stop();
      client = null;
      ctx = null;
    },

    async handleMethod(method: string, params: Record<string, unknown>) {
      switch (method) {
        case 'imessage.send': {
          if (!client) throw new Error('iMessage client not running');

          const text = params.text as string;
          const chatId = params.chatId as number | undefined;
          const to = params.to as string | undefined;

          if (!text) throw new Error('Missing "text" parameter');
          if (!chatId && !to) throw new Error('Must provide "chatId" or "to"');

          await client.send({ text, chatId, to });
          ctx?.emit('imessage.sent', { text, chatId, to });
          return { ok: true };
        }

        case 'imessage.status': {
          return {
            running: !!client,
            allowedSenders: cfg.allowedSenders,
            lastRowId,
          };
        }

        case 'imessage.chats': {
          if (!client) throw new Error('iMessage client not running');
          const limit = (params.limit as number) || 20;
          const chats = await client.listChats(limit);
          return { chats };
        }

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },

    /**
     * Handle response routing - send replies back to iMessage
     */
    async handleSourceResponse(source: string, event: GatewayEvent) {
      // Extract chat_id from source (e.g., "imessage/2329" -> 2329)
      const chatId = parseInt(source.split('/')[1], 10);
      if (isNaN(chatId)) {
        ctx?.log.error(`Invalid source format: ${source}`);
        return;
      }

      // Only process message_stop events (final response)
      if (event.type !== 'session.message_stop') {
        return;
      }

      // Get the accumulated response text from the gateway
      const payload = event.payload as Record<string, unknown>;
      const responseText = payload.responseText as string | undefined;

      if (!responseText?.trim()) {
        ctx?.log.warn('No response text to send');
        pendingResponses.delete(source);
        return;
      }

      ctx?.log.info(`Sending reply to chat ${chatId}: "${responseText.substring(0, 50)}..."`);

      try {
        await client?.send({
          chatId,
          text: responseText,
        });
        ctx?.emit('imessage.sent', { chatId, text: responseText });
      } catch (err) {
        ctx?.log.error(`Failed to send reply: ${err}`);
        ctx?.emit('imessage.error', { error: String(err), chatId });
      }

      pendingResponses.delete(source);
    },

    health() {
      return {
        ok: !!client,
        details: {
          running: !!client,
          allowedSenders: cfg.allowedSenders?.length ?? 0,
          lastRowId,
        },
      };
    },
  };
}

// Default export
export default createIMessageExtension;

// Re-export client types
export type { ImsgMessage, ImsgChat } from './imsg-client';
