/**
 * UX Recording MCP Server
 *
 * Exposes recording commands as MCP tools so they auto-approve in Claude Code,
 * eliminating the 20-40 permission prompts per UX review session.
 *
 * Tools: ux_record_start, ux_record_step, ux_record_compile
 */
import * as fs from 'fs';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { StepRecorderSession } from '../recorder.js';
import type { SceneLayout } from '../types.js';
import { compileFromSteps } from '../compose-session.js';
import type { FindingsMode } from '../report-generator.js';

let stepSession: StepRecorderSession | null = null;

const server = new Server(
	{ name: 'ux-recording', version: '0.3.4' },
	{ capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// List Tools
// ---------------------------------------------------------------------------

server.setRequestHandler( ListToolsRequestSchema, async () => ( {
	tools: [
		{
			name: 'ux_record_start',
			description:
				'Initialize a step-based recording session. No TTS during recording — observations become narration at compile time.',
			inputSchema: {
				type: 'object' as const,
				properties: {
					outputDir: {
						type: 'string',
						description: 'Directory for recording output (e.g. /tmp/ux-review-1234)',
					},
					personas: {
						type: 'array',
						items: { type: 'string' },
						description: 'Persona names (e.g. ["admin", "buyer"])',
					},
					voices: {
						type: 'object',
						additionalProperties: { type: 'string' },
						description: 'Optional persona → TTS voice map (e.g. {"admin": "Samantha", "buyer": "Daniel"}). Used at compile time.',
					},
				},
				required: [ 'outputDir', 'personas' ],
			},
		},
		{
			name: 'ux_record_step',
			description:
				'Record one step: screenshot + observations + optional scene marker. No TTS — observations become narration at compile time.',
			inputSchema: {
				type: 'object' as const,
				properties: {
					outputDir: {
						type: 'string',
						description: 'Session output directory',
					},
					persona: {
						type: 'string',
						description: 'Which persona is acting',
					},
					screenshot: {
						type: 'string',
						description: 'Absolute path to the screenshot PNG file',
					},
					observations: {
						type: 'string',
						description: 'What the tester observes (becomes narration audio at compile time). 1-2 sentences.',
					},
					nextAction: {
						type: 'string',
						description: 'What they will do next (context only, not spoken)',
					},
					scene: {
						type: 'string',
						description: 'Start a new scene with this name (omit to continue current scene)',
					},
					layout: {
						type: 'string',
						description: 'Scene layout: full | split | pip-<name>',
					},
				},
				required: [ 'outputDir', 'persona', 'screenshot' ],
			},
		},
		{
			name: 'ux_record_compile',
			description:
				'Compile a step-based recording: batch TTS from observations, measure durations, assemble video, generate findings.',
			inputSchema: {
				type: 'object' as const,
				properties: {
					outputDir: {
						type: 'string',
						description: 'Session output directory',
					},
					scenarioName: {
						type: 'string',
						description: 'Name for the scenario (used in the findings report title)',
					},
					mode: {
						type: 'string',
						enum: [ 'simulator', 'expert' ],
						description: 'Findings mode: "simulator" (default) uses positive/negative signals, "expert" classifies by review lens (IA, visual, copy, flow)',
					},
					skipVideo: {
						type: 'boolean',
						description: 'Skip TTS and video assembly — only generate findings.md. Much faster.',
					},
				},
				required: [ 'outputDir' ],
			},
		},
	],
} ) );

// ---------------------------------------------------------------------------
// Call Tool
// ---------------------------------------------------------------------------

server.setRequestHandler( CallToolRequestSchema, async ( request ) => {
	const { name, arguments: args } = request.params;
	const progressToken = request.params._meta?.progressToken;

	try {
		switch ( name ) {
			case 'ux_record_start':
				return handleRecordStart( args as Record< string, unknown > );
			case 'ux_record_step':
				return handleRecordStep( args as Record< string, unknown > );
			case 'ux_record_compile':
				return handleRecordCompile( args as Record< string, unknown >, progressToken );
			default:
				return {
					content: [ { type: 'text' as const, text: `Unknown tool: ${ name }` } ],
					isError: true,
				};
		}
	} catch ( err ) {
		const message = err instanceof Error ? err.message : String( err );
		return {
			content: [ { type: 'text' as const, text: `Error: ${ message }` } ],
			isError: true,
		};
	}
} );

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleRecordStart( args: Record< string, unknown > ) {
	const outputDir = args.outputDir as string;
	const personas = args.personas as string[];
	const voices = args.voices as Record< string, string > | undefined;

	stepSession = new StepRecorderSession( { outputDir, personas } );

	if ( voices && Object.keys( voices ).length > 0 ) {
		fs.writeFileSync( path.join( outputDir, 'voices.json' ), JSON.stringify( voices, null, 2 ) );
	}

	return {
		content: [ {
			type: 'text' as const,
			text: JSON.stringify( {
				status: 'started',
				format: 'step-based',
				outputDir,
				personas,
				screenshotDir: stepSession.getScreenshotDir(),
			} ),
		} ],
	};
}

function handleRecordStep( args: Record< string, unknown > ) {
	if ( ! stepSession ) {
		throw new Error( 'No active step session. Call ux_record_start first.' );
	}

	const persona = args.persona as string;
	const screenshotFile = args.screenshot as string;

	const result = stepSession.logStep( {
		persona,
		screenshotFile,
		observations: ( args.observations ?? args.observation ) as string | undefined,
		nextAction: args.nextAction as string | undefined,
		scene: args.scene as string | undefined,
		layout: args.layout as SceneLayout | undefined,
	} );

	return {
		content: [ {
			type: 'text' as const,
			text: JSON.stringify( result ),
		} ],
	};
}

function handleRecordCompile(
	args: Record< string, unknown >,
	progressToken?: string | number
) {
	const outputDir = args.outputDir as string;
	const scenarioName = args.scenarioName as string | undefined;
	const mode = ( args.mode as FindingsMode | undefined ) ?? 'simulator';
	const skipVideo = !! args.skipVideo;

	// Finalize session if active
	if ( stepSession ) {
		stepSession.finalize();
		stepSession = null;
	}

	// Speak up as we go. A full compile runs for many minutes of TTS and
	// ffmpeg work, and a silent stretch that long gets the call killed by
	// the client's idle timeout.
	let progress = 0;
	const onProgress =
		progressToken === undefined
			? undefined
			: ( message: string ) => {
					progress++;
					void server.notification( {
						method: 'notifications/progress',
						params: { progressToken, progress, message },
					} );
			  };

	const result = compileFromSteps( { outputDir, scenarioName, mode, skipVideo, onProgress } );

	return {
		content: [ {
			type: 'text' as const,
			text: JSON.stringify( {
				videoPath: result.videoPath,
				findingsPath: result.findingsPath,
				issuePath: result.issuePath,
				sceneCount: result.sceneCount,
				personas: result.personas,
			} ),
		} ],
	};
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect( transport );
