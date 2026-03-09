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
import { ENCODE_PRESET, OUTPUT_HEIGHT, OUTPUT_WIDTH, SCALE_PAD_FILTER } from './ffmpeg-utils.js';

export interface FrameInput {
	/** Absolute or relative path to the PNG screenshot */
	file: string;
	/** How long to hold this frame (milliseconds) */
	durationMs: number;
}

export interface AssembleOptions {
	/** Ordered array of frames with durations */
	frames: FrameInput[];
	/** Output MP4 file path */
	outputPath: string;
	/** Target framerate (default: 30) */
	fps?: number;
	/** Optional label drawn on the video (e.g., persona name) */
	label?: string;
}

/**
 * Assemble PNG frames into an MP4 video.
 *
 * Each frame is looped for its specified duration, then all are joined
 * with the concat filter. This avoids the concat demuxer's timebase
 * issues that cause incorrect durations with `-r` output.
 */
export function assembleFrames( options: AssembleOptions ): string {
	const { frames, outputPath, fps = 30, label } = options;

	if ( frames.length === 0 ) {
		throw new Error( 'No frames to assemble' );
	}

	const dir = path.dirname( outputPath );
	fs.mkdirSync( dir, { recursive: true } );

	const labelStyle =
		"fontsize=32:fontcolor=white:borderw=2:bordercolor=black:font='Helvetica'";
	const labelFilter = label
		? `,drawtext=text='${ label }':${ labelStyle }:x=40:y=40`
		: '';

	// Build per-frame inputs: -loop 1 -t <duration> -i <file>
	const inputs = frames.map( ( frame ) => {
		const absPath = path.resolve( frame.file );
		const durSec = ( frame.durationMs / 1000 ).toFixed( 3 );
		return `-loop 1 -t ${ durSec } -i ${ JSON.stringify( absPath ) }`;
	} ).join( ' ' );

	// Build concat filter: scale each input, then concat
	const filterParts: string[] = [];
	const concatInputs: string[] = [];

	for ( let i = 0; i < frames.length; i++ ) {
		filterParts.push(
			`[${ i }:v]${ SCALE_PAD_FILTER },format=yuv420p[v${ i }]`
		);
		concatInputs.push( `[v${ i }]` );
	}

	filterParts.push(
		`${ concatInputs.join( '' ) }concat=n=${ frames.length }:v=1:a=0[vraw]`
	);

	// Apply label if present
	if ( label ) {
		filterParts.push(
			`[vraw]drawtext=text='${ label }':${ labelStyle }:x=40:y=40[vout]`
		);
	} else {
		// Rename for consistent output label
		filterParts.push( '[vraw]null[vout]' );
	}

	const filterComplex = filterParts.join( '; ' );

	const cmd = [
		`ffmpeg -y ${ inputs }`,
		`-filter_complex "${ filterComplex }"`,
		'-map "[vout]"',
		ENCODE_PRESET,
		`-r ${ fps }`,
		'-an',
		JSON.stringify( outputPath ),
	].join( ' ' );

	execSync( cmd, { stdio: 'pipe', timeout: 300_000 } );

	return outputPath;
}
