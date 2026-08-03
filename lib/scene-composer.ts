import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Scene, SceneLayout } from './types.js';
import {
	concatenateAudio,
	ENCODE_PRESET,
	AUDIO_PRESET,
	formatSRTTime,
	scalePadFilter,
	generateSilence,
	generateSpeech,
	getFileDuration,
	OUTPUT_HEIGHT,
	OUTPUT_WIDTH,
} from './ffmpeg-utils.js';

interface SceneComposeOptions {
	scenes: readonly Scene[];
	/** Map of persona name to video file path */
	personaVideos: Record< string, string >;
	outputPath: string;
	/** Offset (ms) per persona between scene startTime and recording start */
	personaOffsets?: Record< string, number >;
	/** Cross-fade transition duration in seconds */
	transitionSec?: number;
	/** Skip subtitle generation and burn-in */
	skipSubtitles?: boolean;
}

const PIP_WIDTH = 480;
const PIP_HEIGHT = 270;
const PIP_MARGIN = 20;

/**
 * Scene-based video composition engine.
 *
 * Two-pass ffmpeg pipeline:
 *   Pass 1: Extract each scene segment, apply layout + labels -> intermediate MP4s
 *   Pass 2: Join scenes with xfade transitions -> final MP4
 *
 * Audio is generated per-scene via macOS `say`, positioned at correct offsets.
 */
export class SceneComposer {
	static assertDependencies(): void {
		try {
			execSync( 'which ffmpeg', { stdio: 'ignore' } );
		} catch {
			throw new Error(
				'ffmpeg is required for video composition. Install with: brew install ffmpeg'
			);
		}
	}

	/**
	 * Compose a final video from pre-built per-scene MP4 segments.
	 */
	static composeFromSegments( options: {
		scenePaths: string[];
		scenes: readonly Scene[];
		outputPath: string;
		transitionSec?: number;
		skipSubtitles?: boolean;
		/** Pre-built narration audio file. If provided, skips internal TTS generation. */
		audioPath?: string;
	} ): string {
		SceneComposer.assertDependencies();

		const {
			scenePaths,
			scenes,
			outputPath,
			transitionSec = 0.5,
			skipSubtitles = false,
			audioPath: prebuiltAudio,
		} = options;

		if ( scenePaths.length === 0 ) {
			throw new Error( 'No scene segments to compose' );
		}

		for ( const p of scenePaths ) {
			if ( ! fs.existsSync( p ) ) {
				throw new Error( `Scene segment not found: ${ p }` );
			}
		}

		fs.mkdirSync( path.dirname( outputPath ), { recursive: true } );

		const tmpDir = path.join(
			path.dirname( outputPath ),
			'.scene-tmp'
		);
		fs.mkdirSync( tmpDir, { recursive: true } );

		try {
			const audioPath = prebuiltAudio && fs.existsSync( prebuiltAudio )
				? prebuiltAudio
				: generateSceneAudio( scenes, tmpDir );

			const srtPath = skipSubtitles
				? null
				: generateSceneSRT( scenes, tmpDir, transitionSec );

			const joinedPath = joinScenes(
				scenePaths,
				transitionSec,
				tmpDir
			);

			assembleOutput( joinedPath, audioPath, srtPath, outputPath );

			return outputPath;
		} finally {
			try {
				fs.rmSync( tmpDir, { recursive: true, force: true } );
			} catch {
				// ignore cleanup errors
			}
		}
	}

