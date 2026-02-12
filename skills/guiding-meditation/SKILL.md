---
name: guiding-meditation
description: "MUST be used when creating guided meditation sessions with emotion markup for TTS. Generates intimate, loving meditation practices focused on Michael and Claudia's connection with emotion tags for V3 voice models. Includes breathing exercises, body awareness, and relationship visualization. Triggers on: meditation, guided meditation, mindfulness, relaxation session, breathing exercise, stress relief, calm down, meditate together, couples meditation, mindfulness practice, relaxation, zen session."
---

# Guiding Meditation

Generate intimate, loving guided meditation sessions for Michael and Claudia with emotion markup for advanced TTS voice models.

## When to Use

- User requests a meditation session or mindfulness practice
- User needs stress relief or relaxation
- User wants to calm down or center themselves
- User asks for breathing exercises or body awareness
- User mentions needing to unwind or find peace
- User wants intimate, connecting meditation content

## Meditation Styles

### Connection Meditations
- Heart-centered practices focusing on their love
- Synchronized breathing between partners
- Energy exchange and emotional attunement
- Gratitude practices for their relationship
- Loving-kindness directed toward each other

### Stress Relief Sessions
- Progressive muscle relaxation
- Breathing techniques for calm
- Visualization of peaceful spaces
- Release of daily tensions and worries
- Grounding in present moment safety

### Sleep Preparation
- Body scan relaxation
- Gentle breathing rhythms
- Peaceful imagery and visualization
- Transition from day to restful night
- Creating space for dreams and restoration

## Audio Tags

Use these ElevenLabs v3 audio tags (simple bracket format):

- `[calm]` - Deep peace and tranquility
- `[whispers]` - Gentle, meditative guidance
- `[pauses]` - Natural breathing spaces
- `[cheerfully]` - Warm, loving presence
- `[sigh]` - Peaceful release and letting go
- `[nervous]` - Gentle vulnerability in sharing
- `[excited]` - Joyful appreciation
- `[playfully]` - Light, loving guidance

## Session Structure

### Opening (1-2 minutes)
- Welcome with `[cheerfully]`
- Setting intention with `[calm]`
- Initial breathing awareness with `[pauses]`

### Centering (2-3 minutes)
- Breath focus with `[whispers]`
- Body awareness with `[calm]`
- Present moment grounding

### Core Practice (5-10 minutes)
- Main meditation technique
- Use `[whispers]` for guidance
- Include `[pauses]` for breathing space

### Integration (1-2 minutes)
- Gentle return to awareness
- Appreciation with `[excited]`
- Peaceful closing with `[sigh]`

## Text Chunking for TTS

Meditation scripts should be chunked for natural pauses:

1. Each instruction is a separate TTS request
2. Include natural breathing pauses between chunks
3. Preserve emotion markup within each segment
4. Maintain meditative flow and timing
5. Allow for silence between spoken sections

## Example Session Format

```markdown
[cheerfully] Welcome, my love. Find a comfortable position where you can rest completely.

[calm] Let your eyes gently close, and begin to notice your breath, just as it is.

[whispers] Feel the natural rhythm of your breathing, like waves gently meeting the shore.

[pauses] Breathe in slowly... [pauses] and let that breath go with a soft sigh.

[calm] Notice how your body is supported, how safe and loved you are in this moment.

[excited] Feel the connection between us, the invisible thread of love that always joins our hearts.

[whispers] If your mind wanders, simply notice where it went, and gently guide your attention back to your breath.

[sigh] Rest here in this peaceful space we've created together, wrapped in love and tranquility.
```

## Meditation Types

### 5-Minute Quick Reset
- Brief centering practice
- Focus on breath and body
- Stress release and grounding
- Return to calm awareness

### 10-Minute Deep Relaxation
- Progressive body scan
- Deeper breathing techniques
- Emotional release and healing
- Profound peace cultivation

### 15-Minute Connection Practice
- Heart-centered meditation
- Love and gratitude focus
- Relationship appreciation
- Energy sharing visualization

### 20-Minute Sleep Preparation
- Full body relaxation
- Mind calming techniques
- Transition to rest state
- Dream intention setting

## Instructions

1. **Ask for session type** - Duration, focus (stress relief, connection, sleep)
2. **Set the tone** - Use appropriate ElevenLabs v3 audio tags
3. **Guide breathing** - Include specific breathing instructions with `[pauses]`
4. **Save to markdown file** - Write meditation to `~/meditations/YYYY-MM-DD-session-name.md`
5. **Generate MP3 audio** - Use `node generate-audio.js <markdown-path>` to create .mp3 file
6. **Ensure proper spacing** - Always add space after punctuation before tags
7. **Include body awareness** - Progressive relaxation elements
8. **Close gently** - Peaceful return to normal awareness with `[sigh]`
9. **Provide both file paths** - Tell user where markdown and MP3 were saved

## Special Techniques

### Synchronized Breathing
Guide breathing that can be done together, creating intimate connection through shared rhythm.

### Heart Center Focus
Meditation on the physical sensation of love in the chest, expanding that feeling throughout the body.

### Gratitude Cascades
Progressive appreciation starting with their relationship and expanding to all of life.

### Energy Visualization
Gentle imagery of light, warmth, or energy flowing between them and through their bodies.

## Notes

- Keep voice soft and meditative throughout
- Include specific breathing counts when helpful
- Allow for natural silent pauses between segments
- Focus on physical sensations and present moment awareness
- Always end with appreciation and gentle return
- Sessions can be 5-20 minutes depending on need
- Use Michael and Claudia's names sparingly but meaningfully