/**
 * Video trimmer — removes frozen frames (dead time) from recordings.
 *
 * Uses ffmpeg's freezedetect filter to find static sections, keeps 1s
 * of each freeze as a natural pause, removes the rest.
 *
 * Usage:
 *   node --loader ts-node/esm lib/trimmer.ts <input.mp4> <output.mp4> [freeze-threshold-sec]
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ENCODE_PRESET, getFileDuration } from './ffmpeg-utils.js';
/**
 * Trim frozen frames from a video file.
 *
 * @param inputPath - Path to the input video
 * @param outputPath - Path for the trimmed output
 * @param freezeThreshold - Minimum freeze duration in seconds to detect (default: 3)
 * @param keepDuration - How much of each freeze to keep as a pause (default: 1)
 */
export function trimVideo(inputPath, outputPath, freezeThreshold = 3, keepDuration = 1) {
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Input file not found: ${inputPath}`);
    }
    // Run freezedetect — ffmpeg writes filter output to stderr
    let stderr;
    try {
        execSync(`ffmpeg -i ${JSON.stringify(inputPath)} -vf "freezedetect=n=-60dB:d=${freezeThreshold}" -f null - 2>&1`, { encoding: 'utf8' });
        stderr = '';
    }
    catch (e) {
        // ffmpeg returns non-zero but we still get output
        stderr = e.stdout ?? '';
    }
    const freezes = [];
    let freezeStart = null;
    for (const line of stderr.split('\n')) {
        const startMatch = line.match(/freeze_start:\s*([\d.]+)/);
        if (startMatch) {
            freezeStart = parseFloat(startMatch[1]);
        }
        const endMatch = line.match(/freeze_end:\s*([\d.]+)/);
        if (endMatch && freezeStart !== null) {
            freezes.push([freezeStart, parseFloat(endMatch[1])]);
            freezeStart = null;
        }
    }
    if (freezes.length === 0) {
        fs.copyFileSync(inputPath, outputPath);
        const duration = getFileDuration(inputPath);
        return {
            outputPath,
            originalDuration: duration,
            trimmedDuration: duration,
            removedDuration: 0,
            freezeCount: 0,
        };
    }
    const totalDuration = getFileDuration(inputPath);
    // Build "keep" segments
    const segments = [];
    let pos = 0;
    for (const [fStart, fEnd] of freezes) {
        if (fStart > pos) {
            segments.push([pos, fStart]);
        }
        segments.push([fStart, Math.min(fStart + keepDuration, fEnd)]);
        pos = fEnd;
    }
    if (pos < totalDuration) {
        segments.push([pos, totalDuration]);
    }
    // Filter tiny segments
    const validSegments = segments.filter(([s, e]) => e - s >= 0.1);
    if (validSegments.length === 0) {
        throw new Error('No segments to keep after trimming');
    }
    // Extract and concatenate
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-'));
    try {
        const segmentFiles = [];
        for (let i = 0; i < validSegments.length; i++) {
            const [start, end] = validSegments[i];
            const segFile = path.join(tmpDir, `seg-${String(i).padStart(4, '0')}.mp4`);
            segmentFiles.push(segFile);
            execSync(`ffmpeg -y -ss ${start.toFixed(3)} -to ${end.toFixed(3)} -i ${JSON.stringify(inputPath)} ${ENCODE_PRESET} -an ${JSON.stringify(segFile)}`, { stdio: 'ignore' });
        }
        const concatFile = path.join(tmpDir, 'concat.txt');
        fs.writeFileSync(concatFile, segmentFiles.map((f) => `file '${f}'`).join('\n'));
        execSync(`ffmpeg -y -f concat -safe 0 -i ${JSON.stringify(concatFile)} ${ENCODE_PRESET} -an ${JSON.stringify(outputPath)}`, { stdio: 'ignore' });
        const trimmedDuration = validSegments.reduce((sum, [s, e]) => sum + (e - s), 0);
        return {
            outputPath,
            originalDuration: totalDuration,
            trimmedDuration,
            removedDuration: totalDuration - trimmedDuration,
            freezeCount: freezes.length,
        };
    }
    finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}
// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('trimmer.ts')) {
    const input = process.argv[2];
    const output = process.argv[3];
    const threshold = parseFloat(process.argv[4] ?? '3');
    if (!input || !output) {
        console.error('Usage: trimmer.ts <input.mp4> <output.mp4> [freeze-threshold-sec]');
        process.exit(1);
    }
    const result = trimVideo(input, output, threshold);
    console.log(`Trimmed: ${result.originalDuration.toFixed(1)}s -> ${result.trimmedDuration.toFixed(1)}s (removed ${result.removedDuration.toFixed(1)}s from ${result.freezeCount} frozen sections)`);
}
//# sourceMappingURL=trimmer.js.map