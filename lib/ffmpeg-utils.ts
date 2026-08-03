/**
 * Shared ffmpeg/ffprobe utilities used across the recording pipeline.
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

/**
 * Scale-and-pad filter that normalizes frames to the given box and forces
 * SAR 1:1. Every branch that feeds concat/xfade/hstack must use this (or
 * append its own setsar=1) — mixed SARs make those filters reject the input.
 */
export function scalePadFilter( width: number = OUTPUT_WIDTH, height: number = OUTPUT_HEIGHT ): string {
	return `scale=${ width }:${ height }:force_original_aspect_ratio=decrease,pad=${ width }:${ height }:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

/** Scale-and-pad filter at the default output size. */
export const SCALE_PAD_FILTER = scalePadFilter();

/**
 * Get the pixel dimensions of an image file via ffprobe.
 */
const imageDimensionsCache = new Map< string, { width: number; height: number } >();

export function getImageDimensions( filePath: string ): { width: number; height: number } {
	const cached = imageDimensionsCache.get( filePath );
	if ( cached ) {
		return cached;
	}
	try {
		const result = execSync(
			`ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x ${ JSON.stringify( filePath ) }`,
			{ encoding: 'utf8' }
		);
		const [ w, h ] = result.trim().split( 'x' ).map( Number );
		const dims = { width: w || 0, height: h || 0 };
		imageDimensionsCache.set( filePath, dims );
		return dims;
	} catch {
		return { width: 0, height: 0 };
	}
}

/** Aspect ratio threshold: images taller than this get zoompan scroll. */
export const TALL_IMAGE_THRESHOLD = ( 9 / 16 ) * 1.2;

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
const QWEN_BATCH_SCRIPT = BIN_DIR + 'qwen-batch.py';
const KOKORO_SCRIPT = BIN_DIR + 'kokoro-say.py';

type TTSEngine = 'qwen' | 'kokoro' | 'say';

let cachedEngine: TTSEngine | null = null;

/**
 * Detect which TTS engine to use.
 * Priority: TTS_ENGINE env var > qwen (if available) > kokoro > say
 * Result is cached after first call.
 */
function detectTTSEngine(): TTSEngine {
	if ( cachedEngine ) {
		return cachedEngine;
	}

	const env = process.env.TTS_ENGINE;
	if ( env === 'say' || env === 'kokoro' || env === 'qwen' ) {
		cachedEngine = env;
		return env;
	}
	try {
		if ( fs.existsSync( QWEN_SCRIPT ) ) {
			execSync( 'python3.11 -c "import qwen_tts"', { stdio: 'ignore' } );
			cachedEngine = 'qwen';
			return 'qwen';
		}
	} catch {
		// fall through
	}
	try {
		if ( fs.existsSync( KOKORO_SCRIPT ) ) {
			execSync( 'python3.11 -c "import kokoro"', { stdio: 'ignore' } );
			cachedEngine = 'kokoro';
			return 'kokoro';
		}
	} catch {
		// fall through
	}
	cachedEngine = 'say';
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

export interface BatchTTSItem {
	text: string;
	outputPath: string;
	voice?: string;
}

export interface BatchTTSResult {
	outputPath: string;
	durationSec: number;
	error?: string;
}

/**
 * Generate speech for multiple texts in a single process invocation.
 *
 * For qwen: uses qwen-batch.py (loads model once, generates all clips).
 * For kokoro/say: falls back to sequential generateSpeech calls.
 *
 * Returns results in the same order as inputs.
 */
export function generateSpeechBatch( items: BatchTTSItem[] ): BatchTTSResult[] {
	if ( items.length === 0 ) {
		return [];
	}

	const engine = detectTTSEngine();

	if ( engine === 'qwen' && fs.existsSync( QWEN_BATCH_SCRIPT ) ) {
		return generateSpeechBatchQwen( items );
	}

	// Fallback: sequential generation (kokoro, say)
	return generateSpeechSequential( items );
}

function generateSpeechSequential( items: BatchTTSItem[] ): BatchTTSResult[] {
	return items.map( ( item ) => {
		try {
			generateSpeech( item.text, item.outputPath, item.voice );
			return { outputPath: item.outputPath, durationSec: getFileDuration( item.outputPath ) };
		} catch ( err ) {
			return {
				outputPath: item.outputPath,
				durationSec: 0,
				error: err instanceof Error ? err.message : String( err ),
			};
		}
	} );
}

function generateSpeechBatchQwen( items: BatchTTSItem[] ): BatchTTSResult[] {
	const input = items.map( ( item ) => ( {
		text: item.text,
		output: item.outputPath,
		voice: item.voice ?? 'Samantha',
	} ) );

	const inputJSON = JSON.stringify( input );

	try {
		const stdout = execSync(
			`python3.11 ${ JSON.stringify( QWEN_BATCH_SCRIPT ) }`,
			{
				input: inputJSON,
				encoding: 'utf8',
				stdio: [ 'pipe', 'pipe', 'pipe' ],
				timeout: items.length * 60_000, // 60s per item
				maxBuffer: 10 * 1024 * 1024,
			}
		);

		// Parse streaming JSON lines from stdout
		const resultMap = new Map< number, { output: string; duration: number } >();
		for ( const line of stdout.trim().split( '\n' ) ) {
			if ( ! line ) {
				continue;
			}
			try {
				const obj = JSON.parse( line );
				resultMap.set( obj.index, obj );
			} catch {
				// skip unparseable lines
			}
		}

		return items.map( ( item, i ) => {
			const r = resultMap.get( i );
			if ( r && r.duration > 0 ) {
				return { outputPath: item.outputPath, durationSec: r.duration };
			}
			// Fallback: read duration from file if it exists
			if ( fs.existsSync( item.outputPath ) ) {
				return { outputPath: item.outputPath, durationSec: getFileDuration( item.outputPath ) };
			}
			return { outputPath: item.outputPath, durationSec: 0, error: 'Batch TTS produced no output' };
		} );
	} catch ( err ) {
		// eslint-disable-next-line no-console
		console.error( '[batch-tts] Batch script failed, falling back to sequential:', err instanceof Error ? err.message : err );
		return generateSpeechSequential( items );
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
