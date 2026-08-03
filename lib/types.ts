/**
 * Shared types for the recording and composition pipeline.
 */

/**
 * Layout identifier for video composition.
 *
 * - 'full': Single persona fills the screen
 * - 'split': Two personas side by side
 * - `pip-${string}`: Picture-in-picture with named persona as overlay
 */
export type SceneLayout = 'full' | 'split' | `pip-${ string }`;

export interface Scene {
	name: string;
	layout: SceneLayout;
	narration?: string;
	speaker?: string;
	startMs: number;
	endMs?: number;
	holdMs?: number;
}

export interface ActionEntry {
	/** Frame index (maps to screenshot PNG filename) */
	frame: number;
	/** Milliseconds since recording start (real wall-clock) */
	timestampMs: number;
	/** Which browser persona performed this action */
	persona: string;
	/** What was done */
	action: 'screenshot' | 'scene' | 'narration';
	/** Human-readable target description */
	target?: string;
	/** Narration text for this scene */
	narration?: string;
	/** Layout for video composition */
	layout?: SceneLayout;
	/** Relative path to the screenshot PNG (e.g., "admin/0003.png") */
	screenshotFile?: string;
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
