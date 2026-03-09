/**
 * Compose Session — Bridge between recording and final video output.
 *
 * Takes a completed session's output directory and produces:
 *   1. Per-scene segment MP4s (from screenshots via frame-assembler)
 *   2. Composed final video with layouts and transitions (via scene-composer)
 *   3. UX findings report (via report-generator)
 *
 * Uses the segment-based path (toSceneSegments → assembleFrames → composeFromSegments)
 * to avoid the timestamp-seeking mismatch of SceneComposer.compose().
 *
 * Usage:
 *   node --loader ts-node/esm lib/compose-session.ts <output-dir> [--scenario "name"]
 */
import * as fs from 'fs';
import * as path from 'path';
import { ActionLog } from './action-log.js';
import type { ActionEntry, SceneSegment } from './action-log.js';
import { assembleFrames } from './frame-assembler.js';
import { concatenateAudio, generateSilence, getFileDuration, isDualPersonaLayout } from './ffmpeg-utils.js';
import { SceneComposer } from './scene-composer.js';
import { generateFindings } from './report-generator.js';

export interface ComposeSessionOptions {
	outputDir: string;
	scenarioName?: string;
	transitionSec?: number;
	skipSubtitles?: boolean;
}

export interface ComposeResult {
	videoPath: string;
	findingsPath: string;
	sceneCount: number;
	personas: string[];
}

/**
 * Compose a completed recording session into a final video with findings.
 */
