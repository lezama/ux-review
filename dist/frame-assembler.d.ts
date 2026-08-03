export interface FrameInput {
    /** Absolute or relative path to the PNG screenshot */
    file: string;
    /** How long to hold this frame (milliseconds) */
    durationMs: number;
}
export interface AssembleOptions {
    /** Ordered array of frames with durations */
    frames: FrameInput[];
    /** Output MP4 file path */
    outputPath: string;
    /** Target framerate (default: 30) */
    fps?: number;
    /** Optional label drawn on the video (e.g., persona name) */
    label?: string;
}
/**
 * Assemble PNG frames into an MP4 video.
 *
 * Each frame is looped for its specified duration, then all are joined
 * with the concat filter. This avoids the concat demuxer's timebase
 * issues that cause incorrect durations with `-r` output.
 */
export declare function assembleFrames(options: AssembleOptions): string;
