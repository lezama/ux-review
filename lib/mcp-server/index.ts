/**
 * UX Recording MCP Server
 *
 * Exposes recording commands as MCP tools so they auto-approve in Claude Code,
 * eliminating the 20-40 permission prompts per UX review session.
 *
 * Tools: ux_session_start, ux_session_step, ux_session_end
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';
import * as fs from 'fs';

import { RecorderSession } from '../recorder.js';
import type { PersonaConfig } from '../recorder.js';
import type { SceneLayout } from '../narrator.js';
import { generateSpeech, getFileDuration } from '../ffmpeg-utils.js';
import { composeSession } from '../compose-session.js';

let session: RecorderSession | null = null;

const server = new Server(
	{ name: 'ux-recording', version: '0.1.0' },
	{ capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// List Tools
// ---------------------------------------------------------------------------

server.setRequestHandler( ListToolsRequestSchema, async () => ( {
	tools: [
		{
			name: 'ux_session_start',
			description:
				'Initialize a UX recording session. Creates output directories and prepares the recorder.',
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
				},
				required: [ 'outputDir', 'personas' ],
			},
		},
		{
			name: 'ux_session_step',
			description:
				'Combined recording step: mark a scene boundary, generate narration audio, and/or register a screenshot. All fields optional except outputDir.',
			inputSchema: {
				type: 'object' as const,
				properties: {
					outputDir: {
						type: 'string',
						description: 'Session output directory',
					},
					scene: {
						type: 'string',
						description: 'Start a new scene with this name',
					},
					layout: {
						type: 'string',
						description: 'Scene layout: full | split | pip-<name>',
					},
					speaker: {
						type: 'string',
						description: 'Active persona for the scene/narration',
					},
					narrate: {
						type: 'string',
						description: 'Text to speak (keep short: 1-2 sentences, 3-5 seconds)',
					},
					voice: {
						type: 'string',
						description: 'TTS voice name (e.g. Samantha, Daniel)',
					},
					capture: {
						type: 'object',
						properties: {
							persona: { type: 'string', description: 'Persona who owns this screenshot' },
							file: { type: 'string', description: 'Absolute path to the screenshot PNG' },
						},
						required: [ 'persona', 'file' ],
						description: 'Register a screenshot capture',
					},
				},
				required: [ 'outputDir' ],
			},
		},
		{
			name: 'ux_session_end',
			description:
				'Finalize the recording session and compose the final video with findings report.',
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

	try {
		switch ( name ) {
			case 'ux_session_start':
				return handleStart( args as Record< string, unknown > );
			case 'ux_session_step':
				return handleStep( args as Record< string, unknown > );
			case 'ux_session_end':
				return handleEnd( args as Record< string, unknown > );
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

function handleStart( args: Record< string, unknown > ) {
	const outputDir = args.outputDir as string;
	const personaNames = args.personas as string[];

	// Build persona configs — assign MCP servers round-robin
	const mcpServers = [ 'chrome-devtools-2', 'chrome-devtools-3' ];
	const personas: Record< string, PersonaConfig > = {};
	for ( let i = 0; i < personaNames.length; i++ ) {
		personas[ personaNames[ i ] ] = {
			mcpServer: mcpServers[ i % mcpServers.length ],
		};
	}

	session = new RecorderSession( { outputDir, personas } );

	return {
		content: [ {
			type: 'text' as const,
			text: JSON.stringify( {
				status: 'started',
				outputDir,
				personas: personaNames,
				screenshotDir: session.getScreenshotDir(),
			} ),
		} ],
	};
}

function handleStep( args: Record< string, unknown > ) {
	if ( ! session ) {
		throw new Error( 'No active session. Call ux_session_start first.' );
	}

	const results: Record< string, unknown > = {};
	const speaker = ( args.speaker as string | undefined ) ?? session.getPersonaNames()[ 0 ];

	// 1. Scene marker
	if ( args.scene ) {
		const layout = ( args.layout as SceneLayout ) ?? 'full';
		session.logScene( args.scene as string, { layout, speaker } );
		results.scene = args.scene;
	}

	// 2. Narration (TTS)
	let narrationDurationSec = 0;
	if ( args.narrate ) {
		const text = args.narrate as string;
		const voice = args.voice as string | undefined;

		const audioDir = path.join( session.getOutputDir(), 'audio' );
		fs.mkdirSync( audioDir, { recursive: true } );
		const audioFile = path.join( audioDir, `narration-${ Date.now() }.aiff` );

		generateSpeech( text, audioFile, voice );
		narrationDurationSec = getFileDuration( audioFile );

		session.logNarration( speaker, audioFile, narrationDurationSec, text );
		results.narrationDuration = narrationDurationSec;
	}

	// 3. Capture (register screenshot)
	if ( args.capture ) {
		const capture = args.capture as { persona: string; file: string };
		const durationMs = narrationDurationSec > 0
			? Math.round( narrationDurationSec * 1000 )
			: undefined;
		const captureResult = session.logScreenshot( capture.persona, capture.file, durationMs );
		results.frame = captureResult.frame;
		results.verified = captureResult.verified;
	}

	return {
		content: [ {
			type: 'text' as const,
			text: JSON.stringify( results ),
		} ],
	};
}

function handleEnd( args: Record< string, unknown > ) {
	if ( ! session ) {
		throw new Error( 'No active session. Call ux_session_start first.' );
	}

	const outputDir = args.outputDir as string;
	const scenarioName = args.scenarioName as string | undefined;

	// Finalize the session (writes manifest)
	const stats = session.finalize();

	// Compose the final video
	const result = composeSession( { outputDir, scenarioName } );

	// Clean up session state
	session = null;

	return {
		content: [ {
			type: 'text' as const,
			text: JSON.stringify( {
				videoPath: result.videoPath,
				findingsPath: result.findingsPath,
				sceneCount: result.sceneCount,
				personas: result.personas,
				stats,
			} ),
		} ],
	};
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect( transport );
