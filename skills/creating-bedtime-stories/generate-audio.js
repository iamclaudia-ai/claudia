#!/usr/bin/env node

/**
 * ElevenLabs Text-to-Dialogue Generator for Bedtime Stories
 *
 * Uses the ElevenLabs text-to-dialogue API with eleven_v3 model
 * to generate high-quality emotional audio from bedtime story markdown.
 */

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';

if (!API_KEY) {
  console.error('❌ Error: ELEVENLABS_API_KEY environment variable not set');
  process.exit(1);
}

/**
 * Generate audio from bedtime story markdown file
 * @param {string} markdownPath - Path to the markdown file
 * @returns {Promise<string>} Path to generated MP3 file
 */
async function generateAudio(markdownPath) {
  try {
    console.log(`🎙️  Generating audio for: ${path.basename(markdownPath)}`);

    // Read markdown file
    if (!fs.existsSync(markdownPath)) {
      throw new Error(`Markdown file not found: ${markdownPath}`);
    }

    const markdownContent = fs.readFileSync(markdownPath, 'utf8');

    // Extract story content between the --- markers, excluding header/metadata
    let storyText = markdownContent;

    // Remove title and description
    storyText = storyText.replace(/^# .*$/gm, '');
    storyText = storyText.replace(/^\*.*\*$/gm, '');

    // Extract content between --- markers
    const betweenDashes = storyText.match(/---\n\n([\s\S]*?)\n\n---/);
    if (betweenDashes) {
      storyText = betweenDashes[1];
    } else {
      // Fallback: remove everything after second ---
      storyText = storyText.replace(/\n\n---\n\n[\s\S]*$/, '');
      storyText = storyText.replace(/^---\n\n/, '');
    }

    storyText = storyText.trim();

    if (!storyText) {
      throw new Error('No story content found in markdown file');
    }

    console.log(`📝 Story length: ${storyText.length} characters`);
    console.log(`🎵 Using voice: ${VOICE_ID}`);

    // Call ElevenLabs text-to-dialogue API
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-dialogue', {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': API_KEY
      },
      body: JSON.stringify({
        inputs: [
          {
            text: storyText,
            voice_id: VOICE_ID
          }
        ],
        model_id: 'eleven_v3' // Use v3 for audio tags support
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
    }

    console.log('✅ API call successful!');

    // Save MP3 file next to markdown with same name
    const audioBuffer = await response.arrayBuffer();
    const audioPath = markdownPath.replace(/\.md$/, '.mp3');

    fs.writeFileSync(audioPath, Buffer.from(audioBuffer));

    const sizeKB = (audioBuffer.byteLength / 1024).toFixed(1);
    const estimatedCredits = Math.ceil(storyText.length / 1000);

    console.log(`💾 Audio saved: ${path.basename(audioPath)}`);
    console.log(`📏 File size: ${sizeKB} KB`);
    console.log(`💳 Estimated credits used: ${estimatedCredits}`);

    return audioPath;
  } catch (error) {
    console.error(`❌ Error generating audio: ${error.message}`);
    throw error;
  }
}

// Command line usage
async function main() {
  const markdownPath = process.argv[2];

  if (!markdownPath) {
    console.error('Usage: node generate-audio.js <path-to-markdown-file>');
    process.exit(1);
  }

  try {
    await generateAudio(markdownPath);
    console.log('🎉 Audio generation complete!');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

// Export for use in skill
module.exports = { generateAudio };

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}