export function composeSession( options: ComposeSessionOptions ): ComposeResult {
	const {
		outputDir,
		scenarioName,
		transitionSec = 0.5,
		skipSubtitles = true,
	} = options;

	const actionLog = ActionLog.loadFromDirectory( outputDir );
	const segments = actionLog.toSceneSegments();
	const scenes = actionLog.toScenes();

	if ( segments.length === 0 ) {
		throw new Error(
			'No scene markers found in action log. Use session-scene to mark scenes during recording.'
		);
	}

	// Enrich scenes with narration text from narration entries
	const allEntries = actionLog.getEntries();
	const narrationEntries = allEntries.filter( ( e ) => e.action === 'narration' );

	for ( const scene of scenes ) {
		const sceneEnd = scene.endMs ?? Infinity;
		const sceneNarrations = narrationEntries.filter(
			( n ) => n.timestampMs >= scene.startMs && n.timestampMs < sceneEnd
		);
		if ( sceneNarrations.length > 0 && ! scene.narration ) {
			scene.narration = sceneNarrations
				.map( ( n ) => n.narration )
				.filter( Boolean )
				.join( ' ' );
		}
	}

	// Build narration audio from pre-generated files, timed to match video frames
	const audioPath = buildAudioFromActionLog( allEntries, segments, outputDir );

	const personas = [ ...new Set( segments.map( ( s ) => s.speaker ).filter( Boolean ) ) ] as string[];
	// eslint-disable-next-line no-console
	console.log(
		`Composing ${ segments.length } scenes for ${ personas.length } persona(s): ${ personas.join( ', ' ) }`
	);

	const tmpDir = path.join( outputDir, '.compose-tmp' );
	fs.mkdirSync( tmpDir, { recursive: true } );

	try {
		// Build per-scene segment MP4s from screenshots
		const scenePaths = segments.map( ( segment, i ) =>
			buildSceneSegment( segment, i, tmpDir )
		);

		// Compose all scenes with transitions
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

		// Generate findings report
		const findings = generateFindings( {
			actionLogPath: actionLog.getLogPath(),
			scenarioName,
		} );
		const findingsPath = path.join( outputDir, 'findings.md' );
		fs.writeFileSync( findingsPath, findings.markdown );

		// eslint-disable-next-line no-console
		console.log( `Findings report: ${ findingsPath }` );
		if ( findings.workedWell.length > 0 || findings.frictionPoints.length > 0 ) {
			// eslint-disable-next-line no-console
			console.log(
				`  Positives: ${ findings.workedWell.length } | Friction points: ${ findings.frictionPoints.length }`
			);
		}

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
		// Single-persona: assemble directly with label
		assembleFrames( {
			frames: segment.primaryFrames,
			outputPath,
			label: capitalize( segment.speaker ?? '' ),
		} );
		return outputPath;
	}

	// Dual-persona: assemble both tracks, then composite
	const primaryPath = path.join( tmpDir, `scene-${ index }-primary.mp4` );
	const secondaryPath = path.join( tmpDir, `scene-${ index }-secondary.mp4` );

	assembleFrames( {
		frames: segment.primaryFrames,
		outputPath: primaryPath,
		label: capitalize( segment.speaker ?? '' ),
	} );

	const secondaryPersona = guessSecondaryPersona( segment );
	assembleFrames( {
		frames: segment.secondaryFrames,
		outputPath: secondaryPath,
		label: capitalize( secondaryPersona ),
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

/**
 * Build a narration audio track aligned to video frame timing.
 *
 * The video duration is determined by segment frame durations (not wall-clock
 * timestamps). This function derives audio timing from the same source:
 *
 *   1. Map each screenshot file → its narration audio file (from the action log)
 *   2. Walk segment frames in order (same order as the video)
 *   3. For narrated frames: insert the audio clip + pad to frame duration
 *   4. For silent frames: insert silence matching the frame duration
 *
 * This guarantees audio length == video length with narrations synced to
 * their corresponding frames.
 */
function buildAudioFromActionLog(
	allEntries: ActionEntry[],
	segments: SceneSegment[],
	outputDir: string
): string | null {
	// Build map: screenshot absolute path → narration audio file path
	// A narration entry is always logged just before its associated screenshot
	const screenshotDir = path.join( outputDir, 'screenshots' );
	const frameToAudio = new Map< string, string >();

	for ( let i = 0; i < allEntries.length; i++ ) {
		const entry = allEntries[ i ];
		if ( entry.action !== 'narration' || ! entry.audioFile ) {
			continue;
		}
		// Look ahead for the next screenshot from the same persona
		for ( let j = i + 1; j < allEntries.length && j <= i + 5; j++ ) {
			const next = allEntries[ j ];
			if ( next.action === 'screenshot' && next.screenshotFile && next.persona === entry.persona ) {
				const absPath = path.join( screenshotDir, next.screenshotFile );
				frameToAudio.set( absPath, entry.audioFile );
				break;
			}
		}
	}

	if ( frameToAudio.size === 0 ) {
		return null;
	}

	const tmpDir = path.join( outputDir, '.audio-tmp' );
	fs.mkdirSync( tmpDir, { recursive: true } );

	try {
		const segmentFiles: string[] = [];
		let silIdx = 0;

		for ( const segment of segments ) {
			for ( const frame of segment.primaryFrames ) {
				const audioFile = frameToAudio.get( frame.file );

				if ( audioFile ) {
					const resolved = path.isAbsolute( audioFile )
						? audioFile
						: path.join( outputDir, audioFile );

					if ( fs.existsSync( resolved ) ) {
						segmentFiles.push( resolved );

						// Pad if frame duration > audio duration
						const audioDurSec = getFileDuration( resolved );
						const frameDurSec = frame.durationMs / 1000;
						const gap = frameDurSec - audioDurSec;
						if ( gap > 0.1 ) {
							const silPath = path.join( tmpDir, `sil-${ silIdx++ }.aiff` );
							generateSilence( silPath, gap );
							segmentFiles.push( silPath );
						}
						continue;
					}
				}

				// No narration for this frame — fill with silence
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
	} catch {
		return null;
	}
}

function capitalize( s: string ): string {
	return s.charAt( 0 ).toUpperCase() + s.slice( 1 );
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

	const result = composeSession( { outputDir, scenarioName } );
	// eslint-disable-next-line no-console
	console.log( `\nDone! ${ result.sceneCount } scenes, ${ result.personas.length } persona(s)` );
	// eslint-disable-next-line no-console
	console.log( `Video: ${ result.videoPath }` );
	// eslint-disable-next-line no-console
	console.log( `Findings: ${ result.findingsPath }` );
}
