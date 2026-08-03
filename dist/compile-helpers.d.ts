import type { SceneSegment } from './types.js';
import type { StepEntry } from './step-log.js';
/**
 * Build narration audio track from step-based TTS files.
 *
 * Walks segments in video order. For each frame:
 *   - If the step has a TTS audio file, insert it + pad to frame duration
 *   - Otherwise, insert silence for the frame duration
 */
export declare function buildAudioFromSteps(steps: StepEntry[], segments: SceneSegment[], stepAudioFiles: Map<number, string>, frameDurations: Map<number, number>, outputDir: string): string | null;
/**
 * Write a backward-compatible action-log.jsonl from step entries.
 *
 * The report-generator expects ActionEntry format with 'scene', 'narration',
 * and 'screenshot' action types.
 */
export declare function writeCompatActionLog(steps: StepEntry[], outputDir: string): void;
interface CompileDiagnostics {
    steps: StepEntry[];
    segments: SceneSegment[];
    stepAudioFiles: Map<number, string>;
    frameDurations: Map<number, number>;
    duplicates: Array<{
        step: number;
        screenshot: string;
    }>;
}
/**
 * Write a compile diagnostics log with per-step timing, audio info, and warnings.
 */
export declare function writeCompileLog(diagnostics: CompileDiagnostics, outputDir: string): void;
export {};