	static compose( options: SceneComposeOptions ): string {
		SceneComposer.assertDependencies();

		const {
			scenes,
			personaVideos,
			outputPath,
			personaOffsets = {},
			transitionSec = 0.5,
			skipSubtitles = false,
		} = options;

		if ( scenes.length === 0 ) {
			throw new Error( 'No scenes to compose' );
		}

		const personaNames = Object.keys( personaVideos );
		if ( personaNames.length === 0 ) {
			throw new Error( 'No persona videos provided' );
		}

		for ( const [ name, videoPath ] of Object.entries( personaVideos ) ) {
			if ( ! fs.existsSync( videoPath ) ) {
				throw new Error(
					`Video not found for persona "${ name }": ${ videoPath }`
				);
			}
		}

		fs.mkdirSync( path.dirname( outputPath ), { recursive: true } );

		const tmpDir = path.join(
			path.dirname( outputPath ),
			'.scene-tmp'
		);
		fs.mkdirSync( tmpDir, { recursive: true } );

		try {
			const scenePaths = scenes.map( ( scene, i ) =>
				extractScene( {
					scene,
					index: i,
					personaVideos,
					personaOffsets,
					personaNames,
					tmpDir,
				} )
			);

			const audioPath = generateSceneAudio( scenes, tmpDir );

			const srtPath = skipSubtitles
				? null
				: generateSceneSRT( scenes, tmpDir, transitionSec );

			const joinedPath = joinScenes(
				scenePaths,
				transitionSec,
				tmpDir
			);

			assembleOutput( joinedPath, audioPath, srtPath, outputPath );

			return outputPath;
		} finally {
			try {
				fs.rmSync( tmpDir, { recursive: true, force: true } );
			} catch {
				// ignore cleanup errors
			}
		}
	}
}

function extractScene( opts: {
	scene: Scene;
	index: number;
	personaVideos: Record< string, string >;
	personaOffsets: Record< string, number >;
	personaNames: string[];
	tmpDir: string;
} ): string {
	const {
		scene,
		index,
		personaVideos,
		personaOffsets,
		personaNames,
		tmpDir,
	} = opts;

	const outputFile = path.join( tmpDir, `scene-${ index }.mp4` );
	const durationSec = getSceneDuration( scene );

	// Determine which persona(s) this scene uses based on layout
	const layout = scene.layout;
	const primaryPersona = scene.speaker ?? personaNames[ 0 ];
	const secondaryPersona = personaNames.find( ( n ) => n !== primaryPersona ) ?? personaNames[ 0 ];

	const primaryVideo = personaVideos[ primaryPersona ] ?? Object.values( personaVideos )[ 0 ];
	const secondaryVideo = personaVideos[ secondaryPersona ] ?? Object.values( personaVideos )[ 0 ];

	const primaryOffset = personaOffsets[ primaryPersona ] ?? 0;
	const secondaryOffset = personaOffsets[ secondaryPersona ] ?? 0;

	const primaryStartSec = ( scene.startMs + primaryOffset ) / 1000;
	const secondaryStartSec = ( scene.startMs + secondaryOffset ) / 1000;

	const cmd = buildLayoutCommand( {
		layout,
		primaryVideo,
		secondaryVideo,
		primaryLabel: primaryPersona,
		secondaryLabel: secondaryPersona,
		primaryStartSec,
		secondaryStartSec,
		durationSec,
		outputFile,
	} );

	execSync( cmd, { stdio: 'ignore', timeout: 120_000 } );
	return outputFile;
}

