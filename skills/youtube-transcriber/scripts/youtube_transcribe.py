#!/usr/bin/env python3
"""Transcribe YouTube videos to Markdown.

Strategy:
1. Prefer YouTube captions via youtube-transcript-api.
2. If captions are unavailable, optionally download audio with yt-dlp and transcribe with OpenAI Whisper.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable, Any


MAX_OPENAI_FILE_BYTES = 24 * 1024 * 1024
DEFAULT_CHUNK_SECONDS = 20 * 60


@dataclass
class TranscriptSegment:
    start: float
    duration: float | None
    text: str


@dataclass
class VideoMeta:
    video_id: str
    url: str
    title: str | None = None
    author: str | None = None


@dataclass
class TranscriptResult:
    meta: VideoMeta
    language: str | None
    source: str
    is_generated: bool | None
    segments: list[TranscriptSegment]
    notes: list[str]


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def extract_video_id(url_or_id: str) -> str:
    s = url_or_id.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return s

    parsed = urllib.parse.urlparse(s)
    host = parsed.netloc.lower()
    path = parsed.path.strip("/")

    if "youtu.be" in host:
        candidate = path.split("/")[0]
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate):
            return candidate

    if "youtube.com" in host or "youtube-nocookie.com" in host:
        qs = urllib.parse.parse_qs(parsed.query)
        if "v" in qs and qs["v"]:
            candidate = qs["v"][0]
            if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate):
                return candidate

        parts = path.split("/")
        for marker in ("shorts", "embed", "live"):
            if marker in parts:
                i = parts.index(marker)
                if i + 1 < len(parts):
                    candidate = parts[i + 1]
                    if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate):
                        return candidate

    raise ValueError(f"Cannot extract YouTube video ID from: {url_or_id}")


def canonical_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def fetch_oembed(video_id: str) -> VideoMeta:
    url = canonical_url(video_id)
    meta = VideoMeta(video_id=video_id, url=url)
    endpoint = "https://www.youtube.com/oembed?" + urllib.parse.urlencode(
        {"url": url, "format": "json"}
    )
    try:
        with urllib.request.urlopen(endpoint, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
        meta.title = data.get("title")
        meta.author = data.get("author_name")
    except Exception as exc:  # noqa: BLE001 - metadata is best-effort
        eprint(f"Warning: failed to fetch oEmbed metadata for {video_id}: {exc}")
    return meta


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\n", " ")).strip()


def fetch_youtube_captions(video_id: str, languages: list[str]) -> tuple[list[TranscriptSegment], str | None, bool | None, list[str]]:
    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()
    notes: list[str] = []

    # Prefer exact requested languages first.
    try:
        fetched = api.fetch(video_id, languages=languages)
        language = getattr(fetched, "language_code", None) or (languages[0] if languages else None)
        segments = [
            TranscriptSegment(start=float(s.start), duration=float(s.duration), text=clean_text(s.text))
            for s in fetched
            if clean_text(s.text)
        ]
        return segments, language, None, notes
    except Exception as first_exc:  # noqa: BLE001 - then try transcript listing
        notes.append(f"Přímé stažení požadovaných jazyků titulků selhalo: {first_exc}")

    transcript_list = api.list(video_id)

    # Try manual transcript in requested languages, then generated transcript.
    for finder_name in ("find_manually_created_transcript", "find_generated_transcript"):
        try:
            transcript = getattr(transcript_list, finder_name)(languages)
            fetched = transcript.fetch()
            segments = [
                TranscriptSegment(start=float(s.start), duration=float(s.duration), text=clean_text(s.text))
                for s in fetched
                if clean_text(s.text)
            ]
            return segments, transcript.language_code, transcript.is_generated, notes
        except Exception as exc:  # noqa: BLE001
            notes.append(f"Vyhledání titulků přes {finder_name} selhalo: {exc}")

    # Last resort: use first available transcript regardless of language.
    available = list(transcript_list)
    if available:
        transcript = available[0]
        fetched = transcript.fetch()
        segments = [
            TranscriptSegment(start=float(s.start), duration=float(s.duration), text=clean_text(s.text))
            for s in fetched
            if clean_text(s.text)
        ]
        notes.append(f"Použit první dostupný přepis: {transcript.language_code} ({transcript.language}).")
        return segments, transcript.language_code, transcript.is_generated, notes

    raise RuntimeError("No YouTube captions/transcripts available.")


def run(cmd: list[str], cwd: Path | None = None) -> None:
    eprint("+", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def require_binary(name: str) -> None:
    if shutil.which(name) is None:
        raise RuntimeError(f"Required binary not found on PATH: {name}")


def ffprobe_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def download_audio(url: str, tmpdir: Path) -> Path:
    require_binary("ffmpeg")
    require_binary("ffprobe")

    outtmpl = str(tmpdir / "audio.%(ext)s")
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "-f",
        "bestaudio/best",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "64K",
        "-o",
        outtmpl,
        url,
    ]
    run(cmd)

    candidates = sorted(tmpdir.glob("audio.*"), key=lambda p: p.stat().st_size, reverse=True)
    if not candidates:
        raise RuntimeError("yt-dlp did not produce an audio file.")
    return candidates[0]


def chunk_audio_if_needed(audio: Path, tmpdir: Path) -> list[Path]:
    if audio.stat().st_size <= MAX_OPENAI_FILE_BYTES:
        return [audio]

    duration = ffprobe_duration(audio)
    # Estimate chunk size conservatively. Never exceed DEFAULT_CHUNK_SECONDS.
    estimated_chunk_seconds = int(duration * (MAX_OPENAI_FILE_BYTES / audio.stat().st_size) * 0.8)
    chunk_seconds = max(300, min(DEFAULT_CHUNK_SECONDS, estimated_chunk_seconds))
    eprint(f"Audio is {audio.stat().st_size / 1024 / 1024:.1f} MB; chunking into ~{chunk_seconds}s pieces.")

    chunk_pattern = str(tmpdir / "chunk_%03d.mp3")
    run([
        "ffmpeg",
        "-y",
        "-i",
        str(audio),
        "-f",
        "segment",
        "-segment_time",
        str(chunk_seconds),
        "-c",
        "copy",
        chunk_pattern,
    ])
    chunks = sorted(tmpdir.glob("chunk_*.mp3"))
    if not chunks:
        raise RuntimeError("ffmpeg chunking produced no chunks.")
    return chunks


def openai_transcribe_chunks(chunks: list[Path], language: str | None, model: str) -> tuple[list[TranscriptSegment], list[str]]:
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is not set; cannot use OpenAI Whisper fallback.")

    from openai import OpenAI

    client = OpenAI()
    segments: list[TranscriptSegment] = []
    notes: list[str] = []
    offset = 0.0

    for idx, chunk in enumerate(chunks, start=1):
        eprint(f"Transcribing chunk {idx}/{len(chunks)} with OpenAI model {model}: {chunk.name}")
        with chunk.open("rb") as f:
            kwargs: dict[str, Any] = {
                "model": model,
                "file": f,
                "response_format": "verbose_json",
            }
            if language:
                kwargs["language"] = language
            # Segment timestamps are supported by whisper-1 verbose_json.
            if model == "whisper-1":
                kwargs["timestamp_granularities"] = ["segment"]
            response = client.audio.transcriptions.create(**kwargs)

        data = response.model_dump() if hasattr(response, "model_dump") else dict(response)
        response_segments = data.get("segments") or []

        if response_segments:
            for seg in response_segments:
                start = float(seg.get("start", 0.0)) + offset
                end = seg.get("end")
                duration = (float(end) - float(seg.get("start", 0.0))) if end is not None else None
                text = clean_text(seg.get("text", ""))
                if text:
                    segments.append(TranscriptSegment(start=start, duration=duration, text=text))
        else:
            text = clean_text(data.get("text", ""))
            if text:
                segments.append(TranscriptSegment(start=offset, duration=None, text=text))
            notes.append(f"OpenAI odpověď pro chunk {idx} neobsahovala segmenty; použit jeden blok textu.")

        try:
            offset += ffprobe_duration(chunk)
        except Exception:  # noqa: BLE001
            offset += DEFAULT_CHUNK_SECONDS

    return segments, notes


def transcribe_openai(meta: VideoMeta, language: str | None, model: str, keep_temp: bool) -> TranscriptResult:
    tmp_obj = tempfile.TemporaryDirectory(prefix="yt-transcribe-")
    tmpdir = Path(tmp_obj.name)
    try:
        audio = download_audio(meta.url, tmpdir)
        chunks = chunk_audio_if_needed(audio, tmpdir)
        segments, notes = openai_transcribe_chunks(chunks, language=language, model=model)
        notes.insert(0, "Přepis vznikl ze staženého audia pomocí fallbacku OpenAI Whisper.")
        if keep_temp:
            kept = Path.cwd() / f"yt-transcribe-temp-{meta.video_id}"
            if kept.exists():
                shutil.rmtree(kept)
            shutil.copytree(tmpdir, kept)
            notes.append(f"Dočasné audio soubory ponechány zde: {kept}")
        return TranscriptResult(
            meta=meta,
            language=language,
            source="openai-whisper",
            is_generated=True,
            segments=segments,
            notes=notes,
        )
    finally:
        if not keep_temp:
            tmp_obj.cleanup()


def transcribe_video(url_or_id: str, languages: list[str], fallback: str, model: str, keep_temp: bool) -> TranscriptResult:
    video_id = extract_video_id(url_or_id)
    meta = fetch_oembed(video_id)
    if not meta.title:
        meta.title = f"YouTube video {video_id}"

    try:
        segments, language, is_generated, notes = fetch_youtube_captions(video_id, languages)
        notes.insert(0, "Přepis stažen z YouTube titulků / transcriptu.")
        return TranscriptResult(
            meta=meta,
            language=language,
            source="youtube-captions",
            is_generated=is_generated,
            segments=segments,
            notes=notes,
        )
    except Exception as exc:  # noqa: BLE001
        eprint(f"YouTube captions unavailable for {video_id}: {exc}")
        if fallback == "none":
            raise
        if fallback != "openai":
            raise RuntimeError(f"Unsupported fallback: {fallback}") from exc
        result = transcribe_openai(meta, language=(languages[0] if languages else None), model=model, keep_temp=keep_temp)
        result.notes.insert(0, f"Stažení YouTube titulků selhalo: {exc}")
        return result


def timestamp(seconds: float) -> str:
    total = max(0, int(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def slugify(text: str, fallback: str) -> str:
    replacements = {
        "á": "a", "č": "c", "ď": "d", "é": "e", "ě": "e", "í": "i", "ň": "n",
        "ó": "o", "ř": "r", "š": "s", "ť": "t", "ú": "u", "ů": "u", "ý": "y", "ž": "z",
        "Á": "a", "Č": "c", "Ď": "d", "É": "e", "Ě": "e", "Í": "i", "Ň": "n",
        "Ó": "o", "Ř": "r", "Š": "s", "Ť": "t", "Ú": "u", "Ů": "u", "Ý": "y", "Ž": "z",
    }
    for src, dst in replacements.items():
        text = text.replace(src, dst)
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:120] or fallback


def yaml_escape(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def render_markdown(result: TranscriptResult) -> str:
    title = result.meta.title or f"YouTube video {result.meta.video_id}"
    lines: list[str] = []
    lines.extend([
        "---",
        f"title: {yaml_escape(title)}",
        "type: reference",
        "tags:",
        "  - youtube",
        "  - prepis",
        "---",
        "",
        f"# {title}",
        "",
        f"- Video: <{result.meta.url}>",
    ])
    if result.meta.author:
        lines.append(f"- Kanál: {result.meta.author}")
    lines.extend([
        f"- Zdroj přepisu: {result.source}",
        f"- Jazyk přepisu: {result.language or 'neznámý'}",
    ])
    if result.is_generated is not None:
        lines.append(f"- Automaticky generováno: {'ano' if result.is_generated else 'ne'}")

    lines.extend([
        "",
        "Přepis může obsahovat chyby, zejména u vlastních jmen, názvů firem, odborných termínů a interpunkce.",
        "",
    ])

    if result.notes:
        lines.append("## Poznámky ke zdroji přepisu")
        lines.append("")
        for note in result.notes:
            lines.append(f"- {note}")
        lines.append("")

    lines.extend(["## Přepis", ""])
    for segment in result.segments:
        lines.append(f"- **{timestamp(segment.start)}** {segment.text}")
    lines.append("")
    return "\n".join(lines)


def write_outputs(result: TranscriptResult, out_dir: Path, write_json: bool) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    base = slugify(result.meta.title or result.meta.video_id, result.meta.video_id)
    md_path = out_dir / f"{base}.md"
    if md_path.exists():
        base = f"{base}-{result.meta.video_id}"
        md_path = out_dir / f"{base}.md"

    md_path.write_text(render_markdown(result), encoding="utf-8")

    if write_json:
        json_path = out_dir / f"{base}.json"
        data = asdict(result)
        json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    return md_path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe YouTube videos to Markdown.")
    parser.add_argument("urls", nargs="+", help="YouTube URLs or video IDs")
    parser.add_argument("--lang", action="append", default=None, help="Preferred language code; repeatable. Default: cs,en")
    parser.add_argument("--out", default=".", help="Output directory for Markdown files")
    parser.add_argument("--fallback", choices=["openai", "none"], default="openai", help="Fallback when captions are unavailable")
    parser.add_argument("--openai-model", default="whisper-1", help="OpenAI audio transcription model for fallback")
    parser.add_argument("--json", action="store_true", help="Also write JSON output")
    parser.add_argument("--keep-temp", action="store_true", help="Keep temporary downloaded audio/chunks for debugging")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    languages = args.lang if args.lang else ["cs", "en"]
    out_dir = Path(args.out)

    written: list[Path] = []
    for url in args.urls:
        eprint(f"Processing: {url}")
        result = transcribe_video(
            url,
            languages=languages,
            fallback=args.fallback,
            model=args.openai_model,
            keep_temp=args.keep_temp,
        )
        path = write_outputs(result, out_dir=out_dir, write_json=args.json)
        written.append(path)
        print(path)

    eprint("Written files:")
    for path in written:
        eprint(f"- {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
