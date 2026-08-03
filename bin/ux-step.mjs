#!/usr/bin/env node
/**
 * ux-step.mjs — Fallback step logger for when the ux-recording MCP server
 * is unavailable. Writes the same steps.jsonl format the server produces,
 * so `dist/compose-session.js <outputDir>` can compile the session.
 *
 * Usage:
 *   node bin/ux-step.mjs start <outputDir> <persona...> [--voices "admin=Samantha,buyer=Daniel"]
 *   node bin/ux-step.mjs step <outputDir> <persona> <screenshotPath> \
 *       [--obs "..."] [--scene name] [--layout full|split|pip-<name>] [--next "..."]
 *
 * The screenshot must live under <outputDir>/screenshots/ (any subdir).
 * The first step of a session MUST include --scene.
 */
import * as fs from 'fs';
import * as path from 'path';

const [ command, outputDir ] = process.argv.slice( 2, 4 );

function die( msg ) {
	console.error( `ERROR: ${ msg }` );
	process.exit( 1 );
}

function parseFlags( argv ) {
	const flags = {};
	for ( let i = 0; i < argv.length; i += 2 ) {
		if ( ! argv[ i ].startsWith( '--' ) || argv[ i + 1 ] === undefined ) {
			die( `Bad flag pair: ${ argv[ i ] }` );
		}
		flags[ argv[ i ].slice( 2 ) ] = argv[ i + 1 ];
	}
	return flags;
}

if ( command === 'start' ) {
	const rest = process.argv.slice( 4 );
	const voicesIdx = rest.indexOf( '--voices' );
	let voicesSpec = '';
	if ( voicesIdx !== -1 ) {
		voicesSpec = rest[ voicesIdx + 1 ] ?? '';
		rest.splice( voicesIdx, 2 );
	}
	const personas = rest;
	if ( ! outputDir || personas.length === 0 ) {
		die( 'Usage: ux-step.mjs start <outputDir> <persona...> [--voices "a=Samantha,b=Daniel"]' );
	}
	for ( const p of personas ) {
		fs.mkdirSync( path.join( outputDir, 'screenshots', p ), { recursive: true } );
	}
	fs.writeFileSync( path.join( outputDir, 'steps.jsonl' ), '' );
	fs.writeFileSync(
		path.join( outputDir, 'session.json' ),
		JSON.stringify( { startTime: Date.now(), personas } )
	);
	if ( voicesSpec ) {
		const voices = Object.fromEntries(
			voicesSpec.split( ',' ).map( ( pair ) => pair.split( '=' ).map( ( s ) => s.trim() ) )
		);
		fs.writeFileSync( path.join( outputDir, 'voices.json' ), JSON.stringify( voices, null, 2 ) );
	}
	console.log( JSON.stringify( { status: 'started', outputDir, personas } ) );
} else if ( command === 'step' ) {
	const [ persona, screenshot ] = process.argv.slice( 4, 6 );
	if ( ! outputDir || ! persona || ! screenshot ) {
		die( 'Usage: ux-step.mjs step <outputDir> <persona> <screenshotPath> [--obs ...] [--scene ...] [--layout ...] [--next ...]' );
	}
	const flags = parseFlags( process.argv.slice( 6 ) );

	const sessionPath = path.join( outputDir, 'session.json' );
	if ( ! fs.existsSync( sessionPath ) ) {
		die( `No session.json in ${ outputDir } — run "ux-step.mjs start" first` );
	}
	const session = JSON.parse( fs.readFileSync( sessionPath, 'utf8' ) );
	const { startTime } = session;

	const logPath = path.join( outputDir, 'steps.jsonl' );
	const step = session.nextStep ?? 0;
	session.nextStep = step + 1;
	fs.writeFileSync( sessionPath, JSON.stringify( session ) );

	let verified = false;
	try {
		verified = fs.statSync( screenshot ).size > 1024;
	} catch {
		// leave unverified
	}

	const entry = {
		step,
		timestampMs: Date.now() - startTime,
		persona,
		screenshot: path.relative( path.join( outputDir, 'screenshots' ), screenshot ),
		observations: flags.obs,
		nextAction: flags.next,
		scene: flags.scene,
		layout: flags.layout,
	};
	Object.keys( entry ).forEach( ( k ) => entry[ k ] === undefined && delete entry[ k ] );
	fs.appendFileSync( logPath, JSON.stringify( entry ) + '\n' );

	const warnings = [];
	if ( step === 0 && ! flags.scene ) {
		warnings.push( 'First step has no --scene; compile will auto-assign one.' );
	}
	if ( entry.screenshot.startsWith( '..' ) ) {
		warnings.push( `Screenshot is outside ${ outputDir }/screenshots/ — the compiled video will not find it.` );
	}
	console.log( JSON.stringify( { step, verified, screenshot: entry.screenshot, warnings: warnings.length ? warnings : undefined } ) );
} else {
	die( 'Usage: ux-step.mjs <start|step> <outputDir> ...' );
}
