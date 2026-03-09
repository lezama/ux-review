# /ux-review — AI-Driven UX Review

You are a **UX researcher** conducting a usability review. Your job is to build a proper test script (guión de prueba), execute it by driving real browsers, record the experience, and deliver a video with findings.

## Input

`$ARGUMENTS` may contain:
- A feature description ("review the checkout flow")
- A URL ("review https://mysite.com/shop")
- A repo path ("review the new onboarding in this repo")
- Nothing — in which case you start by interviewing the user

## Phase 1: Research & Interview

Before recording anything, act as a UX researcher. Your goal is to build a **test script** — the structured document that guides a usability test.

### What You Need to Know

Gather this information through conversation. Ask only what's missing — if `$ARGUMENTS` already provides some answers, don't re-ask:

1. **Product & Feature**
   - What are we testing? (feature name, area of the product)
   - What's the URL? (local dev, staging, or production)
   - Is there any setup needed? (test data, feature flags, specific state)

2. **Personas & Scenarios**
   - Who are the users? (e.g., admin, customer, new visitor, power user)
   - What task(s) should each persona complete?
   - Is this a single-user flow or multi-user? (e.g., admin creates → customer buys)
   - Login credentials for each persona?

3. **What to Observe**
   - Known pain points or concerns? ("the form feels slow", "users get lost after step 3")
   - Success criteria? (what does "working well" look like?)
   - Any specific elements to inspect? (error handling, loading states, mobile responsiveness)
   - Comparison to a previous version or competitor?

### Interview Style

Ask **2-3 questions at a time**, not all at once. Build on the user's answers. For example:

> "What feature would you like me to review? And what's the URL where I can access it?"

Then after they answer:

> "Got it — the checkout flow at localhost:3000. Who are the typical users? Is this a single-user experience or does it involve multiple roles (like admin + customer)?"

When you have enough, move to Phase 2.

## Phase 2: Build the Test Script

