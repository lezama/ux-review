/**
 * Frame Assembler — Build video from timestamped screenshot PNGs.
 *
 * For headless Chrome recordings where screencapture isn't available.
 * Takes an array of PNG frames with durations and assembles them into
 * an MP4 using per-image loop inputs and the concat filter.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ENCODE_PRESET, OUTPUT_HEIGHT, OUTPUT_WIDTH, SCALE_PAD_FILTER, TALL_IMAGE_THRESHOLD, getImageDimensions } from './ffmpeg-utils.js';
/**
 * Assemble PNG frames into an MP4 video.
 *
 * Each frame is looped for its specified duration, then all are joined
 * with the concat filter. This avoids the concat demuxer's timebase
 * issues that cause incorrect durations with `-r` output.
 */
export function assembleFrames(options) {
    const { frames, outputPath, fps = 30, label } = options;
    if (frames.length === 0) {
        throw new Error('No frames to assemble');
    }
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    const labelStyle = "fontsize=32:fontcolor=white:borderw=2:bordercolor=black:font='Helvetica'";
    const labelFilter = label
        ? `,drawtext=text='${label}':${labelStyle}:x=40:y=40`
        : '';
    // Build per-frame inputs.
    // For normal frames: -loop 1 -t <duration> -i <file>
    // For tall frames (zoompan): single -i <file> (zoompan generates its own frames)
    const inputParts = [];
    const filterParts = [];
    const concatInputs = [];
    for (let i = 0; i < frames.length; i++) {
        const absPath = path.resolve(frames[i].file);
        const durSec = (frames[i].durationMs / 1000).toFixed(3);
        const dims = getImageDimensions(absPath);
        const aspectRatio = dims.height && dims.width ? dims.height / dims.width : 0;
        const isTall = aspectRatio > TALL_IMAGE_THRESHOLD && dims.height > OUTPUT_HEIGHT;
        if (isTall) {
            // Tall screenshot: use zoompan to smoothly scroll top-to-bottom.
            // Scale width to OUTPUT_WIDTH first, then pan vertically.
            inputParts.push(`-i ${JSON.stringify(absPath)}`);
            const totalFrames = Math.max(1, Math.ceil(parseFloat(durSec) * fps));
            const scaledHeight = Math.round(dims.height * (OUTPUT_WIDTH / dims.width));
            const panDistance = Math.max(0, scaledHeight - OUTPUT_HEIGHT);
            const panSpeed = panDistance / totalFrames;
            filterParts.push(`[${i}:v]scale=${OUTPUT_WIDTH}:-1,zoompan=z='1':x='0':y='min(y+${panSpeed.toFixed(4)}\\,ih-oh)':d=${totalFrames}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${fps},format=yuv420p,setsar=1[v${i}]`);
        }
        else {
            // Normal screenshot: static hold with scale+pad.
            inputParts.push(`-loop 1 -t ${durSec} -i ${JSON.stringify(absPath)}`);
            filterParts.push(`[${i}:v]${SCALE_PAD_FILTER},format=yuv420p[v${i}]`);
        }
        concatInputs.push(`[v${i}]`);
    }
    const inputs = inputParts.join(' ');
    filterParts.push(`${concatInputs.join('')}concat=n=${frames.length}:v=1:a=0[vraw]`);
    // Apply label if present
    if (label) {
        filterParts.push(`[vraw]drawtext=text='${label}':${labelStyle}:x=40:y=40[vout]`);
    }
    else {
        // Rename for consistent output label
        filterParts.push('[vraw]null[vout]');
    }
    const filterComplex = filterParts.join('; ');
    const cmd = [
        `ffmpeg -y ${inputs}`,
        `-filter_complex "${filterComplex}"`,
        '-map "[vout]"',
        ENCODE_PRESET,
        `-r ${fps}`,
        '-an',
        JSON.stringify(outputPath),
    ].join(' ');
    execSync(cmd, { stdio: 'pipe', timeout: 300_000 });
    return outputPath;
}
//# sourceMappingURL=frame-assembler.js.map