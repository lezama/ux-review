/**
 * Step Log — Declarative step-based recording format.
 *
 * Each step = { screenshot, observations, nextAction }. TTS moves to compile
 * time. Frame duration = narration audio duration. No pairing heuristics needed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isDualPersonaLayout, readJSONL } from './ffmpeg-utils.js';
import type { SceneLayout, SceneSegment } from './types.js';

export interface StepEntry {
	/** Auto-incremented step number */
	step: number;
	/** Wall-clock ms since session start */
	timestampMs: number;
	/** Which persona is acting */
	persona: string;
	/** Relative path to screenshot PNG (e.g., "admin/0003.png") */
	screenshot: string;
	/** What the tester observes — becomes narration audio at compile time */
	observations?: string;
	/** What they'll do next (context only, not spoken) */
	nextAction?: string;
	/** Start a new scene (omit to continue current scene) */
	scene?: string;
	/** Layout for the scene: full | split | pip-<name> */
	layout?: SceneLayout;
}

export const DEFAULT_FRAME_DURATION = 1500;
const MIN_FRAME_DURATION = 300;

/**
 * Append-only step log backed by a JSONL file.
 *
 * Simpler than ActionLog — one entry type, no action discrimination,
 * no TTS during recording.
 */
export class StepLog {
	private logPath: string;
	private screenshotDir: string;
	private stepCount = 0;

	constructor( outputDir: string, personas: string[] ) {
		this.logPath = path.join( outputDir, 'steps.jsonl' );
		this.screenshotDir = path.join( outputDir, 'screenshots' );

		fs.mkdirSync( path.dirname( this.logPath ), { recursive: true } );
		for ( const persona of personas ) {
			fs.mkdirSync( path.join( this.screenshotDir, persona ), {
				recursive: true,
			} );
		}

		// Start fresh
		fs.writeFileSync( this.logPath, '' );
	}

	/**
	 * Load an existing step log without truncating.
	 */
	static loadFromDirectory( outputDir: string ): StepLog {
		const log = Object.create( StepLog.prototype ) as StepLog;
		log.logPath = path.join( outputDir, 'steps.jsonl' );
		log.screenshotDir = path.join( outputDir, 'screenshots' );

		const entries = log.getEntries();
		log.stepCount = entries.length;
		return log;
	}

	append( entry: StepEntry ): void {
		fs.appendFileSync(
			this.logPath,
			JSON.stringify( entry ) + '\n'
		);
		this.stepCount++;
	}

	getEntries(): StepEntry[] {
		if ( ! fs.existsSync( this.logPath ) ) {
			return [];
		}
		const content = fs.readFileSync( this.logPath, 'utf8' ).trim();
		if ( ! content ) {
			return [];
		}
		return content.split( '\n' ).map( ( line ) => JSON.parse( line ) );
	}

	getStepCount(): number {
		return this.stepCount;
	}

	getLogPath(): string {
		return this.logPath;
	}

	getScreenshotDir(): string {
		return this.screenshotDir;
	}

	/**
	 * Convert steps to SceneSegments for video composition.
	 *
	 * @param frameDurations - Map of step index → duration in ms (from TTS audio).
	 *                         Steps without an entry get DEFAULT_FRAME_DURATION.
	 */
	toSceneSegments(
		frameDurations: Map< number, number >
	): SceneSegment[] {
		const entries = this.getEntries();
		if ( entries.length === 0 ) {
			return [];
		}

		// Group steps by scene boundaries
		const sceneGroups: Array< {
			name: string;
			layout: SceneLayout;
			speaker: string;
			steps: StepEntry[];
		} > = [];

		let currentGroup: typeof sceneGroups[ 0 ] | null = null;

		for ( const entry of entries ) {
			if ( entry.scene || ! currentGroup ) {
				// Start a new scene group
				currentGroup = {
					name: entry.scene ?? `scene-${ sceneGroups.length }`,
					layout: entry.layout ?? 'full',
					speaker: entry.persona,
					steps: [],
				};
				sceneGroups.push( currentGroup );
			}
			// Update layout if specified mid-scene
			if ( entry.layout && ! entry.scene ) {
				currentGroup.layout = entry.layout;
			}
			currentGroup.steps.push( entry );
		}

		// Convert groups to SceneSegments
		return sceneGroups.map( ( group ) => {
			const primaryPersona = group.speaker;
			const needsSecondary = isDualPersonaLayout( group.layout );

			const primarySteps = group.steps.filter(
				( s ) => s.persona === primaryPersona
			);
			const secondarySteps = needsSecondary
				? group.steps.filter( ( s ) => s.persona !== primaryPersona )
				: [];

			const buildFrames = (
				steps: StepEntry[]
			): Array< { file: string; durationMs: number } > =>
				steps.map( ( s ) => {
					const duration = frameDurations.get( s.step ) ?? DEFAULT_FRAME_DURATION;
					return {
						file: path.join( this.screenshotDir, s.screenshot ),
						durationMs: Math.max( MIN_FRAME_DURATION, duration ),
					};
				} );

			// Collect narration text from observations
			const narration = group.steps
				.map( ( s ) => s.observations )
				.filter( Boolean )
				.join( ' ' );

			return {
				name: group.name,
				layout: group.layout,
				narration: narration || undefined,
				speaker: primaryPersona,
				primaryFrames: buildFrames( primarySteps ),
				secondaryFrames: buildFrames( secondarySteps ),
			};
		} );
	}
}
