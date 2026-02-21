#!/usr/bin/env bun
/**
 * Test Libby's processing pipeline without the gateway.
 *
 * Usage:
 *   bun scripts/test-libby.ts                    # Process up to 3 conversations
 *   bun scripts/test-libby.ts --dry-run           # Format transcripts only, no API calls
 *   bun scripts/test-libby.ts --batch 1           # Process just 1 conversation
 *   bun scripts/test-libby.ts --conversation 42   # Process specific conversation ID
 */

import {
  getDb,
  getReadyConversations,
  getEntriesForConversation,
  updateConversationStatus,
} from "../extensions/memory/src/db";
import { formatTranscript } from "../extensions/memory/src/transcript-formatter";
import { processReadyConversations, type LibbyConfig } from "../extensions/memory/src/libby";

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const batchIdx = args.indexOf("--batch");
const batchSize = batchIdx !== -1 ? Number(args[batchIdx + 1]) : 3;
const convIdx = args.indexOf("--conversation");
const specificConvId = convIdx !== -1 ? Number(args[convIdx + 1]) : null;

// Init DB
getDb();

const log = (level: string, msg: string) => console.log(`  [${level}] ${msg}`);

if (specificConvId) {
  // Preview a specific conversation's transcript
  console.log(`\n  Formatting conversation ${specificConvId}...\n`);

  const entries = getEntriesForConversation(specificConvId);
  if (entries.length === 0) {
    console.log("  No entries found for this conversation.");
    process.exit(1);
  }

  // Get conversation row
  const conv = getDb()
    .query(
      `SELECT
        id, session_id AS sessionId, source_file AS sourceFile,
        first_message_at AS firstMessageAt,
        last_message_at AS lastMessageAt, entry_count AS entryCount,
        status, strategy, summary, processed_at AS processedAt,
        created_at AS createdAt
      FROM memory_conversations WHERE id = ?`,
    )
    .get(specificConvId) as any;

  if (!conv) {
    console.log("  Conversation not found.");
    process.exit(1);
  }

  const transcript = formatTranscript(conv, entries, "America/New_York");

  console.log("  === Transcript Preview ===\n");
  console.log(transcript.text);
  console.log("\n  === Metadata ===");
  console.log(`  Date: ${transcript.date}`);
  console.log(`  Time: ${transcript.timeRange}`);
  console.log(`  CWD: ${transcript.primaryCwd}`);
  console.log(`  Entries: ${transcript.entryCount}`);
  console.log(`  Chars: ${transcript.text.length}`);

  if (!dryRun) {
    console.log("\n  === Calling Libby (via gateway) ===\n");

    const gatewayUrl = process.env.CLAUDIA_GATEWAY_URL || "ws://localhost:30086/ws";

    // Temporarily mark as ready if needed
    if (conv.status !== "ready") {
      console.log(`  (Conversation status is '${conv.status}', temporarily marking as 'ready')`);
      updateConversationStatus(conv.id, "ready");
    }

    const config: LibbyConfig = {
      gatewayUrl,
      model: "claude-sonnet-4-6",
      batchSize: 1,
      timezone: "America/New_York",
      minConversationMessages: 1, // Don't skip for testing
    };

    const result = await processReadyConversations(config, null, log);
    console.log("\n  === Result ===");
    console.log(JSON.stringify(result, null, 2));
  }
} else {
  // Process a batch of ready conversations
  const ready = getReadyConversations();
  console.log(`\n  Ready conversations: ${ready.length}`);
  console.log(`  Batch size: ${batchSize}`);
  console.log(`  Dry run: ${dryRun}`);

  if (ready.length === 0) {
    console.log("  Nothing to process.\n");
    process.exit(0);
  }

  // Show what we're about to process
  const batch = ready.slice(0, batchSize);
  console.log("\n  Conversations to process:");
  for (const conv of batch) {
    console.log(
      `    #${conv.id}: ${conv.sourceFile} (${conv.entryCount} msgs, ${conv.firstMessageAt.slice(0, 10)})`,
    );
  }

  if (dryRun) {
    console.log("\n  === Dry Run: Formatting Transcripts ===\n");
    for (const conv of batch) {
      const entries = getEntriesForConversation(conv.id);
      const transcript = formatTranscript(conv, entries, "America/New_York");
      console.log(`  --- Conversation #${conv.id} ---`);
      console.log(`  Date: ${transcript.date} ${transcript.timeRange}`);
      console.log(`  CWD: ${transcript.primaryCwd}`);
      console.log(`  Entries: ${transcript.entryCount}, Chars: ${transcript.text.length}`);
      console.log(`  First 500 chars:\n${transcript.text.slice(0, 500)}\n`);
    }
  } else {
    const gatewayUrl = process.env.CLAUDIA_GATEWAY_URL || "ws://localhost:30086/ws";

    console.log(`\n  === Processing with Libby (gateway: ${gatewayUrl}) ===\n`);

    const config: LibbyConfig = {
      gatewayUrl,
      model: "claude-sonnet-4-6",
      batchSize,
      timezone: "America/New_York",
      minConversationMessages: 5,
    };

    const result = await processReadyConversations(config, null, log);

    console.log("\n  === Summary ===");
    console.log(`  Processed: ${result.processed}`);
    console.log(`  Skipped: ${result.skipped}`);
    console.log(`  Errors: ${result.errors}`);

    for (const detail of result.details) {
      console.log(`\n  #${detail.conversationId} (${detail.date}): ${detail.status}`);
      if (detail.summary) console.log(`    ${detail.summary}`);
      if (detail.filesWritten) console.log(`    Files: ${detail.filesWritten.join(", ")}`);
      if (detail.error) console.log(`    Error: ${detail.error}`);
    }
  }
}

console.log("\n  Done! ✓\n");
