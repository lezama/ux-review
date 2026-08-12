/**
 * Recording Report Generator — Post-compose feedback and validation.
 *
 * Analyzes the action log and screenshot directory to produce a summary
 * of the recording, flag potential issues, and give actionable feedback.
 *
 * Usage:
 *   node --loader ts-node/esm lib/report-generator.ts \
 *     --action-log /tmp/output/action-log.jsonl \
 *     --screenshots /tmp/output/screenshots \
 *     --output /tmp/output/composed-final.mp4
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ActionEntry, SceneLayout } from './types.js';
import { isDualPersonaLayout, readJSONL } from './ffmpeg-utils.js';


interface ReportOptions {
	actionLogPath: string;
	screenshotDir: string;
	outputPath?: string;
}

interface Issue {
	severity: 'WARN' | 'ERROR';
	scene?: string;
	message: string;
}

function getAllScreenshotFiles( screenshotDir: string ): Set< string > {
	const files = new Set< string >();
	if ( ! fs.existsSync( screenshotDir ) ) {
		return files;
	}
	for ( const persona of fs.readdirSync( screenshotDir ) ) {
		const dir = path.join( screenshotDir, persona );
		if ( ! fs.statSync( dir ).isDirectory() ) {
			continue;
		}
		for ( const f of fs.readdirSync( dir ) ) {
			if ( f.endsWith( '.png' ) ) {
				files.add( `${ persona }/${ f }` );
			}
		}
	}
	return files;
}

export function generateReport( options: ReportOptions ): string {
	const entries = readJSONL< ActionEntry >( options.actionLogPath );
	const screenshotFiles = getAllScreenshotFiles( options.screenshotDir );

	const screenshots = entries.filter(
		( e ) => e.action === 'screenshot'
	);
	const sceneMarkers = entries.filter( ( e ) => e.action === 'scene' );

	// Group frames by persona
	const personaCounts: Record< string, number > = {};
	for ( const s of screenshots ) {
		personaCounts[ s.persona ] = ( personaCounts[ s.persona ] ?? 0 ) + 1;
	}

	const issues: Issue[] = [];

	// Check for orphan PNGs
	const loggedFiles = new Set(
		screenshots
			.filter( ( e ) => e.screenshotFile )
			.map( ( e ) => e.screenshotFile! )
	);
	for ( const file of screenshotFiles ) {
		if ( ! loggedFiles.has( file ) ) {
			issues.push( {
				severity: 'WARN',
				message: `Orphan PNG: ${ file } (no matching log entry)`,
			} );
		}
	}

	// Check for log entries without files
	for ( const entry of screenshots ) {
		if ( entry.screenshotFile ) {
			const fullPath = path.join(
				options.screenshotDir,
				entry.screenshotFile
			);
			if ( ! fs.existsSync( fullPath ) ) {
				issues.push( {
					severity: 'ERROR',
					message: `Missing PNG: ${ entry.screenshotFile } (referenced in log at frame ${ entry.frame })`,
				} );
			}
		}
	}

	// Check timestamp monotonicity
	for ( let i = 1; i < entries.length; i++ ) {
		if ( entries[ i ].timestampMs < entries[ i - 1 ].timestampMs ) {
			issues.push( {
				severity: 'WARN',
				message: `Non-monotonic timestamp at entry ${ i }: ${ entries[ i ].timestampMs }ms < ${ entries[ i - 1 ].timestampMs }ms`,
			} );
		}
	}

	// Per-scene analysis
	const lastTimestamp =
		entries.length > 0
			? entries[ entries.length - 1 ].timestampMs
			: 0;

	const sceneDetails: Array< {
		name: string;
		layout: SceneLayout;
		durationSec: number;
		frameCount: number;
		status: string;
	} > = [];

	for ( let i = 0; i < sceneMarkers.length; i++ ) {
		const scene = sceneMarkers[ i ];
		const nextScene = sceneMarkers[ i + 1 ];
		const endMs = nextScene ? nextScene.timestampMs : lastTimestamp;
		const durationMs = endMs - scene.timestampMs;
		const durationSec = durationMs / 1000;
		const layout = ( scene.layout ?? 'full' ) as SceneLayout;
		const sceneName = scene.target ?? `scene-${ i }`;

		const sceneScreenshots = screenshots.filter(
			( s ) =>
				s.timestampMs >= scene.timestampMs &&
				s.timestampMs < endMs
		);

		let status = '\u2713';
		const framesPerSec =
			durationSec > 0
				? sceneScreenshots.length / durationSec
				: 0;

		if ( framesPerSec < 1 / 3 && durationSec > 1 ) {
			status = '\u26A0 sparse coverage';
			issues.push( {
				severity: 'WARN',
				scene: sceneName,
				message: `Only ${ sceneScreenshots.length } frames in ${ durationSec.toFixed( 1 ) }s scene`,
			} );
		}

		if ( isDualPersonaLayout( layout ) ) {
			const primaryPersona = scene.persona;
			const secondaryCount = sceneScreenshots.filter(
				( s ) => s.persona !== primaryPersona
			).length;
			if ( secondaryCount === 0 ) {
				status = '\u26A0 placeholder used for secondary';
				issues.push( {
					severity: 'WARN',
					scene: sceneName,
					message: `No secondary persona frames in ${ layout } scene`,
				} );
			}
		}

		if ( durationSec < 1 ) {
			issues.push( {
				severity: 'WARN',
				scene: sceneName,
				message: `Scene duration < 1s (${ durationSec.toFixed( 1 ) }s)`,
			} );
		} else if ( durationSec > 15 ) {
			issues.push( {
				severity: 'WARN',
				scene: sceneName,
				message: `Scene duration > 15s (${ durationSec.toFixed( 1 ) }s)`,
			} );
		}

		sceneDetails.push( {
			name: sceneName,
			layout,
			durationSec,
			frameCount: sceneScreenshots.length,
			status,
		} );
	}

	// Build report
	const totalDurationSec = lastTimestamp / 1000;
	const lines: string[] = [];

	const personaSummary = Object.entries( personaCounts )
		.map( ( [ name, count ] ) => `${ name }: ${ count }` )
		.join( ', ' );

	lines.push( '=== UX Simulation Report ===' );
	lines.push(
		`Duration: ${ Math.round( totalDurationSec ) }s | Frames: ${ screenshots.length } (${ personaSummary }) | Scenes: ${ sceneMarkers.length }`
	);
	lines.push( '' );

	for ( let i = 0; i < sceneDetails.length; i++ ) {
		const d = sceneDetails[ i ];
		const idx = String( i + 1 ).padStart( 2, ' ' );
		const name = d.name.padEnd( 24 );
		const layoutStr = `[${ d.layout }]`.padEnd( 18 );
		const dur = `${ d.durationSec.toFixed( 1 ) }s`.padStart( 6 );
		const frames = `${ d.frameCount } frames`.padStart( 10 );
		lines.push(
			`  ${ idx }. ${ name } ${ layoutStr } ${ dur } ${ frames }  ${ d.status }`
		);
	}

	if ( issues.length > 0 ) {
		lines.push( '' );
		lines.push( 'Issues:' );
		for ( const issue of issues ) {
			const sceneRef = issue.scene
				? ` Scene ${ issue.scene }:`
				: '';
			lines.push(
				`  [${ issue.severity }]${ sceneRef } ${ issue.message }`
			);
		}
	}

	if ( options.outputPath ) {
		lines.push( '' );
		lines.push( `Output: ${ options.outputPath }` );
	}

	return lines.join( '\n' );
}

export interface Findings {
	scenario: string;
	personas: string[];
	workedWell: string[];
	frictionPoints: string[];
	suggestions: string[];
	markdown: string;
}

export type FindingsMode = 'simulator' | 'expert';

interface FindingsSection {
	title: string;
	items: string[];
	numbered?: boolean;
}

interface ClassificationRule {
	key: string;
	pattern: RegExp;
	excludePositive?: boolean;
}

/**
 * Shared scaffolding for findings generation.
 *
 * Loads narrations from the action log, classifies them against pattern rules,
 * and builds a markdown report from the resulting sections.
 */
