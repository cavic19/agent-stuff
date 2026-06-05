---
name: youtube-transcriber
description: Transcribe and summarize YouTube videos, especially Czech videos. Prefer YouTube automatic/manual captions via youtube-transcript-api; if captions are unavailable, fall back to downloading audio with yt-dlp and transcribing through OpenAI Whisper using OPENAI_API_KEY. Use when the user asks to transcribe one or more YouTube videos or save transcript/summary as Markdown.
---

# YouTube Transcriber

Use this skill for recurring YouTube transcription tasks. It is designed for Czech videos, but works with other languages too.

## Workflow

1. Run the helper script on the requested YouTube URL(s).
2. The script first tries YouTube captions/transcripts.
3. If captions are unavailable and `OPENAI_API_KEY` is present, it downloads audio and uses OpenAI Whisper fallback.
4. Read the generated Markdown transcript.
5. Add or refine a Czech summary, key facts, numbers, decisions, uncertainties, and action items as appropriate for the user's knowledge base.
6. If saving into an Obsidian/knowledge vault, follow the project’s canonical-location and Markdown rules.

## Setup

Run once after installing the skill:

```bash
cd ~/.pi/agent/skills/youtube-transcriber
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Fallback transcription requires:

- `OPENAI_API_KEY` in the environment.
- `ffmpeg` and `ffprobe` available on PATH.

Do not ask the user to paste API keys into chat. If fallback fails because the key is missing, ask the user to set it locally.

## Usage

Basic Czech transcript to Markdown:

```bash
~/.pi/agent/skills/youtube-transcriber/scripts/yt-transcribe \
  "https://www.youtube.com/watch?v=VIDEO_ID" \
  --lang cs \
  --out docs/pickwise/research
```

Multiple videos:

```bash
~/.pi/agent/skills/youtube-transcriber/scripts/yt-transcribe \
  "URL_1" "URL_2" \
  --lang cs \
  --out transcripts
```

Force no OpenAI fallback, only YouTube captions:

```bash
~/.pi/agent/skills/youtube-transcriber/scripts/yt-transcribe \
  "URL" --fallback none
```

Save JSON metadata and transcript too:

```bash
~/.pi/agent/skills/youtube-transcriber/scripts/yt-transcribe \
  "URL" --json
```

## Output

For each video the script writes a Markdown file containing:

- title and metadata,
- source of transcription (`youtube-captions` or `openai-whisper`),
- warning about transcript quality,
- timestamped transcript.

The script intentionally does not fully summarize the video. The agent should summarize from the transcript and adapt the output to the user's requested structure.

## Notes

- YouTube captions are faster and cheaper than Whisper; use them whenever available.
- Automatic captions can contain recognition errors, especially names, company names, logistics terminology, and punctuation.
- Whisper fallback downloads audio temporarily and deletes it after successful processing unless `--keep-temp` is used.
- For long videos, the script chunks audio before OpenAI transcription to stay under API file-size limits.
