#!/usr/bin/env node

import { cp, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const repoRoot = resolve( pluginRoot, '../..' );
const source = resolve( repoRoot, '.agents/skills/integrate-tsl-precompile' );
const destination = resolve( pluginRoot, 'skill' );

const skillSource = await readFile( resolve( source, 'SKILL.md' ), 'utf8' );
if ( ! /^---\nname: integrate-tsl-precompile\n/m.test( skillSource ) ) {

	throw new Error( `${ source } is not the canonical integrate-tsl-precompile skill` );

}

await rm( destination, { recursive: true, force: true } );
await cp( source, destination, { recursive: true, force: true } );
console.log( '[tsl-precompile] synchronized the canonical integration skill for package publishing.' );
