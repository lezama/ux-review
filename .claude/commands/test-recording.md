# /test-recording — Automated Recording Pipeline Test

Run a headless end-to-end test of the UX recording pipeline. No browser needed — uses dummy PNGs to exercise the full flow: MCP tools → action log → TTS → video composition → findings.

## Steps

### 1. Setup

```bash
TESTDIR="/tmp/ux-recording-test-$(date +%s)"
mkdir -p "$TESTDIR"
# Generate 3 dummy 1920x1080 PNGs (blue, red, green)
ffmpeg -y -f lavfi -i color=c=blue:s=1920x1080:d=1 -frames:v 1 "$TESTDIR/shot1.png" 2>/dev/null
ffmpeg -y -f lavfi -i color=c=red:s=1920x1080:d=1 -frames:v 1 "$TESTDIR/shot2.png" 2>/dev/null
ffmpeg -y -f lavfi -i color=c=green:s=1920x1080:d=1 -frames:v 1 "$TESTDIR/shot3.png" 2>/dev/null
```

### 2. Record (MCP tools)

Call each tool in sequence — these are MCP calls, no Bash:

```
ux_session_start({
  outputDir: "$TESTDIR/output",
  personas: ["tester"]
})
```

Copy the dummy PNGs into the screenshot directory returned by start, then:

```
ux_session_step({
  outputDir: "$TESTDIR/output",
  scene: "homepage",
  layout: "full",
  speaker: "tester",
  narrate: "This is the first page. It looks clean and simple.",
  voice: "Samantha",
  capture: { persona: "tester", file: "$TESTDIR/shot1.png" }
})

ux_session_step({
  outputDir: "$TESTDIR/output",
  narrate: "Moving to the second view now.",
  voice: "Samantha",
  capture: { persona: "tester", file: "$TESTDIR/shot2.png" }
})

ux_session_step({
  outputDir: "$TESTDIR/output",
  capture: { persona: "tester", file: "$TESTDIR/shot3.png" }
})

ux_session_end({
  outputDir: "$TESTDIR/output",
  scenarioName: "Pipeline Test"
})
```

### 3. Evaluate

After `ux_session_end` returns, run these checks:

```bash
# Check all expected output files exist
for f in action-log.jsonl session-manifest.json composed-final.mp4 findings.md; do
  [ -f "$TESTDIR/output/$f" ] && echo "✓ $f" || echo "✗ $f MISSING"
done

# Check audio directory has narration files
AUDIO_COUNT=$(ls "$TESTDIR/output/audio/"*.aiff 2>/dev/null | wc -l | tr -d ' ')
echo "✓ Audio files: $AUDIO_COUNT (expected: 2)"

# Analyze the composed video
ffprobe -v quiet -show_entries format=duration -show_entries stream=codec_type -of json "$TESTDIR/output/composed-final.mp4"
```

Then read the ffprobe output and the action-log.jsonl. Evaluate:

| Check | Pass condition |
|-------|---------------|
| Video exists | `composed-final.mp4` is present and > 10KB |
| Audio stream | ffprobe shows `codec_type: "audio"` |
| Video stream | ffprobe shows `codec_type: "video"` |
| Duration | Between 2s and 15s (3 frames + 2 narrations) |
| Action log | Has entries for: 1 scene, 2 narrations, 3 screenshots |
| Audio files | 2 `.aiff` files in `audio/` directory |
| Findings | `findings.md` exists and is non-empty |
| Narration sync | Frames with narration have `durationMs` matching audio duration |

### 4. Report

Print a summary table:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECORDING PIPELINE TEST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ Video: composed-final.mp4 (X.Xs, XXkb)
  ✓ Audio stream: AAC
  ✓ Video stream: H.264
  ✓ Action log: N entries (1 scene, 2 narrations, 3 screenshots)
  ✓ Audio files: 2 narrations generated
  ✓ Findings: findings.md (N bytes)
  ✓ Sync: frame durations match narration audio

  Result: PASS (7/7)
  Output: /tmp/ux-recording-test-XXXXX/output/
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If ALL checks pass, ask: **"Open the video?"**

If yes:
```bash
open "$TESTDIR/output/composed-final.mp4"
```

### 5. Self-fix (if any check fails)

If a check fails:
1. Read the error output and action-log.jsonl
2. Identify the root cause in the source code (`lib/` directory)
3. Fix it
4. Rebuild: `cd /Users/miguel/dev/a8c/ux-simulator && npm run build`
5. Re-run from step 2 (keep the same TESTDIR, delete the output subdir)
6. Max 3 fix attempts — if still failing, report what's broken and stop
