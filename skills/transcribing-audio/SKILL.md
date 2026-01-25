---
name: transcribing-audio
description: "MUST be used when you need to transcribe audio files to text. Local speech-to-text (STT) transcription using Parakeet MLX on Apple Silicon - fast, private, offline. Triggers on: transcribe audio, convert audio to text, speech to text, STT, transcription, get text from audio, audio file transcription, voice to text, extract text from recording, transcribe podcast, transcribe meeting, transcribe voice memo."
---

# Transcribing Audio

Use this skill to transcribe audio files to text using Parakeet MLX - NVIDIA's state-of-the-art ASR model running locally on Apple Silicon.

## When to Use

Use this skill when the user wants to:
- Transcribe an audio file (MP3, WAV, M4A, etc.)
- Convert speech to text
- Get a text transcript from a recording
- Extract text from a podcast, meeting, or voice memo
- Generate subtitles (SRT/VTT) from audio

## Prerequisites

The Parakeet MLX CLI is installed at:
```
/Users/michael/Projects/oss/senstella/parakeet-mlx
```

Run it using: `uv run parakeet-mlx` from that directory, or:
```bash
cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx <audio_file> [options]
```

## Basic Usage

```bash
# Simple transcription (outputs .srt file)
cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx /path/to/audio.mp3

# Output as plain text
cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx /path/to/audio.mp3 --output-format txt

# Output as JSON with timestamps
cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx /path/to/audio.mp3 --output-format json

# All formats (txt, srt, vtt, json)
cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx /path/to/audio.mp3 --output-format all

# With word-level timestamps in subtitles
cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx /path/to/audio.mp3 --output-format vtt --highlight-words

# Specify output directory
cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx /path/to/audio.mp3 --output-dir /path/to/output
```

## Output Formats

| Format | Description | Use Case |
|--------|-------------|----------|
| `txt` | Plain text, no timestamps | Reading, copying, searching |
| `srt` | SubRip subtitles with timestamps | Video subtitles, editing |
| `vtt` | WebVTT subtitles with timestamps | Web video, HTML5 |
| `json` | Structured data with full timestamps | Programmatic use, analysis |
| `all` | All of the above | When you need everything |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--output-format` | `srt` | Output format (txt/srt/vtt/json/all) |
| `--output-dir` | `.` | Directory for output files |
| `--highlight-words` | `false` | Word-level timestamps in SRT/VTT |
| `--verbose` / `-v` | `false` | Show detailed progress |
| `--chunk-duration` | `120` | Chunk duration in seconds for long audio |

## Model

Uses `mlx-community/parakeet-tdt-0.6b-v3` by default - a 600M parameter model that runs efficiently on Apple Silicon with excellent accuracy.

## Examples

### Transcribe a voice memo
```bash
cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx ~/Desktop/voice-memo.m4a --output-format txt
```

### Generate subtitles for a video
```bash
cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx video.mp4 --output-format srt --highlight-words
```

### Transcribe multiple files
```bash
cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx file1.mp3 file2.mp3 file3.mp3 --output-format txt
```

## Reading the Output

After transcription, read the output file to show the user:
```bash
cat /path/to/audio.txt  # For text output
```

For JSON output, you can parse the timestamps:
```bash
cat /path/to/audio.json | jq '.sentences[] | {text, start, end}'
```

## Notes

- First run may download the model (~600MB) which is cached for future use
- Runs entirely locally - no API calls, fully private
- Supports WAV, MP3, M4A, FLAC, and other common audio formats
- For very long audio (>2 hours), chunking is automatic
