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
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { StepRecorderSession } from '../recorder.js';
import { compileFromSteps } from '../compose-session.js';
let stepSession = null;
const server = new Server({ name: 'ux-recording', version: '0.3.0' }, { capabilities: { tools: {} } });
// ---------------------------------------------------------------------------
// List Tools
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'ux_record_start',
            description: 'Initialize a step-based recording session. No TTS during recording — observations become narration at compile time.',
            inputSchema: {
                type: 'object',
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
                required: ['outputDir', 'personas'],
            },
        },
        {
            name: 'ux_record_step',
            description: 'Record one step: screenshot + observations + optional scene marker. No TTS — observations become narration at compile time.',
            inputSchema: {
                type: 'object',
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
                required: ['outputDir', 'persona', 'screenshot'],
            },
        },
        {
            name: 'ux_record_compile',
            description: 'Compile a step-based recording: batch TTS from observations, measure durations, assemble video, generate findings.',
            inputSchema: {
                type: 'object',
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
                        enum: ['simulator', 'expert'],
                        description: 'Findings mode: "simulator" (default) uses positive/negative signals, "expert" classifies by review lens (IA, visual, copy, flow)',
                    },
                    skipVideo: {
                        type: 'boolean',
                        description: 'Skip TTS and video assembly — only generate findings.md. Much faster.',
                    },
                },
                required: ['outputDir'],
            },
        },
    ],
}));
// ---------------------------------------------------------------------------
// Call Tool
// ---------------------------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case 'ux_record_start':
                return handleRecordStart(args);
            case 'ux_record_step':
                return handleRecordStep(args);
            case 'ux_record_compile':
                return handleRecordCompile(args);
            default:
                return {
                    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                    isError: true,
                };
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});
// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
function handleRecordStart(args) {
    const outputDir = args.outputDir;
    const personas = args.personas;
    const voices = args.voices;
    stepSession = new StepRecorderSession({ outputDir, personas });
    if (voices && Object.keys(voices).length > 0) {
        fs.writeFileSync(path.join(outputDir, 'voices.json'), JSON.stringify(voices, null, 2));
    }
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({
                    status: 'started',
                    format: 'step-based',
                    outputDir,
                    personas,
                    screenshotDir: stepSession.getScreenshotDir(),
                }),
            }],
    };
}
function handleRecordStep(args) {
    if (!stepSession) {
        throw new Error('No active step session. Call ux_record_start first.');
    }
    const persona = args.persona;
    const screenshotFile = args.screenshot;
    const result = stepSession.logStep({
        persona,
        screenshotFile,
        observations: (args.observations ?? args.observation),
        nextAction: args.nextAction,
        scene: args.scene,
        layout: args.layout,
    });
    return {
        content: [{
                type: 'text',
                text: JSON.stringify(result),
            }],
    };
}
function handleRecordCompile(args) {
    const outputDir = args.outputDir;
    const scenarioName = args.scenarioName;
    const mode = args.mode ?? 'simulator';
    const skipVideo = !!args.skipVideo;
    // Finalize session if active
    if (stepSession) {
        stepSession.finalize();
        stepSession = null;
    }
    const result = compileFromSteps({ outputDir, scenarioName, mode, skipVideo });
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({
                    videoPath: result.videoPath,
                    findingsPath: result.findingsPath,
                    issuePath: result.issuePath,
                    sceneCount: result.sceneCount,
                    personas: result.personas,
                }),
            }],
    };
}
// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=index.js.map