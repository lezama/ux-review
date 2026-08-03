# ux-review

Claude Code plugin for AI-driven UX reviews. It interviews you to build a test
script, drives real browsers through your product, and produces a narrated
video of the session plus a UX findings report.

- `/ux-review` — usability review narrated by a simulated everyday user
- `/ux-expert` — expert heuristic review (IA, visual, copy, flow lenses)

## Install

```
/plugin marketplace add lezama/ux-review
/plugin install ux-review@ux-review-marketplace
```

Requires macOS, Node >= 20, ffmpeg, and Chrome. See [AGENTS.md](./AGENTS.md)
for setup details, TTS engine options, usage, and architecture.

## Output

Each review session produces, under `/tmp/ux-review-<timestamp>/`:

- `composed-final.mp4` — the narrated screen recording
- `findings.md` — UX findings grouped by what worked and what caused friction
- `issue.md` — issue-ready summary with key screenshots

## License

GPL-2.0
