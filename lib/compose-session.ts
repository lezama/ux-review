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
import type { SceneSegment } from './action-log.js';
import { StepLog } from './step-log.js';
import type { StepEntry } from './step-log.js';
import { assembleFrames } from './frame-assembler.js';
import { concatenateAudio, generateSilence, generateSpeech, getFileDuration, isDualPersonaLayout } from './ffmpeg-utils.js';
import { SceneComposer } from './scene-composer.js';
import { generateFindings, generateExpertFindings } from './report-generator.js';
import type { FindingsMode } from './report-generator.js';

export interface ComposeResult {
	videoPath: string;
	findingsPath: string;
	sceneCount: number;
	personas: string[];
}

/**
 * Build a single scene segment MP4 from its screenshot frames.
 *
 * For dual-persona layouts (split/PIP), assembles primary and secondary
 * tracks separately, then composites them. For single-persona layouts,
 * assembles directly.
 */
function buildSceneSegment(
	segment: SceneSegment,
	index: number,
	tmpDir: string
): string {
	const outputPath = path.join( tmpDir, `scene-${ index }.mp4` );

	if ( segment.primaryFrames.length === 0 ) {
		throw new Error(
			`Scene "${ segment.name }" has no primary frames`
		);
	}

	const needsDual = isDualPersonaLayout( segment.layout ) && segment.secondaryFrames.length > 0;

	if ( ! needsDual ) {
		// Single-persona: assemble directly
		assembleFrames( {
			frames: segment.primaryFrames,
			outputPath,
		} );
		return outputPath;
	}

	// Dual-persona: assemble both tracks, then composite
	const primaryPath = path.join( tmpDir, `scene-${ index }-primary.mp4` );
	const secondaryPath = path.join( tmpDir, `scene-${ index }-secondary.mp4` );

	assembleFrames( {
		frames: segment.primaryFrames,
		outputPath: primaryPath,
	} );

	const secondaryPersona = guessSecondaryPersona( segment );
	assembleFrames( {
		frames: segment.secondaryFrames,
		outputPath: secondaryPath,
	} );

	// Use SceneComposer's compose() for a single scene to get the layout
	// We pass the two assembled segment videos as persona videos
	const primaryPersona = segment.speaker ?? 'primary';
	SceneComposer.compose( {
		scenes: [ {
			name: segment.name,
			layout: segment.layout,
			narration: segment.narration,
			speaker: primaryPersona,
			startMs: 0,
			endMs: totalDurationMs( segment.primaryFrames ),
			holdMs: segment.holdMs,
		} ],
		personaVideos: {
			[ primaryPersona ]: primaryPath,
			[ secondaryPersona ]: secondaryPath,
		},
		outputPath,
		transitionSec: 0,
		skipSubtitles: true,
	} );

	// Clean up intermediate files
	for ( const f of [ primaryPath, secondaryPath ] ) {
		try {
			fs.unlinkSync( f );
		} catch {
			// ignore
		}
	}

	return outputPath;
}

function totalDurationMs(
	frames: Array< { durationMs: number } >
): number {
	return frames.reduce( ( sum, f ) => sum + f.durationMs, 0 );
}

function guessSecondaryPersona( segment: SceneSegment ): string {
	// For PIP layouts, the persona name is in the layout string (pip-<name>)
	if ( segment.layout.startsWith( 'pip-' ) ) {
		return segment.layout.slice( 4 );
	}
	return 'secondary';
}

// ---------------------------------------------------------------------------
// Step-based compilation (new pipeline)
// ---------------------------------------------------------------------------

