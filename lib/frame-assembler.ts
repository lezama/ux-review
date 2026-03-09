/**
 * Frame Assembler — Build video from timestamped screenshot PNGs.
 *
 * For headless Chrome recordings where screencapture isn't available.
 * Takes an array of PNG frames with durations and assembles them into
 * an MP4 using ffmpeg's concat demuxer.
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
 * Write an ffmpeg concat demuxer file from frames.
 *
 * Format:
 *   file '/abs/path/to/frame.png'
 *   duration 1.500
 *   file '/abs/path/to/frame.png'   <-- last frame repeated without duration
 */
export function writeConcatFile(
	frames: FrameInput[],
	concatPath: string
): void {
	const lines: string[] = [];
	for ( const frame of frames ) {
		const absPath = path.resolve( frame.file );
		lines.push( `file '${ absPath }'` );
		lines.push( `duration ${ ( frame.durationMs / 1000 ).toFixed( 3 ) }` );
	}
	// ffmpeg concat demuxer needs the last file repeated without duration
	if ( frames.length > 0 ) {
		lines.push(
			`file '${ path.resolve( frames[ frames.length - 1 ].file ) }'`
		);
	}
	fs.writeFileSync( concatPath, lines.join( '\n' ) );
}

/**
 * Assemble PNG frames into an MP4 video.
 *
 * Each frame is held for its specified duration, creating a slideshow-style
 * video. Output is scaled and padded to a consistent resolution.
 */
export function assembleFrames( options: AssembleOptions ): string {
	const { frames, outputPath, fps = 30, label } = options;

	if ( frames.length === 0 ) {
		throw new Error( 'No frames to assemble' );
	}

	const dir = path.dirname( outputPath );
	fs.mkdirSync( dir, { recursive: true } );

	const concatFile = path.join(
		dir,
		`.concat-${ path.basename( outputPath, '.mp4' ) }.txt`
	);

	writeConcatFile( frames, concatFile );

	const labelStyle =
		"fontsize=32:fontcolor=white:borderw=2:bordercolor=black:font='Helvetica'";
	const labelFilter = label
		? `,drawtext=text='${ label }':${ labelStyle }:x=40:y=40`
		: '';

	const cmd = [
		'ffmpeg -y',
		'-f concat -safe 0',
		`-i ${ JSON.stringify( concatFile ) }`,
		`-vf "${ SCALE_PAD_FILTER }${ labelFilter },format=yuv420p"`,
		ENCODE_PRESET,
		`-r ${ fps }`,
		'-an',
		JSON.stringify( outputPath ),
	].join( ' ' );

	execSync( cmd, { stdio: 'pipe', timeout: 300_000 } );

	// Clean up concat file
	try {
		fs.unlinkSync( concatFile );
	} catch {
		// ignore
	}

	return outputPath;
}
