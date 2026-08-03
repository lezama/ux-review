import type { Scene, SceneLayout } from './narrator.js';
export interface ActionEntry {
    /** Frame index (maps to screenshot PNG filename) */
    frame: number;
    /** Milliseconds since recording start (real wall-clock) */
    timestampMs: number;
    /** Which browser persona performed this action */
    persona: string;
    /** What was done */
    action: 'screenshot' | 'click' | 'fill' | 'navigate' | 'wait' | 'scene' | 'narration' | 'pause' | 'resume';
    /** Human-readable target description */
    target?: string;
    /** Narration text for this scene (spoken by macOS `say`) */
    narration?: string;
    /** Layout for video composition */
    layout?: SceneLayout;
    /** Hold the final frame of this scene for extra time (ms) */
    holdMs?: number;
    /** Relative path to the screenshot PNG (e.g., "admin/0003.png") */
    screenshotFile?: string;
    /** Per-frame hold duration override for pacing (ms) */
    durationMs?: number;
    /** Relative path to narration audio file (e.g., "audio/narr-0.aiff") */
    audioFile?: string;
}
export interface SceneSegment {
    /** Scene name */
    name: string;
    /** Layout for this scene */
    layout: SceneLayout;
    /** Narration text */
    narration?: string;
    /** Speaker persona */
    speaker?: string;
    /** Frames for the primary persona, with durations */
    primaryFrames: Array<{
        file: string;
        durationMs: number;
    }>;
    /** Frames for the secondary persona (for split/PIP layouts) */
    secondaryFrames: Array<{
        file: string;
        durationMs: number;
    }>;
    /** Hold the final frame extra (ms) */
    holdMs?: number;
}
/**
 * Append-only action log backed by a JSONL file.
 *
 * Each line is a JSON-serialized ActionEntry. Scene markers (action: 'scene')
 * define composition segments; other entries track individual browser actions.
 */
export declare class ActionLog {
    private logPath;
    private screenshotDir;
    private personas;
    /**
     * Load an existing session's action log without truncating it.
     * Use this for post-recording operations (compose, report).
     */
    static loadFromDirectory(outputDir: string): ActionLog;
    constructor(outputDir: string, personas?: string[]);
    append(entry: ActionEntry): void;
    getEntries(): ActionEntry[];
    getScreenshotPath(frame: number, persona: string): string;
    toSceneSegments(): SceneSegment[];
    toScenes(): Scene[];
    getLogPath(): string;
    getScreenshotDir(): string;
}
