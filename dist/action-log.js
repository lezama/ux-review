import * as fs from 'fs';
import * as path from 'path';
import { isDualPersonaLayout, readJSONL } from './ffmpeg-utils.js';
/**
 * Append-only action log backed by a JSONL file.
 *
 * Each line is a JSON-serialized ActionEntry. Scene markers (action: 'scene')
 * define composition segments; other entries track individual browser actions.
 */
export class ActionLog {
    logPath;
    screenshotDir;
    personas;
    /**
     * Load an existing session's action log without truncating it.
     * Use this for post-recording operations (compose, report).
     */
    static loadFromDirectory(outputDir) {
        const logPath = path.join(outputDir, 'action-log.jsonl');
        const entries = readJSONL(logPath);
        const personas = [...new Set(entries.map((e) => e.persona))];
        const log = Object.create(ActionLog.prototype);
        log.logPath = logPath;
        log.screenshotDir = path.join(outputDir, 'screenshots');
        log.personas = personas.length > 0 ? personas : ['default'];
        return log;
    }
    constructor(outputDir, personas = ['default']) {
        this.logPath = path.join(outputDir, 'action-log.jsonl');
        this.screenshotDir = path.join(outputDir, 'screenshots');
        this.personas = personas;
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        for (const persona of this.personas) {
            fs.mkdirSync(path.join(this.screenshotDir, persona), {
                recursive: true,
            });
        }
        fs.writeFileSync(this.logPath, '');
    }
    append(entry) {
        fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    }
    getEntries() {
        const content = fs.readFileSync(this.logPath, 'utf8').trim();
        if (!content) {
            return [];
        }
        return content.split('\n').map((line) => JSON.parse(line));
    }
    getScreenshotPath(frame, persona) {
        const padded = String(frame).padStart(4, '0');
        return path.join(this.screenshotDir, persona, `${padded}.png`);
    }
    toSceneSegments() {
        const entries = this.getEntries();
        const sceneEntries = entries.filter((e) => e.action === 'scene');
        const screenshots = entries.filter((e) => e.action === 'screenshot' && e.screenshotFile);
        if (sceneEntries.length === 0) {
            return [];
        }
        const lastTimestamp = entries.length > 0
            ? entries[entries.length - 1].timestampMs
            : 0;
        return sceneEntries.map((sceneEntry, i) => {
            const nextScene = sceneEntries[i + 1];
            const sceneEndMs = nextScene
                ? nextScene.timestampMs
                : Infinity;
            const layout = sceneEntry.layout ?? 'full';
            // Determine primary persona from the scene entry
            const primaryPersona = sceneEntry.persona ?? this.personas[0];
            const needsSecondary = isDualPersonaLayout(layout);
            const sceneScreenshots = screenshots.filter((s) => s.timestampMs >= sceneEntry.timestampMs &&
                s.timestampMs < sceneEndMs);
            const primaryShots = sceneScreenshots.filter((s) => s.persona === primaryPersona);
            const secondaryShots = needsSecondary
                ? sceneScreenshots.filter((s) => s.persona !== primaryPersona)
                : [];
            const DEFAULT_DURATION = 1500;
            const MIN_DURATION = 300;
            const buildFrames = (shots) => shots.map((shot, j) => {
                let duration;
                if (shot.durationMs) {
                    duration = shot.durationMs;
                }
                else if (j < shots.length - 1) {
                    duration =
                        shots[j + 1].timestampMs - shot.timestampMs;
                }
                else {
                    duration = DEFAULT_DURATION;
                }
                return {
                    file: path.join(this.screenshotDir, shot.screenshotFile),
                    durationMs: Math.max(MIN_DURATION, duration),
                };
            });
            return {
                name: sceneEntry.target ?? `scene-${i}`,
                layout,
                narration: sceneEntry.narration,
                speaker: sceneEntry.persona,
                primaryFrames: buildFrames(primaryShots),
                secondaryFrames: buildFrames(secondaryShots),
                holdMs: sceneEntry.holdMs,
            };
        });
    }
    toScenes() {
        const entries = this.getEntries();
        const sceneEntries = entries.filter((e) => e.action === 'scene');
        if (sceneEntries.length === 0) {
            return [];
        }
        const lastTimestamp = entries.length > 0
            ? entries[entries.length - 1].timestampMs
            : 0;
        return sceneEntries.map((entry, i) => {
            const nextScene = sceneEntries[i + 1];
            const endMs = nextScene ? nextScene.timestampMs : Infinity;
            return {
                name: entry.target ?? `scene-${i}`,
                layout: entry.layout ?? 'full',
                narration: entry.narration,
                speaker: entry.persona,
                startMs: entry.timestampMs,
                endMs,
                holdMs: entry.holdMs,
            };
        });
    }
    getLogPath() {
        return this.logPath;
    }
    getScreenshotDir() {
        return this.screenshotDir;
    }
}
//# sourceMappingURL=action-log.js.map