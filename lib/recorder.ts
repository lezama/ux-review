/**
 * Recorder — Screenshot-based recording orchestrator.
 *
 * Replaces the fragile screencapture approach with deterministic,
 * verified screenshot capture. The agent calls Chrome DevTools MCP
 * `take_screenshot` and then calls `logScreenshot()` to verify and
 * log the frame. The recorder manages state, file paths, numbering,
 * and the action log.
 *
 * Usage pattern (from the agent):
 *   const session = new RecorderSession({ outputDir, personas });
 *   const path = session.nextScreenshotPath('admin');
 *   // agent calls: take_screenshot({ filePath: path })
 *   session.logScreenshot('admin', path);
 *   // ...repeat for each frame...
 *   session.finalize();
 */
import * as fs from 'fs';
import * as path from 'path';
import { ActionLog } from './action-log.js';
import type { ActionEntry } from './action-log.js';
import type { SceneLayout } from './narrator.js';

export interface PersonaConfig {
	mcpServer: string;
	voice?: string;
}

export interface RecorderOptions {
	outputDir: string;
	personas: Record< string, PersonaConfig >;
}

export interface CaptureResult {
	file: string;
	verified: boolean;
	timestampMs: number;
	persona: string;
	frame: number;
}

export interface SessionStats {
	totalFrames: number;
	perPersona: Record< string, number >;
	sceneCount: number;
	narrationCount: number;
	durationEstimateMs: number;
	errors: string[];
}

const MIN_SCREENSHOT_BYTES = 1024;

export class RecorderSession {
	private outputDir: string;
	private actionLog: ActionLog;
	private personas: Record< string, PersonaConfig >;
	private frameCounts: Record< string, number > = {};
	private startTime: number;
	private errors: string[] = [];
	private sceneCount = 0;
	private narrationCount = 0;

	constructor( options: RecorderOptions ) {
		this.outputDir = options.outputDir;
		this.personas = options.personas;
		this.startTime = Date.now();

		fs.mkdirSync( this.outputDir, { recursive: true } );

		const personaNames = Object.keys( this.personas );
		this.actionLog = new ActionLog( this.outputDir, personaNames );

		for ( const name of personaNames ) {
			this.frameCounts[ name ] = 0;
		}
	}

	/**
	 * Get the next screenshot file path for a persona.
	 * The agent should pass this path to `take_screenshot({ filePath })`.
	 */
	nextScreenshotPath( persona: string ): string {
		this.assertPersona( persona );
		const frame = this.frameCounts[ persona ];
		return this.actionLog.getScreenshotPath( frame, persona );
	}

	/**
	 * Verify and log a screenshot after the agent has captured it.
	 * Returns a CaptureResult with verification status.
	 */
	logScreenshot( persona: string, filePath: string, durationMs?: number ): CaptureResult {
		this.assertPersona( persona );

		const frame = this.frameCounts[ persona ];
		const timestampMs = Date.now() - this.startTime;
		const verified = this.verifyFile( filePath );

		if ( ! verified ) {
			this.errors.push(
				`Frame ${ frame } for ${ persona } failed verification: ${ filePath }`
			);
		}

		const relPath = path.relative(
			this.actionLog.getScreenshotDir(),
			filePath
		);

		const entry: ActionEntry = {
			frame,
			timestampMs,
			persona,
			action: 'screenshot',
			screenshotFile: relPath,
			durationMs,
		};

		this.actionLog.append( entry );
		this.frameCounts[ persona ]++;

		return {
			file: filePath,
			verified,
			timestampMs,
			persona,
			frame,
		};
	}

	/**
	 * Log a browser action (click, fill, navigate, wait).
	 */
	logAction(
		persona: string,
		action: 'click' | 'fill' | 'navigate' | 'wait',
		target?: string
	): void {
		this.assertPersona( persona );
		const frame = this.frameCounts[ persona ];

		this.actionLog.append( {
			frame,
			timestampMs: Date.now() - this.startTime,
			persona,
			action,
			target,
		} );
	}

