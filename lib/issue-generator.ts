/**
 * Issue Generator — Transform UX findings into a Linear-ready issue.
 *
 * Generates a structured issue body with:
 *   - Summary
 *   - Action items as a checklist
 *   - Key screenshots with captions
 *   - Detailed findings by category
 */
import * as fs from 'fs';
import * as path from 'path';
import type { StepEntry } from './step-log.js';
import type { Findings, FindingsMode } from './report-generator.js';

export interface IssueContent {
	/** Suggested issue title */
	title: string;
	/** Markdown body ready for Linear */
	body: string;
	/** Key screenshots to attach (absolute paths + captions) */
	screenshots: Array< { path: string; caption: string; step: number } >;
}

export function generateIssueContent( options: {
	steps: StepEntry[];
	findings: Findings;
	scenarioName?: string;
	mode?: FindingsMode;
	screenshotDir: string;
} ): IssueContent {
	const { steps, findings, scenarioName, mode = 'simulator', screenshotDir } = options;

	const title = `UX Review: ${ scenarioName ?? findings.scenario ?? 'Untitled' }`;

	// Pick key screenshots: prefer steps that start scenes (most representative),
	// then fill with other narrated steps up to a cap of 6
	const MAX_SCREENSHOTS = 6;
	const sceneSteps = steps.filter( ( s ) => s.scene && s.observations );
	const otherNarrated = steps.filter( ( s ) => ! s.scene && s.observations );
	const selected = [ ...sceneSteps, ...otherNarrated ].slice( 0, MAX_SCREENSHOTS );

	const keyScreenshots = selected
		.map( ( s ) => ( {
			path: path.join( screenshotDir, s.screenshot ),
			caption: s.observations!.split( '.' )[ 0 ].trim(),
			step: s.step,
		} ) )
		.filter( ( s ) => fs.existsSync( s.path ) );

	// Build action items from friction points and suggestions
	const actionItems = buildActionItems( findings );

	// Build the issue body
	const sections: string[] = [];

	// Summary
	sections.push( `## Summary\n` );
	sections.push( buildSummary( findings, steps, mode ) );

	// Action items
	if ( actionItems.length > 0 ) {
		sections.push( `## Action Items\n` );
		sections.push( actionItems.map( ( item ) => `- [ ] ${ item }` ).join( '\n' ) );
	}

	// What worked well (collapsed — keep focus on actions)
	if ( findings.workedWell.length > 0 ) {
		sections.push( `## What Worked Well\n` );
		sections.push( findings.workedWell.map( ( w ) => `- ${ w }` ).join( '\n' ) );
	}

	// Screenshots section — placeholders for the agent to fill with uploaded URLs
	if ( keyScreenshots.length > 0 ) {
		sections.push( `## Key Screenshots\n` );
		sections.push(
			`> **Agent:** Upload these screenshots as attachments and replace paths with Linear URLs.\n`
		);
		for ( const ss of keyScreenshots ) {
			sections.push( `**Step ${ ss.step }** — ${ ss.caption }` );
			sections.push( `\`${ ss.path }\`\n` );
		}
	}

	const body = sections.join( '\n\n' );

	return { title, body, screenshots: keyScreenshots };
}

/** Signals that the observation is describing a problem, not praising something. */
const FRICTION_SIGNAL = /however|but |redundant|confus|fragment|inconsisten|missing|broken|wrong|error|dead end|disconnect|awkward|clutter|odd|strange|three different|two different|another navigation|yet another/i;

/** Signals the first sentence is praising, not reporting a problem. */
const PRAISE_OPENER = /^(?:the .+ (?:is|are) well|well-designed|well-crafted|well-organized|clean|intuitive|smart|good |nice |great )/i;

/**
 * Extract actionable items from friction points.
 * Skips items that are primarily positive. Extracts the "However..." clause
 * when the observation starts positive then pivots to a problem.
 */
function buildActionItems( findings: Findings ): string[] {
	const items: string[] = [];
	const seen = new Set< string >();

	for ( const point of findings.frictionPoints ) {
		// Extract scene tag if present
		const tagMatch = point.match( /^\[(.+?)\]\s*/ );
		const tag = tagMatch ? tagMatch[ 1 ] : '';
		const text = tagMatch ? point.slice( tagMatch[ 0 ].length ) : point;

		// Skip entries that don't have any friction signal
		if ( ! FRICTION_SIGNAL.test( text ) ) {
			continue;
		}

		// Extract the problem part:
		// 1. If there's a "However/But" pivot, use what follows
		// 2. Otherwise use the first sentence — but only if it has a friction signal
		let actionText: string;
		const pivot = text.match( /(?:However|But),?\s+(.+)/i );
		if ( pivot ) {
			actionText = pivot[ 1 ];
		} else {
			// First sentence — check it's actually about a problem
			const firstSentence = text.match( /^[^.!?]+[.!?]/ );
			const candidate = firstSentence ? firstSentence[ 0 ].trim() : text.slice( 0, 120 ).trim();
			if ( ! FRICTION_SIGNAL.test( candidate ) ) {
				continue; // The friction signal is buried deeper — not a clean action item
			}
			actionText = text;
		}

		// First sentence only — keep it scannable
		const firstSentence = actionText.match( /^[^.!?]+[.!?]/ );
		const brief = firstSentence ? firstSentence[ 0 ].trim() : actionText.slice( 0, 120 ).trim();

		const key = brief.toLowerCase().slice( 0, 50 );
		if ( seen.has( key ) ) {
			continue;
		}
		seen.add( key );

		items.push( tag ? `**${ tag }:** ${ brief }` : brief );
	}

	return items;
}

function buildSummary( findings: Findings, steps: StepEntry[], mode: FindingsMode ): string {
	const scenes = new Set( steps.filter( ( s ) => s.scene ).map( ( s ) => s.scene ) );
	const personas = [ ...new Set( steps.map( ( s ) => s.persona ) ) ];
	const narrated = steps.filter( ( s ) => s.observations ).length;

	const lines: string[] = [];

	const modeLabel = mode === 'expert' ? 'Expert UX review' : 'UX review';
	lines.push(
		`${ modeLabel } covering **${ scenes.size } scenes** across ` +
		`**${ steps.length } steps** (${ narrated } with observations) ` +
		`for ${ personas.length } persona(s): ${ personas.join( ', ' ) }.`
	);

	lines.push( '' );
	lines.push( `- **${ findings.frictionPoints.length }** friction points found` );
	lines.push( `- **${ findings.workedWell.length }** things working well` );
	lines.push( `- **${ findings.suggestions.length }** suggestions` );

	return lines.join( '\n' );
}
