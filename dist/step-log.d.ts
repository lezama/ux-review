import type { SceneLayout, SceneSegment } from './types.js';
export interface StepEntry {
    /** Auto-incremented step number */
    step: number;
    /** Wall-clock ms since session start */
    timestampMs: number;
    /** Which persona is acting */
    persona: string;
    /** Relative path to screenshot PNG (e.g., "admin/0003.png") */
    screenshot: string;
    /** What the tester observes — becomes narration audio at compile time */
    observations?: string;
    /** What they'll do next (context only, not spoken) */
    nextAction?: string;
    /** Start a new scene (omit to continue current scene) */
    scene?: string;
    /** Layout for the scene: full | split | pip-<name> */
    layout?: SceneLayout;
}
/**
 * Append-only step log backed by a JSONL file.
 *
 * Simpler than ActionLog — one entry type, no action discrimination,
 * no TTS during recording.
 */
export declare class StepLog {
    private logPath;
    private screenshotDir;
    private stepCount;
    constructor(outputDir: string, personas: string[]);
    /**
     * Load an existing step log without truncating.
     */
    static loadFromDirectory(outputDir: string): StepLog;
    append(entry: StepEntry): void;
    getEntries(): StepEntry[];
    getStepCount(): number;
    getLogPath(): string;
    getScreenshotDir(): string;
    /**
     * Convert steps to SceneSegments for video composition.
     *
     * @param frameDurations - Map of step index → duration in ms (from TTS audio).
     *                         Steps without an entry get DEFAULT_FRAME_DURATION.
     */
    toSceneSegments(frameDurations: Map<number, number>): SceneSegment[];
}
