/**
 * Compose Session — Bridge between step-based recording and final video output.
 *
 * Takes a completed session's output directory and produces:
 *   1. Per-scene segment MP4s (from screenshots via frame-assembler)
 *   2. Composed final video with layouts and transitions (via scene-composer)
 *   3. UX findings report (via report-generator)
 *
 * Uses the segment-based path (toSceneSegments → assembleFrames → composeFromSegments)
 * to avoid the timestamp-seeking mismatch of SceneComposer.compose().
 */
import * as fs from 'fs';
import * as path from 'path';
import { StepLog } from './step-log.js';
import { assembleFrames } from './frame-assembler.js';
import { generateSpeechBatch, isDualPersonaLayout } from './ffmpeg-utils.js';
import { SceneComposer } from './scene-composer.js';
import { generateFindings, generateExpertFindings } from './report-generator.js';
import { generateIssueContent } from './issue-generator.js';
import { buildAudioFromSteps, totalDurationMs, writeCompatActionLog, writeCompileLog } from './compile-helpers.js';
/**
 * Build a single scene segment MP4 from its screenshot frames.
 *
 * For dual-persona layouts (split/PIP), assembles primary and secondary
 * tracks separately, then composites them. For single-persona layouts,
 * assembles directly.
 */
function buildSceneSegment(segment, index, tmpDir) {
    const outputPath = path.join(tmpDir, `scene-${index}.mp4`);
    if (segment.primaryFrames.length === 0) {
        throw new Error(`Scene "${segment.name}" has no primary frames`);
    }
    const needsDual = isDualPersonaLayout(segment.layout) && segment.secondaryFrames.length > 0;
    if (!needsDual) {
        // Single-persona: assemble directly
        assembleFrames({
            frames: segment.primaryFrames,
            outputPath,
        });
        return outputPath;
    }
    // Dual-persona: assemble both tracks, then composite
    const primaryPath = path.join(tmpDir, `scene-${index}-primary.mp4`);
    const secondaryPath = path.join(tmpDir, `scene-${index}-secondary.mp4`);
    assembleFrames({
        frames: segment.primaryFrames,
        outputPath: primaryPath,
    });
    const secondaryPersona = guessSecondaryPersona(segment);
    assembleFrames({
        frames: segment.secondaryFrames,
        outputPath: secondaryPath,
    });
    // Use SceneComposer's compose() for a single scene to get the layout
    // We pass the two assembled segment videos as persona videos
    const primaryPersona = segment.speaker ?? 'primary';
    SceneComposer.compose({
        scenes: [{
                name: segment.name,
                layout: segment.layout,
                narration: segment.narration,
                speaker: primaryPersona,
                startMs: 0,
                endMs: totalDurationMs(segment.primaryFrames),
                holdMs: segment.holdMs,
            }],
        personaVideos: {
            [primaryPersona]: primaryPath,
            [secondaryPersona]: secondaryPath,
        },
        outputPath,
        transitionSec: 0,
        skipSubtitles: true,
    });
    // Clean up intermediate files
    for (const f of [primaryPath, secondaryPath]) {
        try {
            fs.unlinkSync(f);
        }
        catch {
            // ignore
        }
    }
    return outputPath;
}
function guessSecondaryPersona(segment) {
    // For PIP layouts, the persona name is in the layout string (pip-<name>)
    if (segment.layout.startsWith('pip-')) {
        return segment.layout.slice(4);
    }
    return 'secondary';
}
/**
 * Compile a step-based recording into a final video with findings.
 *
 * 1. Load steps.jsonl
 * 2. Batch TTS: for each step with observations, generateSpeech → measure duration
 * 3. Build frameDurations map
 * 4. Convert to SceneSegments via stepLog.toSceneSegments()
 * 5. Build audio track from generated TTS
 * 6. Assemble per-scene MP4s and compose final video
 * 7. Write backward-compatible action-log.jsonl for report-generator
 * 8. Generate findings.md
 */
