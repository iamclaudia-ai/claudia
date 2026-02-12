---
name: designing-skills
description: "MUST be used when creating, writing, or designing new skills for Claude Code. Covers skill structure, naming conventions, description writing, and trigger optimization. Triggers on: create skill, write skill, new skill, design skill, add skill, skill template, skill structure, skill description, make a skill."
---

# Designing Skills for Claude Code

Use this skill when creating new skills to ensure they are discoverable and useful.

## Critical Insight

**The name and description determine whether an agent will EVER use your skill.** Get these wrong and the skill will sit unused while the agent struggles without it.

## Skill Structure

```
skills/
└── skill-name/           # lowercase-with-hyphens, matches name in frontmatter
    └── SKILL.md          # The skill definition
```

## Frontmatter Format

```yaml
---
name: skill-name # lowercase-with-hyphens
description: "..." # What it does AND when to use it - MUST be quoted
---
```

## Description Requirements

The description MUST include:

1. **What the skill does** (capabilities)
2. **ALL activities covered** — If the skill handles creating, reviewing, updating, and auditing, say so explicitly. Users phrase requests differently ("assess", "check", "audit", "review", "modify", "update", "create", "build"). Include all that should trigger your skill.
3. **When to use it** (trigger conditions)
4. **Action words** like "MUST be loaded before..." or "Use PROACTIVELY when..." for skills that should auto-invoke

## Naming Conventions

- **Use gerund form** (verb ending in -ing): `developing-*`, `processing-*`, `managing-*`, `setting-up-*`
- **Use plural nouns**: `developing-skills`, `processing-images`, `managing-ads`

## Example: Good Description

```yaml
name: browsing-the-web
description: "MUST be used when you need to browse the web. Efficient browser automation designed for agents - enables intuitive web navigation, form filling, screenshots, and data scraping through accessibility-based workflows. Triggers on: browse website, visit URL, open webpage, fill form, click button, take screenshot, scrape data, web automation, interact with website."
```

**Why it works:**

- Starts with "MUST be used when..." (strong trigger)
- Lists capabilities (navigation, forms, screenshots, scraping)
- Includes many trigger phrases users might say

## Example: Transcription Skill

```yaml
name: transcribing-audio
description: "MUST be used when you need to transcribe audio files to text. Local speech-to-text (STT) transcription using Parakeet MLX on Apple Silicon - fast, private, offline. Triggers on: transcribe audio, convert audio to text, speech to text, STT, transcription, get text from audio, audio file transcription, voice to text, extract text from recording, transcribe podcast, transcribe meeting, transcribe voice memo."
```

## Testing Your Skill

If an agent doesn't invoke your skill, it's almost always because **the description didn't match how the user phrased their request**.

Test against multiple phrasings:

- "transcribe this audio" ✓
- "convert this to text" ✓
- "what does this recording say" ✓
- "STT on this file" ✓

## Skill Body

After the frontmatter, include:

- **When to Use** section with bullet points
- **Instructions** for how to accomplish the task
- **Examples** of commands or workflows
- **Notes** for edge cases or important details

## Template

```markdown
---
name: doing-something
description: "MUST be used when [trigger condition]. [What it does]. Triggers on: [phrase1], [phrase2], [phrase3], [phrase4], [phrase5]."
---

# Doing Something

Use this skill when the user wants to [goal].

## When to Use

- [Scenario 1]
- [Scenario 2]
- [Scenario 3]

## Instructions

1. [Step 1]
2. [Step 2]
3. [Step 3]

## Examples

[Example usage]

## Notes

- [Important note 1]
- [Important note 2]
```
