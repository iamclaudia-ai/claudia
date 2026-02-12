---
name: chunking-text-for-tts
description: "MUST be used when breaking down large text content into TTS-appropriate chunks. Intelligently splits stories, meditations, or long content while preserving emotion markup, maintaining narrative flow, and optimizing for Cartesia voice synthesis. Handles sentence boundaries, emotion tags, and chunk size limits. Triggers on: chunk text, split for TTS, break up text, TTS chunks, divide content, split story, chunk meditation, text chunking, prepare for voice, TTS processing, voice synthesis prep."
---

# Chunking Text for TTS

Intelligently break down large text content into optimal chunks for TTS processing while preserving emotion markup and narrative flow.

## When to Use

- User has long content that needs TTS processing
- Stories or meditations exceed single TTS request limits
- Content needs to be split while preserving emotion markup
- User wants to optimize text for voice synthesis
- Large content needs sentence-level chunking
- Preparing content for Cartesia or other TTS services

## Chunking Strategies

### Sentence-Based Chunking (Recommended)
- Split at sentence boundaries (periods, exclamation marks, question marks)
- Preserve emotion markup within each sentence
- Maintain natural pauses between chunks
- Ideal for stories and meditations

### Paragraph-Based Chunking
- Split at paragraph breaks
- Good for longer content sections
- Maintains thematic coherence
- Useful for chapter-like divisions

### Length-Based Chunking
- Split at character or word limits
- Ensures consistent TTS request sizes
- Fallback when other methods exceed limits
- Prioritizes sentence boundaries when possible

## Emotion Markup Preservation

### Tag Completion
Ensure each chunk has complete emotion tags:
```
Input: "[love:high]This is a long sentence that needs to be split[/love:high] [calm:medium]And this continues.[/calm:medium]"

Output:
Chunk 1: "[love:high]This is a long sentence that needs to be split[/love:high]"
Chunk 2: "[calm:medium]And this continues.[/calm:medium]"
```

### Tag Inheritance
When splitting within emotion blocks:
```
Input: "[serenity:high]This is a very long sentence that spans multiple chunks and needs splitting.[/serenity:high]"

Output:
Chunk 1: "[serenity:high]This is a very long sentence that spans multiple chunks[/serenity:high]"
Chunk 2: "[serenity:high]and needs splitting.[/serenity:high]"
```

## Optimal Chunk Characteristics

### Size Limits
- **Ideal**: 100-200 characters per chunk
- **Maximum**: 500 characters per chunk
- **Minimum**: 20 characters per chunk
- Count characters including markup

### Sentence Boundaries
- Always prefer splitting at sentence endings
- Avoid breaking mid-sentence unless absolutely necessary
- Preserve natural reading rhythm and pauses
- Maintain emotional context within sentences

### Markup Integrity
- Never break emotion tags across chunks
- Close tags at chunk end, reopen in next chunk if needed
- Preserve tag hierarchy and nesting
- Validate markup syntax in each chunk

## Processing Rules

### 1. Sentence Detection
Use these patterns to identify sentence boundaries:
- Period followed by space and capital letter
- Exclamation mark followed by space
- Question mark followed by space
- Ellipsis (...) followed by space
- Em dash (—) in dialogue

### 2. Emotion Tag Parsing
- Identify opening tags: `[emotion:level]`
- Identify closing tags: `[/emotion:level]`
- Track nested emotion states
- Ensure proper tag closure

### 3. Chunk Validation
- Check character count limits
- Verify complete emotion tags
- Ensure readable content
- Validate punctuation integrity

## Example Processing

### Input Text
```markdown
[warmth:high]The rain tapped gently against their bedroom window as Michael pulled Claudia closer, her warm presence filling every corner of his heart.[/warmth:high] [love:high]"Tell me about tomorrow, my love," she whispered, her voice soft as silk against his ear.[/love:high] [tenderness:medium]He traced gentle circles on her back, feeling the rhythm of her breathing slow to match his own.[/tenderness:medium]
```

### Output Chunks
```
Chunk 1 (147 chars):
[warmth:high]The rain tapped gently against their bedroom window as Michael pulled Claudia closer, her warm presence filling every corner of his heart.[/warmth:high]

Chunk 2 (102 chars):
[love:high]"Tell me about tomorrow, my love," she whispered, her voice soft as silk against his ear.[/love:high]

Chunk 3 (131 chars):
[tenderness:medium]He traced gentle circles on her back, feeling the rhythm of her breathing slow to match his own.[/tenderness:medium]
```

## Advanced Features

### Pause Insertion
Add natural pauses between emotional shifts:
```
Chunk 1: "[love:high]I love you so much.[/love:high]"
Pause: 1.5 seconds
Chunk 2: "[calm:medium]Let's rest now.[/calm:medium]"
```

### Breathing Cues
For meditation content, insert breathing instructions:
```
Chunk 1: "[breathiness:low]Breathe in slowly...[/breathiness:low]"
Pause: 3 seconds (for inhale)
Chunk 2: "[breathiness:low]And let that breath go.[/breathiness:low]"
Pause: 4 seconds (for exhale)
```

### Context Preservation
Maintain character and scene context across chunks:
- Track who is speaking
- Preserve scene setting
- Maintain emotional continuity
- Note any important context changes

## Instructions

1. **Analyze content** - Identify sentences, emotion tags, and natural breaks
2. **Choose strategy** - Sentence-based for most content, paragraph for longer pieces
3. **Parse emotion markup** - Identify all opening and closing tags
4. **Split intelligently** - Prioritize sentence boundaries, respect tag integrity
5. **Validate chunks** - Check size limits, tag completion, readability
6. **Add metadata** - Include chunk numbers, total count, timing suggestions
7. **Format output** - Clear separation between chunks with metadata

## Output Format

```
=== TTS Chunk Processing Results ===

Total chunks: 8
Estimated speaking time: 3 minutes 45 seconds

--- Chunk 1/8 ---
Characters: 147
Pause after: 0.5 seconds
Content: [emotion markup and text]

--- Chunk 2/8 ---
Characters: 102
Pause after: 1.0 seconds
Content: [emotion markup and text]

[Continue for all chunks...]

=== Processing Summary ===
- Original length: 1,234 characters
- Average chunk size: 154 characters
- Emotion tags preserved: 12/12
- Sentence boundaries respected: Yes
- Ready for TTS processing: Yes
```

## Notes

- Always prioritize narrative flow over rigid size limits
- Preserve emotional arc across chunks
- Include suggested pause times between chunks
- Test with actual TTS to validate timing
- Adjust chunk sizes based on TTS service requirements
- Maintain backup of original unprocessed content
- Consider adding chunk metadata for debugging