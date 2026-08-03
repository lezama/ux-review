# /test-recording — Automated Recording Pipeline Test

Run a headless end-to-end test of the UX recording pipeline. No browser needed — uses dummy PNGs to exercise the full flow: MCP tools → step log → TTS → video composition → findings.

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
ux_record_start({
  outputDir: "$TESTDIR/output",
  personas: ["tester"]
})
```

Copy the dummy PNGs into the screenshot directory returned by start, then:

```
ux_record_step({
  outputDir: "$TESTDIR/output",
  persona: "tester",
  screenshot: "$TESTDIR/output/screenshots/tester/0000.png",
  observations: "This is the first page. It looks clean and simple.",
  scene: "homepage",
  layout: "full"
})

ux_record_step({
  outputDir: "$TESTDIR/output",
  persona: "tester",
  screenshot: "$TESTDIR/output/screenshots/tester/0001.png",
  observations: "Moving to the second view now."
})

ux_record_step({
  outputDir: "$TESTDIR/output",
  persona: "tester",
  screenshot: "$TESTDIR/output/screenshots/tester/0002.png"
})

ux_record_compile({
  outputDir: "$TESTDIR/output",
  scenarioName: "Pipeline Test"
})
```

Note: Before each `ux_record_step`, copy the corresponding dummy PNG to the screenshot path (e.g., `cp $TESTDIR/shot1.png $TESTDIR/output/screenshots/tester/0000.png`).

### 3. Evaluate

After `ux_record_compile` returns, run these checks:

```bash
# Check all expected output files exist
for f in steps.jsonl session-manifest.json composed-final.mp4 findings.md; do
  [ -f "$TESTDIR/output/$f" ] && echo "✓ $f" || echo "✗ $f MISSING"
done

# Check audio directory has narration files
AUDIO_COUNT=$(ls "$TESTDIR/output/audio/"*.aiff 2>/dev/null | wc -l | tr -d ' ')
echo "✓ Audio files: $AUDIO_COUNT (expected: 2)"

# Analyze the composed video
ffprobe -v quiet -show_entries format=duration -show_entries stream=codec_type -of json "$TESTDIR/output/composed-final.mp4"
```

Then read the ffprobe output and the steps.jsonl. Evaluate:

| Check | Pass condition |
|-------|---------------|
| Video exists | `composed-final.mp4` is present and > 10KB |
| Audio stream | ffprobe shows `codec_type: "audio"` |
| Video stream | ffprobe shows `codec_type: "video"` |
| Duration | Between 2s and 15s (3 frames + 2 narrations) |
| Steps log | `steps.jsonl` has 3 entries (1 with scene, 2 with observations) |
| Audio files | 2 `.aiff` files in `audio/` directory |
| Findings | `findings.md` exists and is non-empty |
| Narration sync | Steps with observations have matching TTS audio files |

### 4. Report

Print a summary table:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECORDING PIPELINE TEST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ Video: composed-final.mp4 (X.Xs, XXkb)
  ✓ Audio stream: AAC
  ✓ Video stream: H.264
  ✓ Steps log: N entries (1 scene, 2 observations)
  ✓ Audio files: 2 narrations generated
  ✓ Findings: findings.md (N bytes)
  ✓ Sync: TTS audio files match narrated steps

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
1. Read the error output and steps.jsonl
2. Identify the root cause in the source code (`lib/` directory)
3. Fix it
4. Rebuild: `npm run build   # from the repo root`
5. Re-run from step 2 (keep the same TESTDIR, delete the output subdir)
6. Max 3 fix attempts — if still failing, report what's broken and stop
