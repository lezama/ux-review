# UX Review — Claude Code Plugin

AI-driven UX review agent. Interviews you to build a test script, drives browsers to record the user experience, and produces a video with narration and UX findings.

## Install

### As a Claude Code plugin

```bash
# In Claude Code:
/plugin marketplace add lezama/ux-review
/plugin install ux-review@ux-review-marketplace
```

Or from a local clone:

```bash
/plugin marketplace add /path/to/ux-review
/plugin install ux-review@ux-review-marketplace
```

### Requirements

- **macOS** (fallback to `say` for TTS narration)
- **Node.js** >= 20
- **ffmpeg** (`brew install ffmpeg`)
- **Chrome** or **Chrome Beta** (`brew install --cask google-chrome-beta`)
- **Kokoro TTS** (optional, high-quality local TTS — auto-detected)

### First-time setup

```bash
cd /path/to/ux-review
npm install && npm run build
```

### TTS engines

Narration audio is generated at compile time. Engines are auto-detected in
priority order: **Qwen3-TTS → Kokoro → macOS `say`**. With no optional
installs, `say` always works.

**Qwen3-TTS (recommended — best quality):**

```bash
pip3.11 install qwen-tts torch soundfile
```

The first compile downloads the `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` model
from Hugging Face and loads it once per batch (~20s warmup). For faster
iteration, keep the model warm in a local server:

```bash
python3.11 bin/qwen-tts-server.py &   # listens on /tmp/qwen-tts.sock
```

macOS voice names are mapped to Qwen speakers (Samantha → Ryan,
Daniel → Aiden), so persona voice maps work unchanged across engines.

**Kokoro (lighter alternative):**

```bash
pip3.11 install kokoro soundfile
```

**Engine override** via `TTS_ENGINE`:
- unset — auto-detect (qwen → kokoro → say)
- `TTS_ENGINE=qwen` | `kokoro` | `say` — force a specific engine

## Usage

### Quick Start

```
/ux-review Review the checkout flow at http://localhost:3000/shop
```

The agent will:
1. **Interview you** — Ask about personas, tasks, and what to watch for
2. **Build a test script** — Structured guión de prueba for your approval
3. **Execute the test** — Drive browsers, record screenshots, narrate observations
4. **Deliver results** — Composed video + `findings.md` with UX insights

### Examples

```
/ux-review
```
Starts an open interview — the agent asks what you want to test.

```
/ux-review Test the gift card lifecycle with admin, buyer, and recipient
```
Multi-persona review with three actors.

```
/ux-review Review the onboarding flow for new users at https://staging.myapp.com
```
Single-persona review focused on first-time experience.

## What It Produces

| Output | Description |
|--------|-------------|
| `composed-final.mp4` | Video with narration, subtitles, and transitions |
| `findings.md` | UX findings: what worked, friction points, suggestions |
| `steps.jsonl` | Declarative step log (screenshot + observations per step) |
| `action-log.jsonl` | Backward-compatible action log (generated at compile time) |
| `compile-log.jsonl` | Compile diagnostics: per-step timing, audio durations, duplicate warnings |
| `screenshots/` | All captured frames organized by persona |

## How the Interview Works

The agent acts as a **UX researcher** building a test script. It asks about:

1. **Product & Feature** — What are we testing? Where is it?
2. **Personas** — Who are the users? What roles do they play?
3. **Tasks** — What should each persona try to accomplish?
4. **Success Criteria** — What defines "working well"?
5. **Watch Points** — Known pain points or areas of concern?

It then presents a structured **test script** for your approval before recording.

## Chrome DevTools MCP

The plugin bundles Chrome DevTools MCP configuration (`.mcp.json`). Each persona gets an isolated Chrome instance:

```bash
# Or add manually:
claude mcp add chrome-devtools-2 -- npx chrome-devtools-mcp@latest --isolated --channel beta --chromeArg=--start-fullscreen
claude mcp add chrome-devtools-3 -- npx chrome-devtools-mcp@latest --isolated --channel beta --chromeArg=--start-fullscreen
```

## Architecture

```
/ux-review command (UX Researcher)
  │
  ├── Phase 1: Interview → Build test script
  ├── Phase 2: Confirm test script with user
  ├── Phase 3: Execute recording (no TTS)
  │     ├── ux_record_start (init personas)
  │     ├── take_screenshot → ux_record_step (screenshot + observations)
  │     └── repeat for each step
  └── Phase 4: Compile & report
        ├── ux_record_compile (batch TTS → video → findings)
        ├── composed-final.mp4
        └── findings.md
```

## Video Layouts

For multi-persona tests, the agent chooses layouts automatically:

- **`full`** — Single persona fills the screen (default)
- **`split`** — Two personas side by side (simultaneous activity)
- **`pip-[name]`** — Picture-in-picture (main action + context)

## Key Concepts

### Test Script (Guión de Prueba)
The structured plan approved by the user before recording. Contains: personas, tasks, success criteria, and video composition plan.

### Narration Style
First-person user-tester voice: "I'm on the checkout page. The form asks for my address — the autocomplete is working nicely." Not scripted, not robotic.

### Findings
Extracted from narration text. Positive signals ("smooth", "intuitive", "nice") become "What Worked Well". Negative signals ("confusing", "broken", "missing") become "Friction Points".
