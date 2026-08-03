interface NarrationStep {
    timestamp: number;
    text: string;
    speaker: string;
}
/**
 * Layout identifier for video composition.
 *
 * - 'full': Single persona fills the screen
 * - 'split': Two personas side by side
 * - `pip-${string}`: Picture-in-picture with named persona as overlay
 */
export type SceneLayout = 'full' | 'split' | `pip-${string}`;
export interface Scene {
    name: string;
    layout: SceneLayout;
    narration?: string;
    speaker?: string;
    startMs: number;
    endMs?: number;
    holdMs?: number;
}
/**
 * Records timestamped narration steps during a simulation, then generates
 * audio (macOS `say`) and subtitles (SRT) after completion.
 *
 * Supports scene-based composition: call `scene()` to declare layout changes.
 * When scenes are present, route to SceneComposer for multi-persona video.
 */
export declare class Narrator {
    private steps;
    private scenes;
    private startTime;
    step(text: string, speaker: string): void;
    scene(config: {
        name: string;
        layout: SceneLayout;
        narration?: string;
        speaker?: string;
        holdMs?: number;
    }): void;
    finalize(): void;
    getScenes(): readonly Scene[];
    getStartTime(): number;
    generateAudio(outputDir: string): string;
    exportSRT(outputPath: string): void;
    getSteps(): readonly NarrationStep[];
}
export {};
