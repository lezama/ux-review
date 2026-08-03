/** Standard video encoding flags used across all ffmpeg operations. */
export declare const ENCODE_PRESET = "-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p";
/** Standard audio encoding flags. */
export declare const AUDIO_PRESET = "-c:a aac -b:a 128k";
/** Standard output resolution. */
export declare const OUTPUT_WIDTH = 1920;
export declare const OUTPUT_HEIGHT = 1080;
/** Scale-and-pad filter to normalize frames to OUTPUT_WIDTH x OUTPUT_HEIGHT. */
export declare const SCALE_PAD_FILTER = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1";
/**
 * Get the pixel dimensions of an image file via ffprobe.
 */
export declare function getImageDimensions(filePath: string): {
    width: number;
    height: number;
};
/** Aspect ratio threshold: images taller than this get zoompan scroll. */
export declare const TALL_IMAGE_THRESHOLD: number;
/**
 * Get the duration of a media file in seconds via ffprobe.
 * Returns 0 on error (never a phantom duration).
 */
export declare function getFileDuration(filePath: string): number;
/**
 * Generate a silent audio file of the given duration.
 */
export declare function generateSilence(outputPath: string, durationSec: number): void;
/**
 * Concatenate multiple audio files into a single AAC output.
 * For a single file, converts directly without the concat filter.
 */
export declare function concatenateAudio(files: string[], outputPath: string): void;
/**
 * Format milliseconds as SRT timestamp: HH:MM:SS,mmm
 */
export declare function formatSRTTime(ms: number): string;
/**
 * Check whether a layout requires two persona video tracks.
 */
export declare function isDualPersonaLayout(layout: string): boolean;
/**
 * Generate speech audio from text.
 *
 * Engine priority: Qwen3-TTS > Kokoro > macOS say.
 * Override with TTS_ENGINE env var (qwen | kokoro | say).
 *
 * @param text - Text to speak
 * @param outputPath - Output audio file path (.aiff, .wav, or .mp3)
 * @param voice - Voice name (macOS say name — auto-mapped per engine)
 */
export declare function generateSpeech(text: string, outputPath: string, voice?: string): void;
export interface BatchTTSItem {
    text: string;
    outputPath: string;
    voice?: string;
}
export interface BatchTTSResult {
    outputPath: string;
    durationSec: number;
    error?: string;
}
/**
 * Generate speech for multiple texts in a single process invocation.
 *
 * For qwen: uses qwen-batch.py (loads model once, generates all clips).
 * For kokoro/say: falls back to sequential generateSpeech calls.
 *
 * Returns results in the same order as inputs.
 */
export declare function generateSpeechBatch(items: BatchTTSItem[]): BatchTTSResult[];
/**
 * Read and parse a JSONL file into an array of typed entries.
 */
export declare function readJSONL<T>(filePath: string): T[];
