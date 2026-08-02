import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const REPO = resolve( import.meta.dirname, '../../../..' );

function read( path ) {

	return readFileSync( resolve( REPO, path ), 'utf8' );

}

function formattedBytes( bytes ) {

	return new Intl.NumberFormat( 'en-US' ).format( bytes );

}

test( 'adoption guides identify checked bundle numbers as baselines and track enforced caps', () => {

	const budget = JSON.parse( read( 'packages/runtime/build-tools/slim-budget.json' ) );
	const claims = [
		[ budget.source.fixtures.minimal.baselineGzipBytes, budget.source.fixtures.minimal.maxGzipBytes ],
		[ budget.source.fixtures.advanced.baselineGzipBytes, budget.source.fixtures.advanced.maxGzipBytes ],
		[ budget.prebuilt.baselineGzipBytes, budget.prebuilt.maxGzipBytes ],
	];
	for ( const path of [ 'README.md', 'BYO.md', 'packages/runtime/README.md' ] ) {

		const source = read( path );
		assert.match( source, /regression baseline/i, `${ path } must label repository fixture numbers as baselines` );
		assert.match( source, /current exact/i, `${ path } must route exact current claims to the analyzer` );
		for ( const [ baseline, maximum ] of claims ) {

			assert.equal( source.includes( formattedBytes( baseline ) ), true, `${ path } omits baseline ${ baseline }` );
			assert.equal( source.includes( formattedBytes( maximum ) ), true, `${ path } omits cap ${ maximum }` );

		}

	}
	const combined = [ 'README.md', 'BYO.md', 'packages/runtime/README.md' ]
		.map( read )
		.join( '\n' );
	for ( const stale of [ '148,370', '156,223', '220,543' ] ) {

		assert.equal( combined.includes( stale ), false, `public adoption docs retain stale bundle claim ${ stale }` );

	}

} );

test( 'primary adoption docs expose the read-only doctor and keep migration on setupPrecompile', () => {

	for ( const path of [ 'README.md', 'BYO.md', 'packages/plugin/README.md' ] ) {

		assert.match(
			read( path ),
			/pnpm exec tsl-precompile-doctor --source src/,
			`${ path } must expose the preflight audit`,
		);

	}
	const migrationBeforeErrors = read( 'MIGRATION.md' ).split( '## Common errors' )[ 0 ];
	assert.match( migrationBeforeErrors, /@tsl-precompile\/runtime\/setup/ );
	assert.match( migrationBeforeErrors, /await setup\.ready/ );
	assert.doesNotMatch( migrationBeforeErrors, /\binstallPrecompileMarker\b|\bsetDevRenderer\b/ );

} );

test( 'agent-facing guides install packages, skill, and doctor in executable order without overstating proof', () => {

	for ( const path of [
		'README.md',
		'packages/plugin/README.md',
		'packages/site/index.html',
		'packages/site/adopt.html',
		'packages/site/public/llms.txt',
	] ) {

		const source = read( path );
		const packageInstall = source.indexOf( 'vite-plugin-tsl-precompile@alpha' );
		const skillInstall = source.indexOf( 'tsl-precompile-install-skill --json' );
		const doctor = source.indexOf( 'tsl-precompile-doctor --json --source src' );
		assert.equal( packageInstall >= 0, true, `${ path } omits the plugin installation` );
		assert.equal( skillInstall > packageInstall, true, `${ path } must install the packaged skill after the plugin` );
		assert.equal( doctor > skillInstall, true, `${ path } must run the doctor after installing the skill` );
		assert.match( source, /route(?:\/state)?(?:\/render)?-?topology|route\/topology|route and advanced render topology/i );
		assert.match( source, /production build|build, and a production/i );
		assert.match( source, /WebGPU preview|WebGPU production preview|backend-matched production preview|production previews/i );
		assert.match( source, /slim mode|slim/i );

	}

} );

test( 'public starts are audit-first, honest about distribution, and compatibility-first', () => {

	for ( const path of [ 'README.md', 'packages/site/index.html', 'packages/site/adopt.html', 'packages/site/public/llms.txt' ] ) {

		const source = read( path );
		assert.match( source, /not published|not on npm/i, `${ path } must disclose pre-release package availability` );
		const audit = source.search( /Before installing(?: packages| or editing)?|Before mutation/i );
		const install = source.indexOf( 'pnpm add -D vite-plugin-tsl-precompile@alpha' );
		assert.equal( audit >= 0 && install > audit, true, `${ path } must audit before package mutation` );

	}
	const landing = read( 'packages/site/index.html' );
	assert.match( landing, /PHASE 1 — READ ONLY/ );
	assert.match( landing, /Stop and wait for my approval\./ );
	assert.match( landing, /1 \/ compatibility/ );
	assert.match( landing, /2 \/ optional slim/ );

	const exampleConfig = read( 'packages/examples/getting-started/vite.config.js' );
	const exampleGuide = read( 'packages/examples/getting-started/README.md' );
	assert.match( exampleConfig, /mode === 'tslp-site-live' \? \{ slim: 'source' \} : \{\}/ );
	assert.match( read( 'packages/site/scripts/build-live-examples.mjs' ), /mode: 'tslp-site-live'/ );
	assert.match( exampleGuide, /compatibility mode first/i );
	assert.match( exampleGuide, /--source main\.js/ );
	assert.match( exampleGuide, /workspace:\*/ );
	const examplePage = read( 'packages/examples/getting-started/index.html' );
	assert.match( examplePage, /runtimeMode: compilerFree \? 'pure-slim' : 'compatibility'/ );
	assert.doesNotMatch( examplePage, /const ready = result\.compilerFree &&/ );
	assert.match( read( 'packages/examples/getting-started/main.js' ), /optional stable-name override/ );
	assert.doesNotMatch( read( 'packages/examples/getting-started/main.js' ), /the one line you add/ );
	const manualGuide = read( 'BYO.md' );
	assert.match( manualGuide, /do not initialize the existing[\s\S]*renderer twice/i );
	assert.match( manualGuide, /existing call — keep exactly one/ );

} );

