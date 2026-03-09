import * as fs from 'fs';
import * as path from 'path';
import { isDualPersonaLayout, readJSONL } from './ffmpeg-utils.js';
import type { Scene, SceneLayout } from './narrator.js';

export interface ActionEntry {
	/** Frame index (maps to screenshot PNG filename) */
	frame: number;
	/** Milliseconds since recording start (real wall-clock) */
	timestampMs: number;
	/** Which browser persona performed this action */
	persona: string;
	/** What was done */
	action: 'screenshot' | 'click' | 'fill' | 'navigate' | 'wait' | 'scene' | 'narration' | 'pause' | 'resume';
	/** Human-readable target description */
	target?: string;
	/** Narration text for this scene (spoken by macOS `say`) */
	narration?: string;
	/** Layout for video composition */
	layout?: SceneLayout;
	/** Hold the final frame of this scene for extra time (ms) */
	holdMs?: number;
	/** Relative path to the screenshot PNG (e.g., "admin/0003.png") */
	screenshotFile?: string;
	/** Per-frame hold duration override for pacing (ms) */
	durationMs?: number;
	/** Relative path to narration audio file (e.g., "audio/narr-0.aiff") */
	audioFile?: string;
}

export interface SceneSegment {
	/** Scene name */
	name: string;
	/** Layout for this scene */
	layout: SceneLayout;
	/** Narration text */
	narration?: string;
	/** Speaker persona */
	speaker?: string;
	/** Frames for the primary persona, with durations */
	primaryFrames: Array< {
		file: string;
		durationMs: number;
	} >;
	/** Frames for the secondary persona (for split/PIP layouts) */
	secondaryFrames: Array< {
		file: string;
		durationMs: number;
	} >;
	/** Hold the final frame extra (ms) */
	holdMs?: number;
}

/**
 * Append-only action log backed by a JSONL file.
 *
 * Each line is a JSON-serialized ActionEntry. Scene markers (action: 'scene')
 * define composition segments; other entries track individual browser actions.
 */
export class ActionLog {
	private logPath: string;
	private screenshotDir: string;
	private personas: string[];

	/**
	 * Load an existing session's action log without truncating it.
	 * Use this for post-recording operations (compose, report).
	 */
	static loadFromDirectory( outputDir: string ): ActionLog {
		const logPath = path.join( outputDir, 'action-log.jsonl' );
		const entries = readJSONL< ActionEntry >( logPath );
		const personas = [ ...new Set( entries.map( ( e ) => e.persona ) ) ];

		const log = Object.create( ActionLog.prototype ) as ActionLog;
		log.logPath = logPath;
		log.screenshotDir = path.join( outputDir, 'screenshots' );
		log.personas = personas.length > 0 ? personas : [ 'default' ];
		return log;
	}

	constructor( outputDir: string, personas: string[] = [ 'default' ] ) {
		this.logPath = path.join( outputDir, 'action-log.jsonl' );
		this.screenshotDir = path.join( outputDir, 'screenshots' );
		this.personas = personas;

		fs.mkdirSync( path.dirname( this.logPath ), { recursive: true } );
		for ( const persona of this.personas ) {
			fs.mkdirSync( path.join( this.screenshotDir, persona ), {
				recursive: true,
			} );
		}

		fs.writeFileSync( this.logPath, '' );
	}

	append( entry: ActionEntry ): void {
		fs.appendFileSync(
			this.logPath,
			JSON.stringify( entry ) + '\n'
		);
	}

	getEntries(): ActionEntry[] {
		const content = fs.readFileSync( this.logPath, 'utf8' ).trim();
		if ( ! content ) {
			return [];
		}
		return content.split( '\n' ).map( ( line ) => JSON.parse( line ) );
	}

	getScreenshotPath( frame: number, persona: string ): string {
		const padded = String( frame ).padStart( 4, '0' );
		return path.join(
			this.screenshotDir,
			persona,
			`${ padded }.png`
		);
	}

	toSceneSegments(): SceneSegment[] {
		const entries = this.getEntries();
		const sceneEntries = entries.filter( ( e ) => e.action === 'scene' );
		const screenshots = entries.filter(
			( e ) => e.action === 'screenshot' && e.screenshotFile
		);

		if ( sceneEntries.length === 0 ) {
			return [];
		}

		const lastTimestamp =
			entries.length > 0
				? entries[ entries.length - 1 ].timestampMs
				: 0;

		return sceneEntries.map( ( sceneEntry, i ) => {
			const nextScene = sceneEntries[ i + 1 ];
			const sceneEndMs = nextScene
				? nextScene.timestampMs
				: Infinity;

			const layout = sceneEntry.layout ?? 'full';

			// Determine primary persona from the scene entry
			const primaryPersona = sceneEntry.persona ?? this.personas[ 0 ];
			const needsSecondary = isDualPersonaLayout( layout );

			const sceneScreenshots = screenshots.filter(
				( s ) =>
					s.timestampMs >= sceneEntry.timestampMs &&
					s.timestampMs < sceneEndMs
			);

			const primaryShots = sceneScreenshots.filter(
				( s ) => s.persona === primaryPersona
			);
			const secondaryShots = needsSecondary
				? sceneScreenshots.filter(
						( s ) => s.persona !== primaryPersona
					)
				: [];

			const DEFAULT_DURATION = 1500;
			const MIN_DURATION = 300;

			const buildFrames = (
				shots: ActionEntry[]
			): Array< { file: string; durationMs: number } > =>
				shots.map( ( shot, j ) => {
					let duration: number;
					if ( shot.durationMs ) {
						duration = shot.durationMs;
					} else if ( j < shots.length - 1 ) {
						duration =
							shots[ j + 1 ].timestampMs - shot.timestampMs;
					} else {
						duration = DEFAULT_DURATION;
					}
					return {
						file: path.join(
							this.screenshotDir,
							shot.screenshotFile!
						),
						durationMs: Math.max( MIN_DURATION, duration ),
					};
				} );

			return {
				name: sceneEntry.target ?? `scene-${ i }`,
				layout,
				narration: sceneEntry.narration,
				speaker: sceneEntry.persona,
				primaryFrames: buildFrames( primaryShots ),
				secondaryFrames: buildFrames( secondaryShots ),
				holdMs: sceneEntry.holdMs,
			};
		} );
	}

	toScenes(): Scene[] {
		const entries = this.getEntries();
		const sceneEntries = entries.filter( ( e ) => e.action === 'scene' );

		if ( sceneEntries.length === 0 ) {
			return [];
		}

		const lastTimestamp =
			entries.length > 0
				? entries[ entries.length - 1 ].timestampMs
				: 0;

		return sceneEntries.map( ( entry, i ) => {
			const nextScene = sceneEntries[ i + 1 ];
			const endMs = nextScene ? nextScene.timestampMs : Infinity;

			return {
				name: entry.target ?? `scene-${ i }`,
				layout: entry.layout ?? 'full',
				narration: entry.narration,
				speaker: entry.persona,
				startMs: entry.timestampMs,
				endMs,
				holdMs: entry.holdMs,
			};
		} );
	}

	getLogPath(): string {
		return this.logPath;
	}

	getScreenshotDir(): string {
		return this.screenshotDir;
	}
}