export function compileFromSteps(options) {
    const { outputDir, scenarioName, mode = 'simulator', skipVideo = false, transitionSec = 0.5, skipSubtitles = true, onProgress, } = options;
    const report = (message) => {
        // stderr, not stdout. The MCP server calls this in-process over a
        // stdio transport, where stdout carries the JSON-RPC frames.
        // eslint-disable-next-line no-console
        console.error(message);
        onProgress?.(message);
    };
    const stepLog = StepLog.loadFromDirectory(outputDir);
    const steps = stepLog.getEntries();
    if (steps.length === 0) {
        throw new Error('No steps found in steps.jsonl.');
    }
    const personas = [...new Set(steps.map((s) => s.persona))];
    // Write backward-compatible action-log.jsonl for report-generator
    writeCompatActionLog(steps, outputDir);
    // Generate findings (always — this is the primary output)
    const actionLogPath = path.join(outputDir, 'action-log.jsonl');
    const findingsGenerator = mode === 'expert' ? generateExpertFindings : generateFindings;
    const findings = findingsGenerator({ actionLogPath, scenarioName });
    const findingsPath = path.join(outputDir, 'findings.md');
    fs.writeFileSync(findingsPath, findings.markdown);
    // eslint-disable-next-line no-console
    console.error(`Findings report: ${findingsPath}`);
    // Generate issue-ready content
    const screenshotDir = path.join(outputDir, 'screenshots');
    const issueContent = generateIssueContent({ steps, findings, scenarioName, mode, screenshotDir });
    const issuePath = path.join(outputDir, 'issue.md');
    fs.writeFileSync(issuePath, `# ${issueContent.title}\n\n${issueContent.body}`);
    // eslint-disable-next-line no-console
    console.error(`Issue template: ${issuePath} (${issueContent.screenshots.length} screenshots)`);
    if (skipVideo) {
        // eslint-disable-next-line no-console
        console.error(`Skipping video (skipVideo=true). ${steps.length} steps, ${personas.length} persona(s).`);
        return {
            videoPath: '',
            findingsPath,
            issuePath,
            sceneCount: 0,
            personas,
        };
    }
    // Ensure at least one scene marker — auto-assign if none provided
    const hasScene = steps.some((s) => s.scene);
    if (!hasScene) {
        // eslint-disable-next-line no-console
        console.warn('[compile] No scene markers found in steps — assigning default scene to first step');
        steps[0].scene = scenarioName ?? 'review';
        steps[0].layout = 'full';
    }
    const audioDir = path.join(outputDir, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    // Batch TTS and measure durations
    const frameDurations = new Map();
    const stepAudioFiles = new Map();
    // Per-persona voices, written by ux_record_start (voices.json: { persona: voice })
    let personaVoices = {};
    const voicesPath = path.join(outputDir, 'voices.json');
    if (fs.existsSync(voicesPath)) {
        try {
            personaVoices = JSON.parse(fs.readFileSync(voicesPath, 'utf8'));
        }
        catch {
            // eslint-disable-next-line no-console
            console.warn('[compile] Ignoring unparseable voices.json');
        }
    }
    // Build batch items for all narrated steps
    const batchItems = [];
    for (const step of steps) {
        if (step.observations) {
            batchItems.push({
                stepIndex: step.step,
                item: {
                    text: step.observations,
                    outputPath: path.join(audioDir, `step-${step.step}.aiff`),
                    voice: personaVoices[step.persona],
                },
            });
        }
    }
    report(`Compiling ${steps.length} steps (${batchItems.length} narrated)...`);
    // Single batch call — loads model once
    report(`Generating ${batchItems.length} narration clips…`);
    const batchResults = generateSpeechBatch(batchItems.map((b) => b.item));
    report(`Narration done. Assembling video…`);
    for (let i = 0; i < batchItems.length; i++) {
        const { stepIndex } = batchItems[i];
        const result = batchResults[i];
        if (result.error) {
            // eslint-disable-next-line no-console
            console.warn(`[compile] TTS failed for step ${stepIndex}: ${result.error}`);
            continue;
        }
        const durationMs = Math.round(result.durationSec * 1000);
        frameDurations.set(stepIndex, durationMs);
        stepAudioFiles.set(stepIndex, result.outputPath);
    }
    // eslint-disable-next-line no-console
    console.error(`TTS generated for ${stepAudioFiles.size} narrated steps`);
    // Detect duplicate screenshots
    const duplicates = [];
    for (let i = 1; i < steps.length; i++) {
        if (steps[i].screenshot === steps[i - 1].screenshot) {
            duplicates.push({ step: steps[i].step, screenshot: steps[i].screenshot });
        }
    }
    if (duplicates.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[compile] ${duplicates.length} duplicate screenshot(s) detected:`, duplicates.map((d) => `step ${d.step} (${d.screenshot})`).join(', '));
    }
    // Convert to SceneSegments
    const segments = stepLog.toSceneSegments(frameDurations);
    // eslint-disable-next-line no-console
    console.error(`Composing ${segments.length} scenes for ${personas.length} persona(s): ${personas.join(', ')}`);
    // Build audio track aligned to video frames
    const audioPath = buildAudioFromSteps(steps, segments, stepAudioFiles, frameDurations, outputDir);
    // Build scenes for SceneComposer (needs startMs/endMs)
    let cumulativeMs = 0;
    const scenes = segments.map((seg) => {
        const startMs = cumulativeMs;
        const segDuration = totalDurationMs(seg.primaryFrames);
        cumulativeMs += segDuration;
        return {
            name: seg.name,
            layout: seg.layout,
            narration: seg.narration,
            speaker: seg.speaker,
            startMs,
            endMs: cumulativeMs,
        };
    });
    const tmpDir = path.join(outputDir, '.compose-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
        // Build per-scene segment MP4s
        const scenePaths = segments.map((segment, i) => {
            report(`Encoding scene ${i + 1}/${segments.length}…`);
            return buildSceneSegment(segment, i, tmpDir);
        });
        const finalPath = path.join(outputDir, 'composed-final.mp4');
        report('Composing the final video…');
        SceneComposer.composeFromSegments({
            scenePaths,
            scenes,
            outputPath: finalPath,
            transitionSec,
            skipSubtitles,
            audioPath: audioPath ?? undefined,
        });
        // eslint-disable-next-line no-console
        console.error(`Video composed: ${finalPath}`);
        // Write compile diagnostics log
        writeCompileLog({ steps, segments, stepAudioFiles, frameDurations, duplicates }, outputDir);
        return {
            videoPath: finalPath,
            findingsPath,
            issuePath,
            sceneCount: segments.length,
            personas,
        };
    }
    finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        catch {
            // ignore cleanup errors
        }
    }
}
// CLI entry point
if (process.argv[1] && /compose-session\.[tj]s$/.test(process.argv[1])) {
    const outputDir = process.argv[2];
    if (!outputDir) {
        // eslint-disable-next-line no-console
        console.error('Usage: compose-session.ts <output-dir> [--scenario "name"] [--expert] [--skip-video]');
        process.exit(1);
    }
    let scenarioName;
    const scenarioIdx = process.argv.indexOf('--scenario');
    if (scenarioIdx !== -1 && process.argv[scenarioIdx + 1]) {
        scenarioName = process.argv[scenarioIdx + 1];
    }
    // Reject anything we do not understand. Unknown flags used to be ignored
    // in silence, so `--mode expert` (the MCP spelling) quietly produced a
    // simulator report and there was no way to tell from the output.
    const KNOWN_FLAGS = ['--scenario', '--skip-video', '--expert'];
    const unknown = [];
    for (let i = 3; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === '--scenario') {
            // Skip its value, which may itself start with dashes.
            i++;
            continue;
        }
        if (arg.startsWith('--') && !KNOWN_FLAGS.includes(arg)) {
            unknown.push(arg);
        }
    }
    if (unknown.length) {
        // eslint-disable-next-line no-console
        console.error(`Unknown option(s): ${unknown.join(', ')}\n` +
            `Usage: compose-session.ts <output-dir> [--scenario "name"] [--expert] [--skip-video]\n` +
            `Note: the expert findings mode is --expert here; "mode: expert" is the MCP tool spelling.`);
        process.exit(1);
    }
    const skipVideo = process.argv.includes('--skip-video');
    const mode = process.argv.includes('--expert') ? 'expert' : 'simulator';
    try {
        const result = compileFromSteps({ outputDir, scenarioName, skipVideo, mode });
        // eslint-disable-next-line no-console
        console.log(`\nDone! ${result.sceneCount} scenes, ${result.personas.length} persona(s)`);
        // eslint-disable-next-line no-console
        console.log(`Video: ${result.videoPath}`);
        // eslint-disable-next-line no-console
        console.log(`Findings: ${result.findingsPath}`);
    }
    catch (err) {
        // Surface ffmpeg stderr as text instead of a raw Buffer dump.
        const stderr = err.stderr;
        // eslint-disable-next-line no-console
        console.error(`\nCompile failed: ${err instanceof Error ? err.message : String(err)}`);
        if (stderr) {
            // eslint-disable-next-line no-console
            console.error(`--- ffmpeg stderr (tail) ---\n${stderr.toString().split('\n').slice(-25).join('\n')}`);
        }
        process.exit(1);
    }
}
//# sourceMappingURL=compose-session.js.map