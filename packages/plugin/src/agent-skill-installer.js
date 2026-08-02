import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_SKILL_NAME = 'integrate-tsl-precompile';
export const AGENT_SKILL_PROMPT = 'Use $integrate-tsl-precompile to start with tsl-precompile-doctor --json --compact, execute every emitted nextAction in dependency order, integrate TSL precompilation in compatibility mode, capture every real route and advanced topology on each production backend, verify artifacts, and prove the production build plus production WebGPURenderer preview (WebGPU or WebGL backend) before considering slim mode.';

const packageRoot = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const bundledSkillDir = resolve( packageRoot, 'skill' );
const targetRoots = Object.freeze( {
	agents: '.agents/skills',
	claude: '.claude/skills',
	codex: '.codex/skills',
} );

async function filesUnder( root, current = root ) {

	const entries = await readdir( current, { withFileTypes: true } );
	const files = [];
	for ( const entry of entries ) {

		const path = resolve( current, entry.name );
		if ( entry.isDirectory() ) files.push( ...await filesUnder( root, path ) );
		else if ( entry.isFile() ) files.push( relative( root, path ).replaceAll( '\\', '/' ) );
		else if ( entry.isSymbolicLink() ) throw new Error( `Refusing to digest a skill tree containing a symbolic link: ${ path }` );
		else throw new Error( `Refusing to digest a skill tree containing an unsupported filesystem entry: ${ path }` );

	}
	return files.sort();

}

export async function digestAgentSkillTree( root ) {

	const rootStat = await pathStat( root );
	if ( rootStat === null ) throw new Error( `Cannot digest a missing agent skill tree: ${ root }` );
	if ( rootStat.isSymbolicLink() ) throw new Error( `Refusing to digest a symbolic-link agent skill tree root: ${ root }` );
	if ( ! rootStat.isDirectory() ) throw new Error( `Refusing to digest a non-directory agent skill tree root: ${ root }` );
	const hash = createHash( 'sha256' );
	for ( const file of await filesUnder( root ) ) {

		hash.update( file ).update( '\0' ).update( await readFile( resolve( root, file ) ) ).update( '\0' );

	}
	return hash.digest( 'hex' );

}

export async function digestBundledAgentSkill() {

	return digestAgentSkillTree( bundledSkillDir );

}

async function isDirectory( path ) {

	try {

		return ( await stat( path ) ).isDirectory();

	} catch {

		return false;

	}

}

async function pathStat( path ) {

	try {

		return await lstat( path );

	} catch ( error ) {

		if ( error && error.code === 'ENOENT' ) return null;
		throw error;

	}

}

function resolveTargetRoot( cwd, target ) {

	const requested = targetRoots[ target ] || target;
	if ( typeof requested !== 'string' || requested.length === 0 ) throw new Error( 'The skill target must be a preset or project-relative directory.' );
	const targetRoot = resolve( cwd, requested );
	const fromProject = relative( cwd, targetRoot );
	if ( fromProject === '..' || fromProject.startsWith( `..${ process.platform === 'win32' ? '\\' : '/' }` ) || isAbsolute( fromProject ) ) {

		throw new Error( `Refusing to install outside the current project: ${ requested }` );

	}
	return targetRoot;

}

function isContainedPath( root, candidate ) {

	const fromRoot = relative( root, candidate );
	return fromRoot === '' || (
		fromRoot !== '..' &&
		! fromRoot.startsWith( `..${ sep }` ) &&
		! isAbsolute( fromRoot )
	);

}

async function assertSafeTargetRoot( cwd, targetRoot ) {

	const projectRoot = await realpath( cwd );
	const relativeTarget = relative( resolve( cwd ), targetRoot );
	let current = resolve( cwd );
	for ( const component of relativeTarget.split( sep ).filter( Boolean ) ) {

		current = resolve( current, component );
		const currentStat = await pathStat( current );
		if ( currentStat === null ) break;
		if ( currentStat.isSymbolicLink() ) throw new Error(
			`Refusing to install through a symbolic-link target path: ${ relative( cwd, current ) || '.' }`,
		);
		const currentReal = await realpath( current );
		if ( ! isContainedPath( projectRoot, currentReal ) ) throw new Error(
			`Refusing to install outside the current project through ${ relative( cwd, current ) || '.' }`,
		);

	}

}

export async function installAgentSkill( {
	cwd = process.cwd(),
	target = 'agents',
	force = false,
	sourceDir = bundledSkillDir,
} = {} ) {

	if ( ! await isDirectory( sourceDir ) ) throw new Error(
		'The published package does not contain its agent skill. Reinstall vite-plugin-tsl-precompile or report a packaging bug.',
	);
	const sourceRootStat = await pathStat( sourceDir );
	if ( sourceRootStat && sourceRootStat.isSymbolicLink() ) throw new Error(
		`Refusing to install a symbolic-link skill source root: ${ sourceDir }`,
	);
	const skillSource = await readFile( resolve( sourceDir, 'SKILL.md' ), 'utf8' );
	if ( ! /^---\nname: integrate-tsl-precompile\n/m.test( skillSource ) ) throw new Error(
		'The bundled skill metadata is invalid.',
	);
	const sourceDigest = await digestAgentSkillTree( sourceDir );

	const targetRoot = resolveTargetRoot( cwd, target );
	await assertSafeTargetRoot( cwd, targetRoot );
	const destination = resolve( targetRoot, AGENT_SKILL_NAME );
	const destinationStat = await pathStat( destination );
	if ( destinationStat && destinationStat.isSymbolicLink() ) throw new Error(
		`Refusing to replace a symbolic-link skill destination: ${ relative( cwd, destination ) }`,
	);
	if ( destinationStat && destinationStat.isDirectory() ) {

		if ( sourceDigest === await digestAgentSkillTree( destination ) ) {

			return { destination, status: 'current', prompt: AGENT_SKILL_PROMPT, digest: sourceDigest };

		}
		if ( ! force ) throw new Error(
			`${ relative( cwd, destination ) } already exists with local changes. Re-run with --force only if replacing it is intentional.`,
		);

	}

	await mkdir( targetRoot, { recursive: true } );
	await assertSafeTargetRoot( cwd, targetRoot );
	const stagingRoot = await mkdtemp( resolve( targetRoot, `.${ AGENT_SKILL_NAME }.stage-` ) );
	const temporary = resolve( stagingRoot, 'next' );
	const previous = resolve( stagingRoot, 'previous' );
	let movedPrevious = false;
	try {

		await cp( sourceDir, temporary, { recursive: true, force: true } );
		const stagedDigest = await digestAgentSkillTree( temporary );
		if ( stagedDigest !== sourceDigest ) throw new Error(
			'The bundled skill changed while it was being staged; no project files were replaced.',
		);
		if ( destinationStat ) {

			if ( ! force ) throw new Error(
				`${ relative( cwd, destination ) } already exists with local changes. Re-run with --force only if replacing it is intentional.`,
			);
			await rename( destination, previous );
			movedPrevious = true;

		}
		try {

			await rename( temporary, destination );

		} catch ( error ) {

			if ( movedPrevious ) {

				await rename( previous, destination );
				movedPrevious = false;

			}
			throw error;

		}
		if ( movedPrevious ) {

			await rm( previous, { recursive: true, force: true } );
			movedPrevious = false;

		}

	} finally {

		if ( movedPrevious && ! await pathStat( destination ) ) await rename( previous, destination );
		await rm( stagingRoot, { recursive: true, force: true } );

	}
	return { destination, status: 'installed', prompt: AGENT_SKILL_PROMPT, digest: sourceDigest };

}
