/**
 * Step Log — Declarative step-based recording format.
 *
 * Each step = { screenshot, observations, nextAction }. TTS moves to compile
 * time. Frame duration = narration audio duration. No pairing heuristics needed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isDualPersonaLayout } from './ffmpeg-utils.js';
export const DEFAULT_FRAME_DURATION = 1500;
const MIN_FRAME_DURATION = 300;
/**
 * Append-only step log backed by a JSONL file.
 *
 * Simpler than ActionLog — one entry type, no action discrimination,
 * no TTS during recording.
 */
export class StepLog {
    logPath;
    screenshotDir;
    stepCount = 0;
    constructor(outputDir, personas) {
        this.logPath = path.join(outputDir, 'steps.jsonl');
        this.screenshotDir = path.join(outputDir, 'screenshots');
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        for (const persona of personas) {
            fs.mkdirSync(path.join(this.screenshotDir, persona), {
                recursive: true,
            });
        }
        // Start fresh
        fs.writeFileSync(this.logPath, '');
    }
    /**
     * Load an existing step log without truncating.
     */
    static loadFromDirectory(outputDir) {
        const log = Object.create(StepLog.prototype);
        log.logPath = path.join(outputDir, 'steps.jsonl');
        log.screenshotDir = path.join(outputDir, 'screenshots');
        const entries = log.getEntries();
        log.stepCount = entries.length;
        return log;
    }
    append(entry) {
        fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
        this.stepCount++;
    }
    getEntries() {
        if (!fs.existsSync(this.logPath)) {
            return [];
        }
        const content = fs.readFileSync(this.logPath, 'utf8').trim();
        if (!content) {
            return [];
        }
        return content.split('\n').map((line) => JSON.parse(line));
    }
    getStepCount() {
        return this.stepCount;
    }
    getLogPath() {
        return this.logPath;
    }
    getScreenshotDir() {
        return this.screenshotDir;
    }
    /**
     * Convert steps to SceneSegments for video composition.
     *
     * @param frameDurations - Map of step index → duration in ms (from TTS audio).
     *                         Steps without an entry get DEFAULT_FRAME_DURATION.
     */
    toSceneSegments(frameDurations) {
        const entries = this.getEntries();
        if (entries.length === 0) {
            return [];
        }
        // Group steps by scene boundaries
        const sceneGroups = [];
        let currentGroup = null;
        for (const entry of entries) {
            if (entry.scene || !currentGroup) {
                // Start a new scene group
                currentGroup = {
                    name: entry.scene ?? `scene-${sceneGroups.length}`,
                    layout: entry.layout ?? 'full',
                    speaker: entry.persona,
                    steps: [],
                };
                sceneGroups.push(currentGroup);
            }
            // Update layout if specified mid-scene
            if (entry.layout && !entry.scene) {
                currentGroup.layout = entry.layout;
            }
            currentGroup.steps.push(entry);
        }
        // Convert groups to SceneSegments
        return sceneGroups.map((group) => {
            const primaryPersona = group.speaker;
            const needsSecondary = isDualPersonaLayout(group.layout);
            const primarySteps = group.steps.filter((s) => s.persona === primaryPersona);
            const secondarySteps = needsSecondary
                ? group.steps.filter((s) => s.persona !== primaryPersona)
                : [];
            const buildFrames = (steps) => steps.map((s) => {
                const duration = frameDurations.get(s.step) ?? DEFAULT_FRAME_DURATION;
                return {
                    file: path.join(this.screenshotDir, s.screenshot),
                    durationMs: Math.max(MIN_FRAME_DURATION, duration),
                };
            });
            // Collect narration text from observations
            const narration = group.steps
                .map((s) => s.observations)
                .filter(Boolean)
                .join(' ');
            return {
                name: group.name,
                layout: group.layout,
                narration: narration || undefined,
                speaker: primaryPersona,
                primaryFrames: buildFrames(primarySteps),
                secondaryFrames: buildFrames(secondarySteps),
            };
        });
    }
}
//# sourceMappingURL=step-log.js.map