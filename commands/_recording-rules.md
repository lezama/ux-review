<!-- Shared recording rules — included by ux-review, ux-expert, simulator, and expert agents -->

### Recording Rules

**CRITICAL RULES:**
- **The first step MUST have a `scene` field.** Without at least one scene marker, compilation fails.
- **The field is `observations` (plural)**, not `observation`.
- **Max 2 sentences per observations.** Split longer thoughts into separate steps.
- **Take screenshots liberally.** Every click, every form field, every transition. 8-15 screenshots per task.
- **Most steps should be silent.** Only narrate when there's something worth saying.
- **Never reuse the same screenshot.** Always take a fresh one after each action.
- A frozen frame for >10 seconds is unwatchable.

### The `ux_record_step` Tool

**Use `ux_record_step` for ALL recording operations.** Each step = screenshot + observations. One tool call, NO permission prompts, NO TTS blocking:

```
ux_record_step({
  outputDir: "/tmp/ux-review-XXXXX",
  persona: "admin",
  screenshot: "/path/to/screenshot.png",
  observations: "I see the login page.",
  scene: "login",
  layout: "full"
})
```

Fields:
- `persona` + `screenshot` — always required
- `observations` — what the tester sees (becomes narration audio at compile time)
- `nextAction` — what they'll do next (context only, not spoken)
- `scene` — starts a new scene (omit to continue current scene)
- `layout` — scene layout: `full` | `split` | `pip-<name>`

### Recording Rhythm

1. **Take screenshot** → **record step** (with scene + observations)
2. **Act** in browser (click, fill, navigate)
3. **Take screenshot** → **record step** (with or without observations)
4. Repeat from step 2

**Take a screenshot after EVERY browser action** — clicks, fills, navigations, hovers. Most steps won't have observations and that's fine. Silent frames get a short default duration (1.5s) and make the video feel like a real screen recording instead of a slideshow.

### Browser Preparation

Before recording each persona:
- **Hide automation infobar**: Inject CSS via `evaluate_script` after each navigation
- **Fullscreen**: Press F11 to remove browser chrome
- **Correct login**: Ensure each persona is logged in as their role

### See the Page Like a User

**Use `take_screenshot` to see the page, then Read the screenshot to understand what's visible.** Never use `evaluate_script` to inspect HTML/DOM for deciding what to narrate or where to click. Base all observations and decisions on what you can **see** in the screenshots.
