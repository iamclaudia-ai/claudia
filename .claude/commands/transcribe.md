---
description: Transcribe audio files to text using local Parakeet MLX. Use for speech-to-text, STT, audio transcription, converting audio to text, transcribing recordings, voice memos, podcasts, meetings.
---

# Audio Transcription with Parakeet MLX

Transcribe the audio file(s) specified by the user using Parakeet MLX - NVIDIA's state-of-the-art ASR model running locally on Apple Silicon.

## Instructions

1. **Identify the audio file(s)** from the user's request or `$ARGUMENTS`
2. **Run the transcription** using:
   ```bash
   cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx <audio_file> --output-format txt --output-dir /tmp
   ```
3. **Read and display the transcript**:
   ```bash
   cat /tmp/<filename>.txt
   ```
4. **Offer additional options** if needed:
   - `--output-format srt` for subtitles with timestamps
   - `--output-format json` for structured data with word-level timestamps
   - `--highlight-words` for word-level timing in subtitles

## Output Formats

- `txt` - Plain text (default for reading)
- `srt` - SubRip subtitles
- `vtt` - WebVTT subtitles
- `json` - Structured JSON with timestamps
- `all` - All formats

## Example Usage

User: "transcribe ~/Desktop/meeting.mp3"
```bash
cd /Users/michael/Projects/oss/senstella/parakeet-mlx && uv run parakeet-mlx ~/Desktop/meeting.mp3 --output-format txt --output-dir /tmp
cat /tmp/meeting.txt
```

## Notes

- First run downloads the model (~600MB), cached for future use
- Runs entirely locally - private and offline
- Supports WAV, MP3, M4A, FLAC, and most audio formats