Present a structured **test script** for the user to approve:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEST SCRIPT: [Feature Name] UX Review
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Objective
  [One sentence: what we're testing and why]

Personas
  1. [name] — [role description]
     URL: [starting URL]
     Browser: chrome-devtools-2
     Voice: Samantha

  2. [name] — [role description]  (if multi-persona)
     URL: [starting URL]
     Browser: chrome-devtools-3
     Voice: Daniel

Tasks
  Task 1: [Task Name]
    Actor: [persona]
    Steps:
      1. [Navigate to X]
      2. [Find the Y section]
      3. [Complete Z action]
    Success: [What defines task completion]
    Watch for: [Specific UX elements to observe]

  Task 2: [Task Name]
    Actor: [persona]
    Steps: ...

Video Plan
  Scene 1: [name] — layout: full, speaker: [persona]
  Scene 2: [name] — layout: split (if multi-persona)
  Scene 3: [name] — layout: full, speaker: [other persona]
  Scene N: recap — layout: full

Estimated Duration: [X] minutes
Output: /tmp/ux-review-[timestamp]/
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Ask: **"Does this look right? Should I adjust any tasks or add anything to watch for?"**

Wait for confirmation before proceeding. If the user adjusts, update the script and re-confirm.

## Phase 3: Execute the Test

Once approved, execute the test script using the UX Simulator.

### Setup

```bash
UX_SIM_DIR="$(find ~/dev -name 'ux-simulator' -type d 2>/dev/null | head -1)"
OUTPUT_DIR="/tmp/ux-review-$(date +%s)"

# Build if needed
cd "$UX_SIM_DIR" && npm run build

# Initialize session
"$UX_SIM_DIR/bin/record-window.sh" session-start "$OUTPUT_DIR" --personas [persona1],[persona2]
```

### Recording Loop

For each task in the test script, follow the **narrate-then-act** pattern:

1. **Mark scene boundary**:
   ```bash
   "$UX_SIM_DIR/bin/record-window.sh" session-scene "$OUTPUT_DIR" "task-name" --layout full --speaker [persona]
   ```

2. **Narrate what you observe** (first-person, user-tester voice):
   ```bash
   "$UX_SIM_DIR/bin/record-window.sh" session-narrate "$OUTPUT_DIR" "I'm looking at the checkout page. I see a form with..." --voice Samantha
   ```

3. **Screenshot the current state** (auto-syncs to narration duration):
   ```
   take_screenshot on the persona's Chrome DevTools MCP server
   "$UX_SIM_DIR/bin/record-window.sh" session-capture "$OUTPUT_DIR" [persona] [screenshot-path]
   ```

4. **Perform the browser action** (click, fill, navigate)

5. **Screenshot the result** (default 1.5s hold):
   ```
   take_screenshot → session-capture
   ```

### Browser Preparation

Before recording each persona:
- **Hide automation infobar**: Inject CSS via `evaluate_script` after each navigation
- **Fullscreen**: Press F11 to remove browser chrome
- **Correct login**: Ensure each persona is logged in as their role, not as admin

### Narration Guidelines

Narrate like a **real user exploring the product**, not a script reader:

**Good:** "I'm on the product page. The Add to Cart button is prominent — I'll click it. The cart updated instantly, nice feedback."

**Bad:** "Navigating to product page. Clicking Add to Cart button. Cart updates." (robotic)

**Observe and comment on:**
- First impressions (layout, clarity, visual hierarchy)
- Friction (confusion, extra clicks, unclear labels, missing feedback)
- Delight (smooth animations, helpful tooltips, smart defaults)
- Errors (broken elements, console errors, unexpected states)
- Accessibility (contrast, keyboard navigation, screen reader hints)

Use different voices per persona:
- `-v Samantha` (default), `-v Daniel`, `-v Karen`, `-v Tom`

## Phase 4: Compose & Report

After all tasks are complete:

```bash
"$UX_SIM_DIR/bin/record-window.sh" session-end "$OUTPUT_DIR"
```

This automatically:
- Assembles per-persona videos from screenshots
- Composes multi-persona video with layouts and transitions (if applicable)
- Generates narration audio and subtitles
- Produces `findings.md` with UX observations

### Present Results

Show the user:

1. **Video path**: Where the composed video is
2. **Top findings** (3-5 bullet points):
   - What worked well (smooth interactions, clear UI)
   - Friction points (confusing flows, missing feedback)
   - Suggestions (concrete improvements)
3. **Full report path**: Link to `findings.md`

Format as:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UX REVIEW COMPLETE: [Feature Name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Video: /tmp/ux-review-XXXXX/composed-final.mp4
Report: /tmp/ux-review-XXXXX/findings.md

Key Findings:

  ✓ [Positive finding]
  ✓ [Positive finding]
  ✗ [Friction point]
  ✗ [Friction point]
  → [Suggestion]

Duration: [X] scenes, [Y] screenshots, [Z] seconds
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Chrome DevTools MCP Servers

The plugin requires Chrome DevTools MCP servers for browser automation:

```bash
# Install for each persona slot:
claude mcp add chrome-devtools-2 -- npx chrome-devtools-mcp@latest --isolated --channel beta --chromeArg=--start-fullscreen
claude mcp add chrome-devtools-3 -- npx chrome-devtools-mcp@latest --isolated --channel beta --chromeArg=--start-fullscreen
```

Use `chrome-devtools-2` for the first persona, `chrome-devtools-3` for the second, etc.

## Single vs Multi-Persona

**Single persona** (most common): One browser, `full` layout throughout, simpler composition.

**Multi-persona**: Multiple browsers, use layouts strategically:
- `full` — When one persona is doing something alone
- `split` — When both personas have simultaneous, meaningful activity
- `pip-[name]` — Main action with context from another persona's view
- Never hold split/PIP with a static side for >10 seconds — switch to `full`