	/**
	 * Mark a scene boundary in the action log.
	 */
	logScene(
		name: string,
		options: {
			layout?: SceneLayout;
			narration?: string;
			speaker?: string;
			holdMs?: number;
		} = {}
	): void {
		const speaker = options.speaker ?? Object.keys( this.personas )[ 0 ];

		this.actionLog.append( {
			frame: this.frameCounts[ speaker ] ?? 0,
			timestampMs: Date.now() - this.startTime,
			persona: speaker,
			action: 'scene',
			target: name,
			layout: options.layout ?? 'full',
			narration: options.narration,
			holdMs: options.holdMs,
		} );

		this.sceneCount++;
	}

	/**
	 * Log a narration event (after the agent has generated TTS audio).
	 */
	logNarration(
		persona: string,
		audioFile: string,
		durationSec: number,
		text: string
	): void {
		this.assertPersona( persona );

		const entry: ActionEntry = {
			frame: this.frameCounts[ persona ],
			timestampMs: Date.now() - this.startTime,
			persona,
			action: 'narration',
			target: `narration: ${ text.slice( 0, 60 ) }...`,
			narration: text,
			durationMs: Math.round( durationSec * 1000 ),
			audioFile,
		};

		this.actionLog.append( entry );
		this.narrationCount++;
	}

	/**
	 * Get current session statistics.
	 */
	getStats(): SessionStats {
		const totalFrames = Object.values( this.frameCounts )
			.reduce( ( sum, n ) => sum + n, 0 );

		return {
			totalFrames,
			perPersona: { ...this.frameCounts },
			sceneCount: this.sceneCount,
			narrationCount: this.narrationCount,
			durationEstimateMs: Date.now() - this.startTime,
			errors: [ ...this.errors ],
		};
	}

	/**
	 * Get the output directory path.
	 */
	getOutputDir(): string {
		return this.outputDir;
	}

	/**
	 * Get the action log file path.
	 */
	getActionLogPath(): string {
		return this.actionLog.getLogPath();
	}

	/**
	 * Get the screenshot directory path.
	 */
	getScreenshotDir(): string {
		return this.actionLog.getScreenshotDir();
	}

	/**
	 * Get persona config (MCP server, voice, etc.).
	 */
	getPersona( name: string ): PersonaConfig | undefined {
		return this.personas[ name ];
	}

	/**
	 * Get all persona names.
	 */
	getPersonaNames(): string[] {
		return Object.keys( this.personas );
	}

	/**
	 * Get the underlying ActionLog for advanced use.
	 */
	getActionLog(): ActionLog {
		return this.actionLog;
	}

	/**
	 * Finalize the session. Returns stats summary.
	 * Call this before running assembly.
	 */
	finalize(): SessionStats {
		const stats = this.getStats();

		// Write a session manifest for downstream tools
		const manifest = {
			startTime: new Date( this.startTime ).toISOString(),
			endTime: new Date().toISOString(),
			outputDir: this.outputDir,
			actionLog: this.actionLog.getLogPath(),
			screenshotDir: this.actionLog.getScreenshotDir(),
			personas: Object.fromEntries(
				Object.entries( this.personas ).map( ( [ name, config ] ) => [
					name,
					{
						...config,
						frames: this.frameCounts[ name ],
					},
				] )
			),
			stats,
		};

		fs.writeFileSync(
			path.join( this.outputDir, 'session-manifest.json' ),
			JSON.stringify( manifest, null, 2 )
		);

		return stats;
	}

	private verifyFile( filePath: string ): boolean {
		try {
			const stat = fs.statSync( filePath );
			return stat.size >= MIN_SCREENSHOT_BYTES;
		} catch {
			return false;
		}
	}

	private assertPersona( persona: string ): void {
		if ( ! ( persona in this.personas ) ) {
			throw new Error(
				`Unknown persona "${ persona }". Known: ${ Object.keys( this.personas ).join( ', ' ) }`
			);
		}
	}
}