test( 'agent-facing guides define the shell-free JSON action contract', () => {

	for ( const path of [
		'README.md',
		'packages/plugin/README.md',
		'.agents/skills/integrate-tsl-precompile/SKILL.md',
	] ) {

		const source = read( path );
		assert.match( source, /schema-versioned object/ );
		assert.match( source, /`nextActions`/ );
		assert.match( source, /`argv`/ );
		assert.match( source, /absolute\s+`cwd`/ );
		assert.match( source, /nonzero/ );

	}

} );

test( 'integration skill gives agents one ordered capture-to-production loop', () => {

	const skill = read( '.agents/skills/integrate-tsl-precompile/SKILL.md' );
	const doctor = skill.indexOf( 'pnpm exec tsl-precompile-doctor --json --compact --source src' );
	const recapture = skill.indexOf( 'pnpm exec tsl-precompile-recapture --json', doctor );
	const verify = skill.indexOf( 'pnpm exec tsl-precompile-verify --json', recapture );
	const productionBuild = skill.indexOf( '`production-build` action', verify );
	const productionReplay = skill.indexOf( 'production backend-matched replay', productionBuild );
	assert.equal( doctor >= 0, true );
	assert.equal( recapture > doctor, true );
	assert.equal( verify > recapture, true );
	assert.equal( productionBuild > verify, true );
	assert.equal( productionReplay > productionBuild, true );
	assert.match( skill, /Do not point `tsl-precompile-recapture` at the production preview/ );

} );

test( 'adoption docs distinguish WebGPURenderer WebGL 2 support from classic WebGLRenderer', () => {

	for ( const path of [
		'README.md',
		'BYO.md',
		'MIGRATION.md',
		'packages/plugin/README.md',
		'.agents/skills/integrate-tsl-precompile/SKILL.md',
	] ) {

		const source = read( path );
		assert.match( source, /WebGPURenderer/ );
		assert.match( source, /forceWebGL[\s\S]{0,40}true/ );
		assert.match( source, /classic `?WebGLRenderer`?[\s\S]{0,80}(?:not supported|is not|outside)/i );
		assert.match( source, /WGSL[\s\S]{0,100}GLSL|GLSL[\s\S]{0,100}WGSL/ );

	}

	const prompt = read( '.agents/skills/integrate-tsl-precompile/agents/openai.yaml' );
	assert.match( prompt, /WebGPURenderer \(not classic WebGLRenderer\)/ );
	assert.match( prompt, /WebGPU or WebGL 2 backend/ );
	const installer = read( 'packages/plugin/src/agent-skill-installer.js' );
	assert.match( installer, /production WebGPURenderer preview \(WebGPU or WebGL backend\)/ );

} );

test( 'hard-scene docs expose machine execution and evidence grading', () => {

	const guide = read( 'packages/examples/batch/README.md' );
	assert.match( guide, /spawn `nextAction\.argv` directly from `nextAction\.cwd`/ );
	assert.match( guide, /`status: "completed"`/ );
	assert.match( guide, /`total: 1`/ );
	assert.match( guide, /`pass: 1`/ );
	assert.match( guide, /`fail: 0`/ );
	assert.match( guide, /`pixelGate: \{ pass: true, threshold: 30 \}`/ );
	assert.match( guide, /not an unrelated consumer application's/ );

} );

test( 'published recapture documentation covers every behavior-changing CLI switch', () => {

	const pluginReadme = read( 'packages/plugin/README.md' );
	for ( const option of [
		'--url',
		'--paths',
		'--backends',
		'--timeout',
		'--settle',
		'--allow-empty',
		'--no-headless',
		'--headless',
		'--json',
		'--browser',
		'--source',
		'--source-root',
		'--artifacts',
		'--no-auto-mark',
		'--auto-mark-prefix',
	] ) {

		assert.equal( pluginReadme.includes( `\`${ option }` ) || pluginReadme.includes( `${ option} <` ), true, `plugin README omits ${ option }` );

	}
	for ( const path of [
		'README.md',
		'BYO.md',
		'packages/plugin/README.md',
		'.agents/skills/integrate-tsl-precompile/SKILL.md',
	] ) {

		const source = read( path );
		assert.match( source, /--backends webgpu,webgl/, `${ path } omits the dual-backend command` );

	}

} );

test( 'maintainer docs derive release and source-kind guidance from current contracts', () => {

	const budget = JSON.parse( read( 'packages/runtime/build-tools/slim-budget.json' ) );
	const releasing = read( 'RELEASING.md' );
	assert.equal(
		releasing.includes( `${ formattedBytes( budget.prebuilt.maxGzipBytes ) }-byte cap` ),
		true,
		'release instructions must use the enforced prebuilt gzip cap',
	);
	assert.doesNotMatch( releasing, /300 KB ceiling/ );

	const contributing = read( 'CONTRIBUTING.md' );
	assert.match( contributing, /packages\/contract\/src\/kinds\.js/ );
	assert.match( contributing, /pnpm test:generation/ );
	assert.match( contributing, /pnpm test:coverage/ );
	assert.match( contributing, /runtime writer\/hydration behavior/ );
	assert.doesNotMatch( contributing, /Add a `case '<kind>:'/ );

} );
