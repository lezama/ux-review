/**
 * Compile helpers — audio track assembly and diagnostic artifacts for
 * step-based compilation. Extracted from compose-session.ts to keep the
 * orchestration readable.
 */
import * as fs from 'fs';
import * as path from 'path';
import { concatenateAudio, generateSilence, getFileDuration } from './ffmpeg-utils.js';
function totalDurationMs(frames) {
    return frames.reduce((sum, f) => sum + f.durationMs, 0);
}
/**
 * Build narration audio track from step-based TTS files.
 *
 * Walks segments in video order. For each frame:
 *   - If the step has a TTS audio file, insert it + pad to frame duration
 *   - Otherwise, insert silence for the frame duration
 */
export function buildAudioFromSteps(steps, segments, stepAudioFiles, frameDurations, outputDir) {
    if (stepAudioFiles.size === 0) {
        return null;
    }
    // Build a map: screenshot absolute path → step index
    const screenshotDir = path.join(outputDir, 'screenshots');
    const fileToStep = new Map();
    for (const step of steps) {
        const absPath = path.join(screenshotDir, step.screenshot);
        fileToStep.set(absPath, step.step);
    }
    const tmpDir = path.join(outputDir, '.audio-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
        const segmentFiles = [];
        let silIdx = 0;
        for (const segment of segments) {
            for (const frame of segment.primaryFrames) {
                const stepIdx = fileToStep.get(frame.file);
                const audioFile = stepIdx !== undefined
                    ? stepAudioFiles.get(stepIdx)
                    : undefined;
                if (audioFile && fs.existsSync(audioFile)) {
                    segmentFiles.push(audioFile);
                    // Pad if frame duration > audio duration
                    const audioDurSec = getFileDuration(audioFile);
                    const frameDurSec = frame.durationMs / 1000;
                    const gap = frameDurSec - audioDurSec;
                    if (gap > 0.1) {
                        const silPath = path.join(tmpDir, `sil-${silIdx++}.aiff`);
                        generateSilence(silPath, gap);
                        segmentFiles.push(silPath);
                    }
                    continue;
                }
                // No narration — fill with silence
                if (frame.durationMs > 100) {
                    const silPath = path.join(tmpDir, `sil-${silIdx++}.aiff`);
                    generateSilence(silPath, frame.durationMs / 1000);
                    segmentFiles.push(silPath);
                }
            }
        }
        if (segmentFiles.length === 0) {
            return null;
        }
        const outputPath = path.join(tmpDir, 'narration.m4a');
        concatenateAudio(segmentFiles, outputPath);
        return outputPath;
    }
    catch (err) {
        console.error('[audio] Failed to build step-based narration audio track:', err);
        return null;
    }
}
/**
 * Write a backward-compatible action-log.jsonl from step entries.
 *
 * The report-generator expects ActionEntry format with 'scene', 'narration',
 * and 'screenshot' action types.
 */
export function writeCompatActionLog(steps, outputDir) {
    const logPath = path.join(outputDir, 'action-log.jsonl');
    const lines = [];
    for (const step of steps) {
        // Scene marker
        if (step.scene) {
            lines.push(JSON.stringify({
                frame: step.step,
                timestampMs: step.timestampMs,
                persona: step.persona,
                action: 'scene',
                target: step.scene,
                layout: step.layout ?? 'full',
            }));
        }
        // Narration entry (from observations)
        if (step.observations) {
            lines.push(JSON.stringify({
                frame: step.step,
                timestampMs: step.timestampMs,
                persona: step.persona,
                action: 'narration',
                narration: step.observations,
            }));
        }
        // Screenshot entry
        lines.push(JSON.stringify({
            frame: step.step,
            timestampMs: step.timestampMs,
            persona: step.persona,
            action: 'screenshot',
            screenshotFile: step.screenshot,
        }));
    }
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
}
/**
 * Write a compile diagnostics log with per-step timing, audio info, and warnings.
 */
export function writeCompileLog(diagnostics, outputDir) {
    const { steps, segments, stepAudioFiles, frameDurations, duplicates } = diagnostics;
    const logPath = path.join(outputDir, 'compile-log.jsonl');
    const lines = [];
    const duplicateSteps = new Set(duplicates.map((d) => d.step));
    // Per-step entries
    for (const step of steps) {
        const audioFile = stepAudioFiles.get(step.step);
        const durationMs = frameDurations.get(step.step);
        lines.push(JSON.stringify({
            type: 'step',
            step: step.step,
            persona: step.persona,
            screenshot: step.screenshot,
            scene: step.scene ?? null,
            hasObservations: !!step.observations,
            audioFile: audioFile ? path.basename(audioFile) : null,
            durationMs: durationMs ?? 1500,
            duplicate: duplicateSteps.has(step.step),
        }));
    }
    // Per-scene summary
    let cumulativeMs = 0;
    for (const seg of segments) {
        const segDuration = totalDurationMs(seg.primaryFrames);
        lines.push(JSON.stringify({
            type: 'scene',
            name: seg.name,
            layout: seg.layout,
            speaker: seg.speaker,
            frameCount: seg.primaryFrames.length,
            durationMs: segDuration,
            startMs: cumulativeMs,
            endMs: cumulativeMs + segDuration,
        }));
        cumulativeMs += segDuration;
    }
    // Warnings
    for (const dup of duplicates) {
        lines.push(JSON.stringify({
            type: 'warning',
            category: 'duplicate-screenshot',
            step: dup.step,
            screenshot: dup.screenshot,
        }));
    }
    // Summary
    lines.push(JSON.stringify({
        type: 'summary',
        totalSteps: steps.length,
        totalScenes: segments.length,
        narrated: stepAudioFiles.size,
        silent: steps.length - stepAudioFiles.size,
        duplicates: duplicates.length,
        totalDurationMs: cumulativeMs,
    }));
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
}
//# sourceMappingURL=compile-helpers.js.map