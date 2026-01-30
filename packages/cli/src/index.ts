#!/usr/bin/env bun
/**
 * Claudia CLI - Simple one-shot client for testing
 *
 * Usage:
 *   claudia "Hello, how are you?"
 *   claudia -p "What's 2+2?"
 *   claudia speak "Hello darling!"      # TTS via voice extension
 *   echo "Hello" | claudia
 */

const GATEWAY_URL = process.env.CLAUDIA_GATEWAY_URL || 'ws://localhost:30086/ws';

interface Message {
  type: 'req' | 'res' | 'event';
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  ok?: boolean;
  payload?: unknown;
  error?: string;
  event?: string;
}

/**
 * Generate a simple request ID
 */
function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Speak text using voice extension
 */
async function speak(text: string): Promise<void> {
  const ws = new WebSocket(GATEWAY_URL);

  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      // Subscribe to voice events
      ws.send(JSON.stringify({
        type: 'req',
        id: generateId(),
        method: 'subscribe',
        params: { events: ['voice.*'] },
      }));

      // Send speak request
      ws.send(JSON.stringify({
        type: 'req',
        id: generateId(),
        method: 'voice.speak',
        params: { text },
      }));
    };

    ws.onmessage = async (event) => {
      const msg: Message = JSON.parse(event.data as string);

      if (msg.type === 'res' && !msg.ok) {
        console.error('Error:', msg.error);
        ws.close();
        reject(new Error(msg.error));
        return;
      }

      if (msg.type === 'event') {
        if (msg.event === 'voice.speaking') {
          console.log('Speaking...');
        } else if (msg.event === 'voice.audio') {
          // Play the audio!
          const payload = msg.payload as { format: string; data: string };
          const audioBuffer = Buffer.from(payload.data, 'base64');
          const tempFile = `/tmp/claudia-speech-${Date.now()}.mp3`;
          await Bun.write(tempFile, audioBuffer);

          // Play with afplay (macOS)
          const proc = Bun.spawn(['afplay', tempFile], {
            stdout: 'ignore',
            stderr: 'ignore',
          });
          await proc.exited;

          // Clean up
          await Bun.file(tempFile).exists() && Bun.spawn(['rm', tempFile]);
        } else if (msg.event === 'voice.done') {
          console.log('Done.');
          ws.close();
          resolve();
        } else if (msg.event === 'voice.error') {
          const payload = msg.payload as { error: string };
          console.error('Voice error:', payload.error);
          ws.close();
          reject(new Error(payload.error));
        }
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      reject(error);
    };
  });
}

/**
 * Main CLI function
 */
async function main(): Promise<void> {
  // Get args
  const args = process.argv.slice(2);

  // Check for speak command
  if (args[0] === 'speak') {
    const text = args.slice(1).join(' ');
    if (!text) {
      console.error('Usage: claudia speak "text to speak"');
      process.exit(1);
    }
    await speak(text);
    return;
  }

  // Get prompt from args or stdin
  let prompt = args.join(' ');

  // Handle -p flag (just ignore it, for compatibility with claude -p)
  if (prompt.startsWith('-p ')) {
    prompt = prompt.slice(3);
  }

  // If no args, try to read from stdin
  if (!prompt) {
    const stdin = await Bun.stdin.text();
    prompt = stdin.trim();
  }

  if (!prompt) {
    console.error('Usage: claudia "your message here"');
    console.error('       claudia speak "text to speak"');
    console.error('       echo "your message" | claudia');
    process.exit(1);
  }

  // Connect to gateway
  const ws = new WebSocket(GATEWAY_URL);

  let responseText = '';
  let isComplete = false;

  ws.onopen = () => {
    // Subscribe to session events
    const subscribeMsg: Message = {
      type: 'req',
      id: generateId(),
      method: 'subscribe',
      params: { events: ['session.*'] },
    };
    ws.send(JSON.stringify(subscribeMsg));

    // Send the prompt
    const promptMsg: Message = {
      type: 'req',
      id: generateId(),
      method: 'session.prompt',
      params: { content: prompt },
    };
    ws.send(JSON.stringify(promptMsg));
  };

  ws.onmessage = (event) => {
    const msg: Message = JSON.parse(event.data as string);

    if (msg.type === 'event') {
      const payload = msg.payload as Record<string, unknown>;

      switch (msg.event) {
        case 'session.content_block_start': {
          // New content block starting
          const block = payload.content_block as { type: string } | undefined;
          if (block?.type === 'text') {
            // Ready for text
          }
          break;
        }

        case 'session.content_block_delta': {
          // Streaming text delta
          const delta = payload.delta as { type: string; text?: string } | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            process.stdout.write(delta.text);
            responseText += delta.text;
          }
          break;
        }

        case 'session.message_stop': {
          // Message complete
          isComplete = true;
          if (responseText && !responseText.endsWith('\n')) {
            console.log(); // Add newline if needed
          }
          ws.close();
          break;
        }

        case 'session.message_delta': {
          // Check for stop reason
          const delta = payload.delta as { stop_reason?: string } | undefined;
          if (delta?.stop_reason) {
            // Response ending
          }
          break;
        }
      }
    } else if (msg.type === 'res' && !msg.ok) {
      console.error('Error:', msg.error);
      ws.close();
      process.exit(1);
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    process.exit(1);
  };

  ws.onclose = () => {
    if (!isComplete && !responseText) {
      console.error('Connection closed before response');
      process.exit(1);
    }
    process.exit(0);
  };

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\nInterrupted');
    ws.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
