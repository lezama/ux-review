# /ux-sim — UX Simulation Recording

Run a UX simulation and recording session. Describe the scenario in natural language.

## Input

`$ARGUMENTS` contains the scenario description. It can be:
- Free-form natural language describing what to test and record
- A path to a scenario file (`.md` or `.yaml`)
- A brief description that you'll expand into a full plan

## Workflow

1. **Parse the scenario**: Identify personas, URLs, steps, and desired output
2. **Confirm the plan**: Present your interpretation back to the user before executing
3. **Set up browsers**: Assign Chrome MCP servers to each persona
4. **Prepare browsers for recording**: Hide automation artifacts (see below)
5. **Start recording**: Use `bin/record-window.sh` to capture each persona's window
6. **Execute steps**: Drive each persona through their flow via Chrome DevTools MCP
7. **Narrate findings**: Generate user-testing style voiceover (see below)
8. **Compose video**: Split, trim, and compose the final video with narration
9. **Report**: Show the recording summary and any UX observations

**Headless mode:** If Chrome is headless, skip recording setup (step 5). Instead, take screenshots after every action and run `record-window.sh assemble` after the scenario completes.

## Browser Preparation

Before recording, clean up each browser so the video looks polished:

- **Hide "Chrome is being controlled" infobar**: After each `navigate_page`, run `evaluate_script` to inject CSS that hides the automation infobar
- **Enter fullscreen mode**: Press F11 on each browser to hide browser chrome before recording starts
- **Storefront personas should not be logged in as admin**: Log out first, then log in as the correct customer user. Never rely on auto-login for customer personas

## Narration Style

Narrate like a **user tester exploring the app** — first person, present tense, describing what you see and do:

- "I'm on the shop page. I can see two products: a Gift Card and a Demo T-Shirt."
- "I'll click on the Gift Card. It shows price options from 25 to 150 dollars."
- "The checkout automatically applied my gift card balance. Nice — the total is now zero."

Log narration text in the action log alongside screenshots. Include real UX observations — things that are surprising, confusing, or well-designed.

Use macOS `say` with natural voices. Vary by persona:
- Admin: `say -v Samantha`
- Buyer: `say -v Daniel`
- Recipient: `say -v Karen`

## Example

```
/ux-sim Test the login flow:
1. Navigate to http://localhost:9001/wp-login.php
2. Enter username "admin" and password "password"
3. Click "Log In"
4. Verify we land on the dashboard
Record the whole thing.
```

## Chrome MCP Servers

Available browser instances (configure in `.claude/settings.json`):
- `chrome-devtools`: Main agent browser (persistent profile)
- `chrome-devtools-2`: Isolated session (persona 1)
- `chrome-devtools-3`: Isolated session (persona 2)

Assign personas to servers based on the scenario needs.

## Recording Tools

Located in `bin/` and `lib/`:
- `bin/record-window.sh session-start|session-scene|session-narrate|session-capture|session-end` — Session-based recording (primary)
- `bin/record-window.sh start|switch|stop|split|trim|assemble` — Legacy screencapture (fallback)
- `lib/scene-composer.ts` — Multi-persona video composition
- `lib/narrator.ts` — TTS narration + SRT subtitles
- `lib/trimmer.ts` — Dead time removal
- `lib/report-generator.ts` — Recording validation
- `lib/action-log.ts` — JSONL action tracking

## Narration-Screenshot Sync

`session-narrate` auto-syncs timing: it writes a pending duration that the next `session-capture` consumes. No manual `--duration` flag needed. The action log tracks narration entries alongside screenshots so the assembler knows exactly how long each frame should display.

## Output

All recordings go to `/tmp/ux-sim-output-<timestamp>/` by default. The final output includes:
- Per-persona trimmed videos (`<persona>-trimmed.mp4`)
- Composed final video (`composed-final.mp4`) if multi-persona
- Action log (`action-log.jsonl`)
- Recording report (printed to console)