function classifyAndReport( options: {
	actionLogPath: string;
	scenarioName?: string;
	title: string;
	rules: ClassificationRule[];
	positivePattern: RegExp;
	buildSections: ( buckets: Record< string, string[] >, workedWell: string[], suggestions: string[] ) => FindingsSection[];
} ): Findings {
	const entries = readJSONL< ActionEntry >( options.actionLogPath );

	const narrations = entries.filter(
		( e ) => ( e.action === 'narration' || e.narration ) && e.narration
	);
	const scenes = entries.filter( ( e ) => e.action === 'scene' );
	const personas = [ ...new Set( entries.map( ( e ) => e.persona ) ) ];
	const scenario = options.scenarioName ?? options.title;

	const workedWell: string[] = [];
	const frictionPoints: string[] = [];
	const buckets: Record< string, string[] > = {};

	for ( const rule of options.rules ) {
		buckets[ rule.key ] = [];
	}

	for ( const entry of narrations ) {
		const text = entry.narration!;
		const scene = findEnclosingScene( scenes, entry.timestampMs );
		const label = scene?.target ? `[${ scene.target }]` : '';
		const line = label ? `${ label } ${ text }` : text;
		const isPositive = options.positivePattern.test( text );

		if ( isPositive ) {
			workedWell.push( line );
		}

		// Assign each observation to a single bucket, the rule whose pattern
		// matches it most. Testing every rule independently used to file one
		// observation under several lenses at once, which padded the report
		// and made two lenses look like two findings.
		let best: { rule: ClassificationRule; score: number } | undefined;
		for ( const rule of options.rules ) {
			if ( rule.excludePositive && isPositive ) {
				continue;
			}
			const matches = text.match( new RegExp( rule.pattern.source, rule.pattern.flags.replace( 'g', '' ) + 'g' ) );
			const score = matches ? matches.length : 0;
			if ( score > 0 && ( ! best || score > best.score ) ) {
				best = { rule, score };
			}
		}
		if ( best ) {
			buckets[ best.rule.key ].push( line );
			// A positive note is not also a friction point. Listing it as both
			// is how the worst finding of a run once appeared under what
			// worked well.
			if ( ! isPositive ) {
				frictionPoints.push( line );
			}
		}
	}

	const uniqueFriction = [ ...new Set( frictionPoints ) ];
	// Cut on a word boundary. Slicing at a fixed width left every suggestion
	// ending mid-word, which read like the report itself was broken.
	const suggestions = uniqueFriction.map( ( fp ) => {
		if ( fp.length <= 160 ) {
			return fp;
		}
		const cut = fp.slice( 0, 160 );
		const lastSpace = cut.lastIndexOf( ' ' );
		return `${ cut.slice( 0, lastSpace > 0 ? lastSpace : 160 ) }…`;
	} );
	const sections = options.buildSections( buckets, workedWell, suggestions );

	const lines: string[] = [];
	lines.push( `## ${ options.title }` );
	lines.push( '' );
	lines.push( `**Scenario:** ${ scenario }` );
	lines.push(
		`**Personas:** ${ personas.join( ', ' ) } | **Scenes:** ${ scenes.length } | **Observations:** ${ narrations.length }`
	);
	lines.push( '' );

	for ( const section of sections ) {
		if ( section.items.length === 0 ) {
			continue;
		}
		lines.push( `### ${ section.title }` );
		for ( let i = 0; i < section.items.length; i++ ) {
			lines.push( section.numbered
				? `${ i + 1 }. ${ section.items[ i ] }`
				: `- ${ section.items[ i ] }`
			);
		}
		lines.push( '' );
	}

	return {
		scenario,
		personas,
		workedWell,
		frictionPoints: uniqueFriction,
		suggestions,
		markdown: lines.join( '\n' ),
	};
}

