import { StepLog } from './step-log.js';
import type { SceneLayout } from './types.js';
export interface SessionStats {
    totalFrames: number;
    perPersona: Record<string, number>;
    sceneCount: number;
    narrationCount: number;
    durationEstimateMs: number;
    errors: string[];
}
export interface StepRecorderOptions {
    outputDir: string;
    personas: string[];
}
export interface StepCaptureResult {
    step: number;
    verified: boolean;
    screenshot: string;
    warning?: string;
}
/**
 * Simplified recorder that uses step-based logging.
 *
 * No TTS during recording, no action discrimination, no narration pairing.
 * Each step = screenshot + optional observations. TTS happens at compile time.
 */
export declare class StepRecorderSession {
    private outputDir;
    private stepLog;
    private personas;
    private frameCounts;
    private startTime;
    private errors;
    private lastScreenshot;
    constructor(options: StepRecorderOptions);
    /**
     * Get the next screenshot file path for a persona.
     */
    nextScreenshotPath(persona: string): string;
    /**
     * Log a single step: verify screenshot, copy to numbered path, append entry.
     */
    logStep(params: {
        persona: string;
        screenshotFile: string;
        observations?: string;
        nextAction?: string;
        scene?: string;
        layout?: SceneLayout;
    }): StepCaptureResult;
    getStats(): SessionStats;
    getOutputDir(): string;
    getScreenshotDir(): string;
    getPersonas(): string[];
    getStepLog(): StepLog;
    finalize(): SessionStats;
    private verifyFile;
    private assertPersona;
}