export interface CompileFromStepsOptions {
	outputDir: string;
	scenarioName?: string;
	mode?: FindingsMode;
	transitionSec?: number;
	skipSubtitles?: boolean;
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
export function compileFromSteps( options: CompileFromStepsOptions ): ComposeResult {
	const {
		outputDir,
		scenarioName,
		mode = 'simulator',
		transitionSec = 0.5,
		skipSubtitles = true,
	} = options;

	const stepLog = StepLog.loadFromDirectory( outputDir );
	const steps = stepLog.getEntries();

	if ( steps.length === 0 ) {
		throw new Error( 'No steps found in steps.jsonl.' );
	}

	// Ensure at least one scene marker — auto-assign if none provided
	const hasScene = steps.some( ( s ) => s.scene );
	if ( ! hasScene ) {
		// eslint-disable-next-line no-console
		console.warn( '[compile] No scene markers found in steps — assigning default scene to first step' );
		steps[ 0 ].scene = scenarioName ?? 'review';
		steps[ 0 ].layout = 'full';
	}

	const audioDir = path.join( outputDir, 'audio' );
	fs.mkdirSync( audioDir, { recursive: true } );

	// Batch TTS and measure durations
	const frameDurations = new Map< number, number >();
	const stepAudioFiles = new Map< number, string >();

	// eslint-disable-next-line no-console
	console.log( `Compiling ${ steps.length } steps...` );

	for ( const step of steps ) {
		if ( step.observations ) {
			const audioFile = path.join( audioDir, `step-${ step.step }.aiff` );
			generateSpeech( step.observations, audioFile );
			const durationSec = getFileDuration( audioFile );
			const durationMs = Math.round( durationSec * 1000 );
			frameDurations.set( step.step, durationMs );
			stepAudioFiles.set( step.step, audioFile );
		}
	}

	// eslint-disable-next-line no-console
	console.log( `TTS generated for ${ stepAudioFiles.size } narrated steps` );

	// Detect duplicate screenshots
	const duplicates: Array< { step: number; screenshot: string } > = [];
	for ( let i = 1; i < steps.length; i++ ) {
		if ( steps[ i ].screenshot === steps[ i - 1 ].screenshot ) {
			duplicates.push( { step: steps[ i ].step, screenshot: steps[ i ].screenshot } );
		}
	}
	if ( duplicates.length > 0 ) {
		// eslint-disable-next-line no-console
		console.warn( `[compile] ${ duplicates.length } duplicate screenshot(s) detected:`,
			duplicates.map( ( d ) => `step ${ d.step } (${ d.screenshot })` ).join( ', ' ) );
	}

	// Convert to SceneSegments
	const segments = stepLog.toSceneSegments( frameDurations );
	const personas = [ ...new Set( steps.map( ( s ) => s.persona ) ) ];

	// eslint-disable-next-line no-console
	console.log(
		`Composing ${ segments.length } scenes for ${ personas.length } persona(s): ${ personas.join( ', ' ) }`
	);

	// Build audio track aligned to video frames
	const audioPath = buildAudioFromSteps( steps, segments, stepAudioFiles, frameDurations, outputDir );

	// Build scenes for SceneComposer (needs startMs/endMs)
	let cumulativeMs = 0;
	const scenes = segments.map( ( seg ) => {
		const startMs = cumulativeMs;
		const segDuration = totalDurationMs( seg.primaryFrames );
		cumulativeMs += segDuration;
		return {
			name: seg.name,
			layout: seg.layout,
			narration: seg.narration,
			speaker: seg.speaker,
			startMs,
			endMs: cumulativeMs,
		};
	} );

	const tmpDir = path.join( outputDir, '.compose-tmp' );
	fs.mkdirSync( tmpDir, { recursive: true } );

	try {
		// Build per-scene segment MP4s
		const scenePaths = segments.map( ( segment, i ) =>
			buildSceneSegment( segment, i, tmpDir )
		);

		const finalPath = path.join( outputDir, 'composed-final.mp4' );

		SceneComposer.composeFromSegments( {
			scenePaths,
			scenes,
			outputPath: finalPath,
			transitionSec,
			skipSubtitles,
			audioPath: audioPath ?? undefined,
		} );

		// eslint-disable-next-line no-console
		console.log( `Video composed: ${ finalPath }` );

		// Write backward-compatible action-log.jsonl for report-generator
		writeCompatActionLog( steps, outputDir );

		// Generate findings
		const actionLogPath = path.join( outputDir, 'action-log.jsonl' );
		const findingsGenerator = mode === 'expert' ? generateExpertFindings : generateFindings;
		const findings = findingsGenerator( { actionLogPath, scenarioName } );
		const findingsPath = path.join( outputDir, 'findings.md' );
		fs.writeFileSync( findingsPath, findings.markdown );

		// eslint-disable-next-line no-console
		console.log( `Findings report: ${ findingsPath }` );

		// Write compile diagnostics log
		writeCompileLog( { steps, segments, stepAudioFiles, frameDurations, duplicates }, outputDir );

		return {
			videoPath: finalPath,
			findingsPath,
			sceneCount: segments.length,
			personas,
		};
	} finally {
		try {
			fs.rmSync( tmpDir, { recursive: true, force: true } );
		} catch {
			// ignore cleanup errors
		}
	}
}

/**
 * Build narration audio track from step-based TTS files.
 *
 * Walks segments in video order. For each frame:
 *   - If the step has a TTS audio file, insert it + pad to frame duration
 *   - Otherwise, insert silence for the frame duration
 */
function buildAudioFromSteps(
	steps: StepEntry[],
	segments: SceneSegment[],
	stepAudioFiles: Map< number, string >,
	frameDurations: Map< number, number >,
	outputDir: string
): string | null {
	if ( stepAudioFiles.size === 0 ) {
		return null;
	}

	// Build a map: screenshot absolute path → step index
	const screenshotDir = path.join( outputDir, 'screenshots' );
	const fileToStep = new Map< string, number >();
	for ( const step of steps ) {
		const absPath = path.join( screenshotDir, step.screenshot );
		fileToStep.set( absPath, step.step );
	}

	const tmpDir = path.join( outputDir, '.audio-tmp' );
	fs.mkdirSync( tmpDir, { recursive: true } );

	try {
		const segmentFiles: string[] = [];
		let silIdx = 0;

		for ( const segment of segments ) {
			for ( const frame of segment.primaryFrames ) {
				const stepIdx = fileToStep.get( frame.file );
				const audioFile = stepIdx !== undefined
					? stepAudioFiles.get( stepIdx )
					: undefined;

				if ( audioFile && fs.existsSync( audioFile ) ) {
					segmentFiles.push( audioFile );

					// Pad if frame duration > audio duration
					const audioDurSec = getFileDuration( audioFile );
					const frameDurSec = frame.durationMs / 1000;
					const gap = frameDurSec - audioDurSec;
					if ( gap > 0.1 ) {
						const silPath = path.join( tmpDir, `sil-${ silIdx++ }.aiff` );
						generateSilence( silPath, gap );
						segmentFiles.push( silPath );
					}
					continue;
				}

				// No narration — fill with silence
				if ( frame.durationMs > 100 ) {
					const silPath = path.join( tmpDir, `sil-${ silIdx++ }.aiff` );
					generateSilence( silPath, frame.durationMs / 1000 );
					segmentFiles.push( silPath );
				}
			}
		}

		if ( segmentFiles.length === 0 ) {
			return null;
		}

		const outputPath = path.join( tmpDir, 'narration.m4a' );
		concatenateAudio( segmentFiles, outputPath );
		return outputPath;
	} catch ( err ) {
		console.error( '[audio] Failed to build step-based narration audio track:', err );
		return null;
	}
}

/**
 * Write a backward-compatible action-log.jsonl from step entries.
 *
 * The report-generator expects ActionEntry format with 'scene', 'narration',
 * and 'screenshot' action types.
 */
function writeCompatActionLog( steps: StepEntry[], outputDir: string ): void {
	const logPath = path.join( outputDir, 'action-log.jsonl' );
	const lines: string[] = [];

	for ( const step of steps ) {
		// Scene marker
		if ( step.scene ) {
			lines.push( JSON.stringify( {
				frame: step.step,
				timestampMs: step.timestampMs,
				persona: step.persona,
				action: 'scene',
				target: step.scene,
				layout: step.layout ?? 'full',
			} ) );
		}

		// Narration entry (from observations)
		if ( step.observations ) {
			lines.push( JSON.stringify( {
				frame: step.step,
				timestampMs: step.timestampMs,
				persona: step.persona,
				action: 'narration',
				narration: step.observations,
			} ) );
		}

		// Screenshot entry
		lines.push( JSON.stringify( {
			frame: step.step,
			timestampMs: step.timestampMs,
			persona: step.persona,
			action: 'screenshot',
			screenshotFile: step.screenshot,
		} ) );
	}

	fs.writeFileSync( logPath, lines.join( '\n' ) + '\n' );
}

interface CompileDiagnostics {
	steps: StepEntry[];
	segments: SceneSegment[];
	stepAudioFiles: Map< number, string >;
	frameDurations: Map< number, number >;
	duplicates: Array< { step: number; screenshot: string } >;
}

/**
 * Write a compile diagnostics log with per-step timing, audio info, and warnings.
 */
function writeCompileLog( diagnostics: CompileDiagnostics, outputDir: string ): void {
	const { steps, segments, stepAudioFiles, frameDurations, duplicates } = diagnostics;
	const logPath = path.join( outputDir, 'compile-log.jsonl' );
	const lines: string[] = [];
	const duplicateSteps = new Set( duplicates.map( ( d ) => d.step ) );

	// Per-step entries
	for ( const step of steps ) {
		const audioFile = stepAudioFiles.get( step.step );
		const durationMs = frameDurations.get( step.step );

		lines.push( JSON.stringify( {
			type: 'step',
			step: step.step,
			persona: step.persona,
			screenshot: step.screenshot,
			scene: step.scene ?? null,
			hasObservations: !! step.observations,
			audioFile: audioFile ? path.basename( audioFile ) : null,
			durationMs: durationMs ?? 1500,
			duplicate: duplicateSteps.has( step.step ),
		} ) );
	}

	// Per-scene summary
	let cumulativeMs = 0;
	for ( const seg of segments ) {
		const segDuration = totalDurationMs( seg.primaryFrames );
		lines.push( JSON.stringify( {
			type: 'scene',
			name: seg.name,
			layout: seg.layout,
			speaker: seg.speaker,
			frameCount: seg.primaryFrames.length,
			durationMs: segDuration,
			startMs: cumulativeMs,
			endMs: cumulativeMs + segDuration,
		} ) );
		cumulativeMs += segDuration;
	}

	// Warnings
	for ( const dup of duplicates ) {
		lines.push( JSON.stringify( {
			type: 'warning',
			category: 'duplicate-screenshot',
			step: dup.step,
			screenshot: dup.screenshot,
		} ) );
	}

	// Summary
	lines.push( JSON.stringify( {
		type: 'summary',
		totalSteps: steps.length,
		totalScenes: segments.length,
		narrated: stepAudioFiles.size,
		silent: steps.length - stepAudioFiles.size,
		duplicates: duplicates.length,
		totalDurationMs: cumulativeMs,
	} ) );

	fs.writeFileSync( logPath, lines.join( '\n' ) + '\n' );
}

// CLI entry point
if ( process.argv[ 1 ] && process.argv[ 1 ].endsWith( 'compose-session.ts' ) ) {
	const outputDir = process.argv[ 2 ];
	if ( ! outputDir ) {
		// eslint-disable-next-line no-console
		console.error( 'Usage: compose-session.ts <output-dir> [--scenario "name"]' );
		process.exit( 1 );
	}

	let scenarioName: string | undefined;
	const scenarioIdx = process.argv.indexOf( '--scenario' );
	if ( scenarioIdx !== -1 && process.argv[ scenarioIdx + 1 ] ) {
		scenarioName = process.argv[ scenarioIdx + 1 ];
	}

	const result = compileFromSteps( { outputDir, scenarioName } );
	// eslint-disable-next-line no-console
	console.log( `\nDone! ${ result.sceneCount } scenes, ${ result.personas.length } persona(s)` );
	// eslint-disable-next-line no-console
	console.log( `Video: ${ result.videoPath }` );
	// eslint-disable-next-line no-console
	console.log( `Findings: ${ result.findingsPath }` );
}
