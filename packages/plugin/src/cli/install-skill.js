#!/usr/bin/env node

import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installAgentSkill } from '../agent-skill-installer.js';

const rawArgs = process.argv.slice( 2 );
const installSkillCli = fileURLToPath( import.meta.url );
const doctorCli = fileURLToPath( new URL( './doctor.js', import.meta.url ) );

const HELP = `Install the official TSL precompile integration skill into this project.

Usage:
  tsl-precompile-install-skill [--target agents|codex|claude|<directory>] [--force] [--json]

Options:
  --target <value>  Skill root preset or project-relative directory.
                    Default: agents (.agents/skills)
  --force           Replace a locally modified copy of the skill.
  --json            Print one machine-readable JSON result.
  --help            Show this help.
`;

function optionValue( args, index, name ) {

	const value = args[ index + 1 ];
	if ( ! value || value.startsWith( '-' ) ) throw new Error( `${ name } requires a value.` );
	return value;

}

function parseArgs( args ) {

	const options = { target: 'agents', force: false, json: false, help: false };
	for ( let index = 0; index < args.length; index ++ ) {

		const arg = args[ index ];
		if ( arg === '--help' || arg === '-h' ) {

			options.help = true;
			continue;

		}
		if ( arg === '--force' ) {

			options.force = true;
			continue;

		}
		if ( arg === '--json' ) {

			options.json = true;
			continue;

		}
		if ( arg === '--target' ) {

			options.target = optionValue( args, index, '--target' );
			index ++;
			continue;

		}
		if ( arg.startsWith( '--target=' ) ) {

			options.target = arg.slice( '--target='.length );
			continue;

		}
		throw new Error( `Unknown option: ${ arg }` );

	}
	return options;

}

let parsedOptions = null;
try {

	const options = parseArgs( rawArgs );
	parsedOptions = options;
	if ( options.help ) {

		if ( options.json ) console.log( JSON.stringify( {
			schemaVersion: 1,
			ok: true,
			status: 'help',
			command: 'tsl-precompile-install-skill',
			help: HELP.trim(),
			nextActions: [],
		}, null, 2 ) );
		else console.log( HELP );

	} else {

		const result = await installAgentSkill( options );
		const destination = relative( process.cwd(), result.destination ) || '.';
		if ( options.json ) {

			console.log( JSON.stringify( {
				schemaVersion: 1,
				ok: true,
				status: result.status,
				command: 'tsl-precompile-install-skill',
				destination,
				digest: result.digest,
				suggestedAgentPrompt: result.prompt,
				nextActions: [ commandAction( {
					code: 'run-doctor',
					message: 'Run the read-only project doctor before changing the application.',
					argv: [ process.execPath, doctorCli, '--json', '--compact' ],
				} ) ],
			}, null, 2 ) );

		} else {

			console.log( `[tsl-precompile] agent skill ${ result.status }: ${ destination }` );
			console.log( `[tsl-precompile] suggested prompt: ${ result.prompt }` );

		}

	}

} catch ( error ) {

	const message = error.message || String( error );
	if ( rawArgs.includes( '--json' ) ) {

		const localConflict = parsedOptions && /already exists with local changes/.test( message );
		console.log( JSON.stringify( {
			schemaVersion: 1,
			ok: false,
			status: localConflict ? 'conflict' : 'failed',
			command: 'tsl-precompile-install-skill',
			issues: [ message ],
			nextActions: localConflict
				? [ skillConflictAction( parsedOptions.target ) ]
				: [ commandAction( {
					code: 'show-help',
					message: 'Run tsl-precompile-install-skill --help and correct the arguments.',
					argv: [ process.execPath, installSkillCli, '--help' ],
				} ) ],
		}, null, 2 ) );

	} else {

		console.error( `[tsl-precompile] install-skill failed: ${ message }` );

	}
	process.exitCode = 1;

}

function commandAction( { code, message, argv } ) {

	return {
		kind: 'command',
		code,
		message,
		reason: message,
		action: message,
		cwd: process.cwd(),
		argv: [ ...argv ],
		commands: [ [ ...argv ] ],
	};

}

function skillConflictAction( target ) {

	const message = 'Review the locally modified skill before replacing it. If replacement is intentional, execute the commandTemplate exactly; otherwise keep the local copy.';
	return {
		kind: 'manual',
		code: 'resolve-skill-conflict',
		message,
		reason: message,
		action: message,
		cwd: process.cwd(),
		argv: null,
		requiresInput: [ 'replaceLocallyModifiedSkill' ],
		commandTemplate: [
			process.execPath,
			installSkillCli,
			'--target',
			target,
			'--force',
			'--json',
		],
	};

}
