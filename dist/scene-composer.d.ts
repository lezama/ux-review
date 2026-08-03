import type { Scene } from './types.js';
interface SceneComposeOptions {
    scenes: readonly Scene[];
    /** Map of persona name to video file path */
    personaVideos: Record<string, string>;
    outputPath: string;
    /** Offset (ms) per persona between scene startTime and recording start */
    personaOffsets?: Record<string, number>;
    /** Cross-fade transition duration in seconds */
    transitionSec?: number;
    /** Skip subtitle generation and burn-in */
    skipSubtitles?: boolean;
}
/**
 * Scene-based video composition engine.
 *
 * Two-pass ffmpeg pipeline:
 *   Pass 1: Extract each scene segment, apply layout + labels -> intermediate MP4s
 *   Pass 2: Join scenes with xfade transitions -> final MP4
 *
 * Audio is generated per-scene via macOS `say`, positioned at correct offsets.
 */
export declare class SceneComposer {
    static assertDependencies(): void;
    /**
     * Compose a final video from pre-built per-scene MP4 segments.
     */
    static composeFromSegments(options: {
        scenePaths: string[];
        scenes: readonly Scene[];
        outputPath: string;
        transitionSec?: number;
        skipSubtitles?: boolean;
        /** Pre-built narration audio file. If provided, skips internal TTS generation. */
        audioPath?: string;
    }): string;
    static compose(options: SceneComposeOptions): string;
}
export {};