/**
 * Generate UX findings from narration text and scene flow.
 *
 * Classifies observations into positive/negative signals.
 */
export function generateFindings( options: {
	actionLogPath: string;
	scenarioName?: string;
} ): Findings {
	return classifyAndReport( {
		...options,
		title: 'UX Simulation Findings',
		positivePattern: /nice|smooth|clean|clear|easy|automatically|immediately|intuitive|well|great|love|helpful|quick/i,
		rules: [ {
			key: 'friction',
			pattern: /confus|unclear|broken|error|missing|unexpected|strange|weird|hard to|difficult|can't find|slow|bug|wrong|fail/i,
		} ],
		buildSections: ( buckets, workedWell, suggestions ) => [
			{ title: 'What Worked Well', items: workedWell },
			{ title: 'Friction Points', items: buckets.friction },
			{ title: 'Suggestions', items: suggestions, numbered: true },
		],
	} );
}

/**
 * Generate expert UX findings classified by review lens.
 *
 * Modeled after the review style of Matías Ventura and Pablo Honey.
 */
export function generateExpertFindings( options: {
	actionLogPath: string;
	scenarioName?: string;
} ): Findings {
	return classifyAndReport( {
		...options,
		title: 'UX Expert Review Findings',
		positivePattern: /well done|smart|good (?:default|pattern|choice)|intuitive|clear next|elegant|clean|efficient|saves.*trip|inline.*edit|works well|nice touch|solid/i,
		rules: [
			{ key: 'ia', pattern: /navigat|hierarch|sidebar|menu|nested|order|group|priorit|redundan|duplicat|appears.*(?:both|twice)|IA\b|information architecture|wayfind|labeling|categoriz/i, excludePositive: true },
			{ key: 'visual', pattern: /align|spacing|pixel|badge|inconsisten|component|design system|visual|density|row height|off-center|misalign|too tall|too wide|font|typography|icon.*off|layout/i, excludePositive: true },
			{ key: 'copy', pattern: /label|copy|wording|says.*but|mislead|verbose|terminolog|naming|text.*should|rename|confusing.*(?:name|term|word|label)|precision/i },
			{ key: 'flow', pattern: /dead end|premature|celebration|no.*(?:feedback|confirmation|next step)|flow|journey|disconnect|fragment|coherent|loading|skeleton|empty state|onboarding/i, excludePositive: true },
		],
		buildSections: ( buckets, workedWell, suggestions ) => [
			{ title: 'Information Architecture', items: buckets.ia },
			{ title: 'Visual Coherence', items: buckets.visual },
			{ title: 'Copy & Labeling', items: buckets.copy },
			{ title: 'Flow & Journey', items: buckets.flow },
			{ title: 'What Works Well', items: workedWell },
			{ title: 'Actionable Suggestions', items: suggestions, numbered: true },
		],
	} );
}

