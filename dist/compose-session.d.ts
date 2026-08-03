import type { FindingsMode } from './report-generator.js';
export interface ComposeResult {
    videoPath: string;
    findingsPath: string;
    issuePath?: string;
    sceneCount: number;
    personas: string[];
}
export interface CompileFromStepsOptions {
    outputDir: string;
    scenarioName?: string;
    mode?: FindingsMode;
    skipVideo?: boolean;
    transitionSec?: number;
    skipSubtitles?: boolean;
}
/**
 * Compile a step-based recording into a final video with findings.
 *
 * 1. Load steps.jsonl
 * 2. Batch TTS: for each step with observations, generateSpeech → measure duration
 * 3. Build frameDurations map
 * 4. Convert to SceneSegments via stepLog.toSceneSegments()
 * 5. Build audio track from generated TTS
 * 6. Assemble per-scene MP4s and compose final video
 * 7. Write backward-compatible action-log.jsonl for report-generator
 * 8. Generate findings.md
 */
export declare function compileFromSteps(options: CompileFromStepsOptions): ComposeResult;