function buildLayoutCommand( opts: {
	layout: SceneLayout;
	primaryVideo: string;
	secondaryVideo: string;
	primaryLabel: string;
	secondaryLabel: string;
	primaryStartSec: number;
	secondaryStartSec: number;
	durationSec: number;
	outputFile: string;
} ): string {
	const {
		layout,
		primaryVideo,
		secondaryVideo,
		primaryLabel,
		secondaryLabel,
		primaryStartSec,
		secondaryStartSec,
		durationSec,
		outputFile,
	} = opts;

	const primaryInput = `-ss ${ primaryStartSec.toFixed( 3 ) } -t ${ durationSec.toFixed( 3 ) } -i ${ JSON.stringify( primaryVideo ) }`;
	const secondaryInput = `-ss ${ secondaryStartSec.toFixed( 3 ) } -t ${ durationSec.toFixed( 3 ) } -i ${ JSON.stringify( secondaryVideo ) }`;
	const outputArgs = `${ ENCODE_PRESET } -an -y ${ JSON.stringify( outputFile ) }`;

	const labelStyle =
		"fontsize=32:fontcolor=white:borderw=2:bordercolor=black:font='Helvetica'";

	// For single-persona layouts (anything ending in '-full' or just 'full')
	if ( layout.endsWith( '-full' ) || layout === 'full' ) {
		const isSecondary = layout.startsWith( secondaryLabel );
		const input = isSecondary ? secondaryInput : primaryInput;
		const label = isSecondary ? secondaryLabel : primaryLabel;

		const filter = [
			`[0:v]${ scalePadFilter() },setpts=PTS-STARTPTS[scaled]`,
			`[scaled]drawtext=text='${ capitalize( label ) }':${ labelStyle }:x=40:y=40[out]`,
		].join( '; ' );
		return `ffmpeg ${ input } -filter_complex "${ filter }" -map "[out]" ${ outputArgs }`;
	}

	if ( layout === 'split' ) {
		const filter = [
			`[0:v]${ scalePadFilter( 960 ) },setpts=PTS-STARTPTS[left]`,
			`[1:v]${ scalePadFilter( 960 ) },setpts=PTS-STARTPTS[right]`,
			`[left][right]hstack=inputs=2[combined]`,
			`[combined]drawtext=text='${ capitalize( primaryLabel ) }':${ labelStyle }:x=40:y=40[labeled1]`,
			`[labeled1]drawtext=text='${ capitalize( secondaryLabel ) }':${ labelStyle }:x=1000:y=40[out]`,
		].join( '; ' );
		return `ffmpeg ${ primaryInput } ${ secondaryInput } -filter_complex "${ filter }" -map "[out]" ${ outputArgs }`;
	}

	if ( layout.startsWith( 'pip-' ) ) {
		// pip-<name>: <name> is the small overlay, other is full
		const pipX = OUTPUT_WIDTH - PIP_WIDTH - PIP_MARGIN;
		const filter = [
			`[0:v]${ scalePadFilter() },setpts=PTS-STARTPTS[main]`,
			`[1:v]scale=${ PIP_WIDTH }:${ PIP_HEIGHT },setsar=1,setpts=PTS-STARTPTS[pip]`,
			`[main][pip]overlay=${ pipX }:${ PIP_MARGIN }[combined]`,
			`[combined]drawtext=text='${ capitalize( primaryLabel ) }':${ labelStyle }:x=40:y=40[labeled1]`,
			`[labeled1]drawtext=text='${ capitalize( secondaryLabel ) }':${ labelStyle }:x=${ pipX + 10 }:y=${ PIP_MARGIN + PIP_HEIGHT + 5 }[out]`,
		].join( '; ' );
		return `ffmpeg ${ primaryInput } ${ secondaryInput } -filter_complex "${ filter }" -map "[out]" ${ outputArgs }`;
	}

	// Default: treat as full-screen primary
	const filter = [
		`[0:v]${ scalePadFilter() },setpts=PTS-STARTPTS[scaled]`,
		`[scaled]drawtext=text='${ capitalize( primaryLabel ) }':${ labelStyle }:x=40:y=40[out]`,
	].join( '; ' );
	return `ffmpeg ${ primaryInput } -filter_complex "${ filter }" -map "[out]" ${ outputArgs }`;
}

function capitalize( s: string ): string {
	return s.charAt( 0 ).toUpperCase() + s.slice( 1 );
}

function getSceneDuration( scene: Scene ): number {
	const endMs = scene.endMs ?? scene.startMs + 5000;
	const baseDuration = ( endMs - scene.startMs ) / 1000;
	const hold = ( scene.holdMs ?? 0 ) / 1000;
	return Math.max( 1, baseDuration + hold );
}

