/**
 * Recorder — Step-based recording orchestrator.
 *
 * The agent calls Chrome DevTools MCP `take_screenshot` and then calls
 * `logStep()` to verify and log each frame with optional observations.
 * TTS happens at compile time, not during recording.
 *
 * Usage pattern (from the agent):
 *   const session = new StepRecorderSession({ outputDir, personas: ['admin'] });
 *   // agent calls: take_screenshot({ filePath: path })
 *   session.logStep({ persona: 'admin', screenshotFile: path, observations: '...' });
 *   // ...repeat for each frame...
 *   session.finalize();
 */
import * as fs from 'fs';
import * as path from 'path';
import { StepLog } from './step-log.js';
const MIN_SCREENSHOT_BYTES = 1024;
/**
 * Simplified recorder that uses step-based logging.
 *
 * No TTS during recording, no action discrimination, no narration pairing.
 * Each step = screenshot + optional observations. TTS happens at compile time.
 */
export class StepRecorderSession {
    outputDir;
    stepLog;
    personas;
    frameCounts = {};
    startTime;
    errors = [];
    lastScreenshot = null;
    constructor(options) {
        this.outputDir = options.outputDir;
        this.personas = options.personas;
        this.startTime = Date.now();
        fs.mkdirSync(this.outputDir, { recursive: true });
        this.stepLog = new StepLog(this.outputDir, this.personas);
        for (const name of this.personas) {
            this.frameCounts[name] = 0;
        }
    }
    /**
     * Get the next screenshot file path for a persona.
     */
    nextScreenshotPath(persona) {
        this.assertPersona(persona);
        const frame = this.frameCounts[persona];
        const padded = String(frame).padStart(4, '0');
        return path.join(this.stepLog.getScreenshotDir(), persona, `${padded}.png`);
    }
    /**
     * Log a single step: verify screenshot, copy to numbered path, append entry.
     */
    logStep(params) {
        this.assertPersona(params.persona);
        const verified = this.verifyFile(params.screenshotFile);
        if (!verified) {
            this.errors.push(`Step ${this.stepLog.getStepCount()} for ${params.persona} failed verification: ${params.screenshotFile}`);
        }
        const relPath = path.relative(this.stepLog.getScreenshotDir(), params.screenshotFile);
        const entry = {
            step: this.stepLog.getStepCount(),
            timestampMs: Date.now() - this.startTime,
            persona: params.persona,
            screenshot: relPath,
            observations: params.observations,
            nextAction: params.nextAction,
            scene: params.scene,
            layout: params.layout,
        };
        this.stepLog.append(entry);
        this.frameCounts[params.persona]++;
        // Detect duplicate screenshot (same file used in consecutive steps)
        let warning;
        if (this.lastScreenshot === params.screenshotFile) {
            warning = `Duplicate screenshot: ${relPath} was already used in the previous step. Take a fresh screenshot to avoid a repeated frame in the video.`;
            this.errors.push(`Step ${entry.step}: ${warning}`);
        }
        this.lastScreenshot = params.screenshotFile;
        return {
            step: entry.step,
            verified,
            screenshot: relPath,
            warning,
        };
    }
    getStats() {
        const totalFrames = Object.values(this.frameCounts)
            .reduce((sum, n) => sum + n, 0);
        const entries = this.stepLog.getEntries();
        const sceneCount = entries.filter((e) => e.scene).length;
        const narrationCount = entries.filter((e) => e.observations).length;
        return {
            totalFrames,
            perPersona: { ...this.frameCounts },
            sceneCount,
            narrationCount,
            durationEstimateMs: Date.now() - this.startTime,
            errors: [...this.errors],
        };
    }
    getOutputDir() {
        return this.outputDir;
    }
    getScreenshotDir() {
        return this.stepLog.getScreenshotDir();
    }
    getPersonas() {
        return [...this.personas];
    }
    getStepLog() {
        return this.stepLog;
    }
    finalize() {
        const stats = this.getStats();
        const manifest = {
            format: 'step-based',
            startTime: new Date(this.startTime).toISOString(),
            endTime: new Date().toISOString(),
            outputDir: this.outputDir,
            stepLog: this.stepLog.getLogPath(),
            screenshotDir: this.stepLog.getScreenshotDir(),
            personas: Object.fromEntries(this.personas.map((name) => [
                name,
                { frames: this.frameCounts[name] },
            ])),
            stats,
        };
        fs.writeFileSync(path.join(this.outputDir, 'session-manifest.json'), JSON.stringify(manifest, null, 2));
        return stats;
    }
    verifyFile(filePath) {
        try {
            const stat = fs.statSync(filePath);
            return stat.size >= MIN_SCREENSHOT_BYTES;
        }
        catch {
            return false;
        }
    }
    assertPersona(persona) {
        if (!this.personas.includes(persona)) {
            throw new Error(`Unknown persona "${persona}". Known: ${this.personas.join(', ')}`);
        }
    }
}
//# sourceMappingURL=recorder.js.map