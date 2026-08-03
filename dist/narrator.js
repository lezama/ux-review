import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { concatenateAudio, formatSRTTime, generateSilence, generateSpeech, getFileDuration, } from './ffmpeg-utils.js';
/**
 * Records timestamped narration steps during a simulation, then generates
 * audio (macOS `say`) and subtitles (SRT) after completion.
 *
 * Supports scene-based composition: call `scene()` to declare layout changes.
 * When scenes are present, route to SceneComposer for multi-persona video.
 */
export class Narrator {
    steps = [];
    scenes = [];
    startTime = Date.now();
    step(text, speaker) {
        this.steps.push({
            timestamp: Date.now() - this.startTime,
            text,
            speaker,
        });
    }
    scene(config) {
        const now = Date.now() - this.startTime;
        if (this.scenes.length > 0) {
            const prev = this.scenes[this.scenes.length - 1];
            if (prev.endMs === undefined) {
                prev.endMs = now;
            }
        }
        this.scenes.push({
            name: config.name,
            layout: config.layout,
            narration: config.narration,
            speaker: config.speaker,
            startMs: now,
            holdMs: config.holdMs,
        });
        if (config.narration) {
            this.steps.push({
                timestamp: now,
                text: config.narration,
                speaker: config.speaker ?? 'narrator',
            });
        }
    }
    finalize() {
        if (this.scenes.length > 0) {
            const last = this.scenes[this.scenes.length - 1];
            if (last.endMs === undefined) {
                last.endMs = Date.now() - this.startTime;
            }
        }
    }
    getScenes() {
        return this.scenes;
    }
    getStartTime() {
        return this.startTime;
    }
    generateAudio(outputDir) {
        if (this.steps.length === 0) {
            throw new Error('No narration steps recorded');
        }
        fs.mkdirSync(outputDir, { recursive: true });
        const segmentFiles = [];
        for (let i = 0; i < this.steps.length; i++) {
            const step = this.steps[i];
            const aiffPath = path.join(outputDir, `segment-${i}.aiff`);
            generateSpeech(step.text, aiffPath, step.speaker || undefined);
            segmentFiles.push(aiffPath);
            if (i < this.steps.length - 1) {
                const nextStep = this.steps[i + 1];
                const gapMs = nextStep.timestamp - step.timestamp;
                const speechDuration = getFileDuration(aiffPath);
                const gapAfterSpeech = Math.max(0, gapMs / 1000 - speechDuration);
                if (gapAfterSpeech > 0.1) {
                    const silencePath = path.join(outputDir, `silence-${i}.aiff`);
                    generateSilence(silencePath, gapAfterSpeech);
                    segmentFiles.push(silencePath);
                }
            }
        }
        const outputPath = path.join(outputDir, 'narration.m4a');
        if (segmentFiles.length === 1) {
            execSync(`ffmpeg -y -i ${JSON.stringify(segmentFiles[0])} -c:a aac -b:a 128k ${JSON.stringify(outputPath)}`, { stdio: 'ignore' });
        }
        else {
            concatenateAudio(segmentFiles, outputPath);
        }
        for (const f of segmentFiles) {
            try {
                fs.unlinkSync(f);
            }
            catch {
                // ignore cleanup errors
            }
        }
        return outputPath;
    }
    exportSRT(outputPath) {
        const lines = [];
        for (let i = 0; i < this.steps.length; i++) {
            const step = this.steps[i];
            const startMs = step.timestamp;
            const endMs = i < this.steps.length - 1
                ? this.steps[i + 1].timestamp
                : startMs + 4000;
            const label = `[${step.speaker}]`;
            lines.push(`${i + 1}`, `${formatSRTTime(startMs)} --> ${formatSRTTime(endMs)}`, `${label} ${step.text}`, '');
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, lines.join('\n'));
    }
    getSteps() {
        return this.steps;
    }
}
//# sourceMappingURL=narrator.js.map