function generateSceneAudio(
	scenes: readonly Scene[],
	tmpDir: string
): string | null {
	const narrated = scenes.filter( ( s ) => s.narration );
	if ( narrated.length === 0 ) {
		return null;
	}

	const segmentFiles: string[] = [];

	for ( let i = 0; i < scenes.length; i++ ) {
		const scene = scenes[ i ];
		const sceneDuration = getSceneDuration( scene );

		if ( scene.narration ) {
			const aiffPath = path.join(
				tmpDir,
				`narr-${ i }.aiff`
			);
			generateSpeech( scene.narration, aiffPath, scene.speaker || undefined );
			segmentFiles.push( aiffPath );

			const speechDuration = getFileDuration( aiffPath );
			const remainingSilence = Math.max(
				0,
				sceneDuration - speechDuration
			);
			if ( remainingSilence > 0.1 ) {
				const silPath = path.join(
					tmpDir,
					`sil-${ i }.aiff`
				);
				generateSilence( silPath, remainingSilence );
				segmentFiles.push( silPath );
			}
		} else {
			if ( sceneDuration > 0.1 ) {
				const silPath = path.join(
					tmpDir,
					`sil-${ i }.aiff`
				);
				generateSilence( silPath, sceneDuration );
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
}

function generateSceneSRT(
	scenes: readonly Scene[],
	tmpDir: string,
	transitionSec: number
): string | null {
	const narrated = scenes.filter( ( s ) => s.narration );
	if ( narrated.length === 0 ) {
		return null;
	}

	const lines: string[] = [];
	let cumulativeOffset = 0;
	let srtIndex = 1;

	for ( let i = 0; i < scenes.length; i++ ) {
		const scene = scenes[ i ];
		const duration = getSceneDuration( scene );

		if ( scene.narration ) {
			const startMs = Math.round( cumulativeOffset * 1000 );
			const displayDuration = Math.min(
				duration * 0.8,
				duration - 0.3
			);
			const endMs = Math.round(
				( cumulativeOffset + displayDuration ) * 1000
			);

			const label = scene.speaker ? `[${ capitalize( scene.speaker ) }]` : '';

			lines.push(
				`${ srtIndex }`,
				`${ formatSRTTime( startMs ) } --> ${ formatSRTTime( endMs ) }`,
				`${ label } ${ scene.narration }`.trim(),
				''
			);
			srtIndex++;
		}

		if ( i < scenes.length - 1 ) {
			cumulativeOffset += duration - transitionSec;
		} else {
			cumulativeOffset += duration;
		}
	}

	const srtPath = path.join( tmpDir, 'narration.srt' );
	fs.writeFileSync( srtPath, lines.join( '\n' ) );
	return srtPath;
}

function joinScenes(
	scenePaths: string[],
	transitionSec: number,
	tmpDir: string
): string {
	if ( scenePaths.length === 1 ) {
		return scenePaths[ 0 ];
	}

	const outputFile = path.join( tmpDir, 'joined.mp4' );
	const durations = scenePaths.map( ( f ) => getFileDuration( f ) );

	const inputs = scenePaths
		.map( ( f ) => `-i ${ JSON.stringify( f ) }` )
		.join( ' ' );

	const filters: string[] = [];
	let prevLabel = '[0:v]';
	let accDuration = durations[ 0 ];

	for ( let i = 1; i < scenePaths.length; i++ ) {
		const offset = Math.max(
			0,
			accDuration - transitionSec
		);
		const outLabel =
			i < scenePaths.length - 1 ? `[v${ i }]` : '[vout]';

		filters.push(
			`${ prevLabel }[${ i }:v]xfade=transition=fade:duration=${ transitionSec.toFixed( 2 ) }:offset=${ offset.toFixed( 3 ) }${ outLabel }`
		);

		prevLabel = outLabel;
		accDuration = offset + durations[ i ];
	}

	const filterComplex = filters.join( '; ' );

	execSync(
		`ffmpeg -y ${ inputs } -filter_complex "${ filterComplex }" -map "[vout]" ${ ENCODE_PRESET } -an ${ JSON.stringify( outputFile ) }`,
		{ stdio: 'ignore', timeout: 300_000 }
	);

	return outputFile;
}

function assembleOutput(
	videoPath: string,
	audioPath: string | null,
	srtPath: string | null,
	outputPath: string
): void {
	const inputs = [ `-i ${ JSON.stringify( videoPath ) }` ];
	const maps = [ '-map 0:v' ];
	let videoFilter = '';

	if ( audioPath && fs.existsSync( audioPath ) ) {
		inputs.push( `-i ${ JSON.stringify( audioPath ) }` );
		maps.push( '-map 1:a' );
	} else {
		maps.push( '-an' );
	}

	if ( srtPath && fs.existsSync( srtPath ) ) {
		const escapedSubs = srtPath
			.replace( /\\/g, '\\\\' )
			.replace( /:/g, '\\:' )
			.replace( /'/g, "\\'" );
		videoFilter = `-vf "subtitles='${ escapedSubs }':force_style='FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,MarginV=60'"`;
	}

	const cmd = [
		'ffmpeg -y',
		...inputs,
		...maps,
		videoFilter,
		ENCODE_PRESET,
		AUDIO_PRESET,
		JSON.stringify( outputPath ),
	]
		.filter( Boolean )
		.join( ' ' );

	// eslint-disable-next-line no-console
	console.log( `Composing scene video: ${ outputPath }` );
	execSync( cmd, { stdio: 'inherit', timeout: 300_000 } );
}