function findEnclosingScene(
	scenes: ActionEntry[],
	timestampMs: number
): ActionEntry | undefined {
	for ( let i = scenes.length - 1; i >= 0; i-- ) {
		if ( scenes[ i ].timestampMs <= timestampMs ) {
			return scenes[ i ];
		}
	}
	return undefined;
}

// CLI entry point
if ( process.argv[ 1 ] && process.argv[ 1 ].endsWith( 'report-generator.ts' ) ) {
	const args = process.argv.slice( 2 );
	const opts: ReportOptions = {
		actionLogPath: '',
		screenshotDir: '',
	};

	for ( let i = 0; i < args.length; i++ ) {
		switch ( args[ i ] ) {
			case '--action-log':
				opts.actionLogPath = args[ ++i ];
				break;
			case '--screenshots':
				opts.screenshotDir = args[ ++i ];
				break;
			case '--output':
				opts.outputPath = args[ ++i ];
				break;
		}
	}

	if ( ! opts.actionLogPath || ! opts.screenshotDir ) {
		// eslint-disable-next-line no-console
		console.error(
			'Usage: report-generator --action-log <file> --screenshots <dir> [--output <file>]'
		);
		process.exit( 1 );
	}

	// eslint-disable-next-line no-console
	console.log( generateReport( opts ) );
}
