/**
 * Sentence Chunker
 *
 * Splits streaming text into sentence-level chunks for TTS input.
 * Fed character-by-character (via content_block_delta text), it accumulates
 * text and emits complete sentences when boundary punctuation is detected.
 */

// Sentence-ending punctuation followed by whitespace (or end of common patterns)
const SENTENCE_BOUNDARY = /([.!?]+)\s+/g;
// Newline boundaries (paragraph breaks)
const NEWLINE_BOUNDARY = /\n\s*\n/g;

export class SentenceChunker {
  private buffer = '';

  /**
   * Feed new text from a streaming delta.
   * Returns an array of complete sentences ready to send to TTS.
   * Incomplete sentences stay in the buffer until more text arrives.
   */
  feed(text: string): string[] {
    this.buffer += text;
    const sentences: string[] = [];

    // Try to split on sentence boundaries or paragraph breaks
    // We combine both patterns and find the earliest split point iteratively
    let lastIndex = 0;

    // Reset regex state
    SENTENCE_BOUNDARY.lastIndex = 0;
    NEWLINE_BOUNDARY.lastIndex = 0;

    // Find all split points
    const splitPoints: Array<{ index: number; endIndex: number }> = [];

    let match: RegExpExecArray | null;

    while ((match = SENTENCE_BOUNDARY.exec(this.buffer)) !== null) {
      splitPoints.push({
        index: match.index + match[1].length, // after the punctuation
        endIndex: match.index + match[0].length, // after the whitespace
      });
    }

    while ((match = NEWLINE_BOUNDARY.exec(this.buffer)) !== null) {
      splitPoints.push({
        index: match.index,
        endIndex: match.index + match[0].length,
      });
    }

    // Sort by position
    splitPoints.sort((a, b) => a.index - b.index);

    // Extract sentences
    for (const point of splitPoints) {
      if (point.endIndex <= lastIndex) continue; // overlapping with previous split
      const sentence = this.buffer.slice(lastIndex, point.index).trim();
      if (sentence.length > 0) {
        sentences.push(sentence);
      }
      lastIndex = point.endIndex;
    }

    // Keep the remainder in the buffer
    this.buffer = this.buffer.slice(lastIndex);

    return sentences;
  }

  /** Get any remaining text that hasn't formed a complete sentence */
  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = '';
    return remaining.length > 0 ? remaining : null;
  }

  /** Clear the buffer */
  reset(): void {
    this.buffer = '';
  }
}
