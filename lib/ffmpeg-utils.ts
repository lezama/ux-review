/**
 * Shared ffmpeg/ffprobe utilities used by narrator, scene-composer, and trimmer.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';

/** Standard video encoding flags used across all ffmpeg operations. */
export const ENCODE_PRESET = '-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p';

/** Standard audio encoding flags. */
export const AUDIO_PRESET = '-c:a aac -b:a 128k';

/** Standard output resolution. */
export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;

/** Scale-and-pad filter to normalize frames to OUTPUT_WIDTH x OUTPUT_HEIGHT. */
export const SCALE_PAD_FILTER = `scale=${ OUTPUT_WIDTH }:${ OUTPUT_HEIGHT }:force_original_aspect_ratio=decrease,pad=${ OUTPUT_WIDTH }:${ OUTPUT_HEIGHT }:(ow-iw)/2:(oh-ih)/2`;

/**
 * Get the duration of a media file in seconds via ffprobe.
 * Returns 0 on error (never a phantom duration).
 */
export function getFileDuration( filePath: string ): number {
	try {
		const result = execSync(
			`ffprobe -v quiet -show_entries format=duration -of csv=p=0 ${ JSON.stringify( filePath ) }`,
			{ encoding: 'utf8' }
		);
		return parseFloat( result.trim() ) || 0;
	} catch {
		return 0;
	}
}

/**
 * Generate a silent audio file of the given duration.
 */
export function generateSilence( outputPath: string, durationSec: number ): void {
	execSync(
		`ffmpeg -y -f lavfi -i anullsrc=r=22050:cl=mono -t ${ durationSec } ${ JSON.stringify( outputPath ) }`,
		{ stdio: 'ignore' }
	);
}

/**
 * Concatenate multiple audio files into a single AAC output.
 * For a single file, converts directly without the concat filter.
 */
export function concatenateAudio( files: string[], outputPath: string ): void {
	if ( files.length === 0 ) {
		return;
	}

	if ( files.length === 1 ) {
		execSync(
			`ffmpeg -y -i ${ JSON.stringify( files[ 0 ] ) } ${ AUDIO_PRESET } ${ JSON.stringify( outputPath ) }`,
			{ stdio: 'ignore' }
		);
		return;
	}

	const inputs = files
		.map( ( f ) => `-i ${ JSON.stringify( f ) }` )
		.join( ' ' );
	const filterInputs = files.map( ( _, i ) => `[${ i }:a]` ).join( '' );
	const filter = `${ filterInputs }concat=n=${ files.length }:v=0:a=1[out]`;

	execSync(
		`ffmpeg -y ${ inputs } -filter_complex "${ filter }" -map "[out]" ${ AUDIO_PRESET } ${ JSON.stringify( outputPath ) }`,
		{ stdio: 'ignore' }
	);
}

/**
 * Format milliseconds as SRT timestamp: HH:MM:SS,mmm
 */
export function formatSRTTime( ms: number ): string {
	const hours = Math.floor( ms / 3600000 );
	const minutes = Math.floor( ( ms % 3600000 ) / 60000 );
	const seconds = Math.floor( ( ms % 60000 ) / 1000 );
	const millis = ms % 1000;

	return (
		[
			String( hours ).padStart( 2, '0' ),
			String( minutes ).padStart( 2, '0' ),
			String( seconds ).padStart( 2, '0' ),
		].join( ':' ) + `,${ String( millis ).padStart( 3, '0' ) }`
	);
}

/**
 * Check whether a layout requires two persona video tracks.
 */
export function isDualPersonaLayout( layout: string ): boolean {
	return layout === 'split' || layout.startsWith( 'pip-' );
}

/** Path to TTS wrapper scripts. */
const BIN_DIR = new URL( '../bin/', import.meta.url ).pathname;
const QWEN_SCRIPT = BIN_DIR + 'qwen-say.py';
const KOKORO_SCRIPT = BIN_DIR + 'kokoro-say.py';

type TTSEngine = 'qwen' | 'kokoro' | 'say';

/**
 * Detect which TTS engine to use.
 * Priority: TTS_ENGINE env var > qwen (if available) > kokoro > say
 */
function detectTTSEngine(): TTSEngine {
	const env = process.env.TTS_ENGINE;
	if ( env === 'say' || env === 'kokoro' || env === 'qwen' ) {
		return env;
	}
	try {
		if ( fs.existsSync( QWEN_SCRIPT ) ) {
			execSync( 'python3.11 -c "import qwen_tts"', { stdio: 'ignore' } );
			return 'qwen';
		}
	} catch {
		// fall through
	}
	try {
		if ( fs.existsSync( KOKORO_SCRIPT ) ) {
			execSync( 'python3.11 -c "import kokoro"', { stdio: 'ignore' } );
			return 'kokoro';
		}
	} catch {
		// fall through
	}
	return 'say';
}

/**
 * Generate speech audio from text.
 *
 * Engine priority: Qwen3-TTS > Kokoro > macOS say.
 * Override with TTS_ENGINE env var (qwen | kokoro | say).
 *
 * @param text - Text to speak
 * @param outputPath - Output audio file path (.aiff, .wav, or .mp3)
 * @param voice - Voice name (macOS say name — auto-mapped per engine)
 */
export function generateSpeech( text: string, outputPath: string, voice?: string ): void {
	const engine = detectTTSEngine();

	if ( engine === 'qwen' ) {
		const voiceArg = voice ? `-v ${ JSON.stringify( voice ) }` : '';
		execSync(
			`python3.11 ${ JSON.stringify( QWEN_SCRIPT ) } ${ voiceArg } -o ${ JSON.stringify( outputPath ) } ${ JSON.stringify( text ) }`,
			{ stdio: [ 'ignore', 'pipe', 'ignore' ], timeout: 60_000 }
		);
	} else if ( engine === 'kokoro' ) {
		const voiceArg = voice ? `-v ${ JSON.stringify( voice ) }` : '';
		execSync(
			`python3.11 ${ JSON.stringify( KOKORO_SCRIPT ) } ${ voiceArg } -o ${ JSON.stringify( outputPath ) } ${ JSON.stringify( text ) }`,
			{ stdio: [ 'ignore', 'pipe', 'ignore' ] }
		);
	} else {
		const voiceFlag = voice ? `-v ${ voice }` : '';
		execSync(
			`say ${ voiceFlag } -o ${ JSON.stringify( outputPath ) } ${ JSON.stringify( text ) }`
		);
	}
}

/**
 * Read and parse a JSONL file into an array of typed entries.
 */
export function readJSONL< T >( filePath: string ): T[] {
	const content = fs.readFileSync( filePath, 'utf8' ).trim();
	if ( ! content ) {
		return [];
	}
	return content.split( '\n' ).map( ( line ) => JSON.parse( line ) as T );
}
