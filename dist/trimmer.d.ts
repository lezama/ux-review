interface TrimResult {
    outputPath: string;
    originalDuration: number;
    trimmedDuration: number;
    removedDuration: number;
    freezeCount: number;
}
/**
 * Trim frozen frames from a video file.
 *
 * @param inputPath - Path to the input video
 * @param outputPath - Path for the trimmed output
 * @param freezeThreshold - Minimum freeze duration in seconds to detect (default: 3)
 * @param keepDuration - How much of each freeze to keep as a pause (default: 1)
 */
export declare function trimVideo(inputPath: string, outputPath: string, freezeThreshold?: number, keepDuration?: number): TrimResult;
export {};
