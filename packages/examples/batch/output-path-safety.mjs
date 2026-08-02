import { randomUUID } from 'node:crypto';
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
	sep,
} from 'node:path';

const RESERVED_JSON_OUTPUT_NAMES = new Set( [
	'composer.json',
	'coverage-evidence-set.json',
	'coverage-summary.json',
	'deno.json',
	'evidence-manifest.json',
	'example-catalogue.json',
	'examples.json',
	'import-map.json',
	'importmap.json',
	'jsconfig.json',
	'live-examples.json',
	'manifest.json',
	'package-lock.json',
	'package.json',
	'tsconfig.json',
] );

function isWindowsDeviceBasename( value ) {

	const device = String( value ).split( '.', 1 )[ 0 ];
	return /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/i.test( device );

}

function isCanonicalPortableSegment( value, maxLength, { allowDeviceName = false } = {} ) {

	return typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maxLength &&
		/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test( value ) &&
		( allowDeviceName || ! isWindowsDeviceBasename( value ) );

}

function isContained( root, file, { allowRoot = false } = {} ) {

	const rel = relative( resolve( root ), resolve( file ) );
	return ( allowRoot || rel !== '' ) &&
		rel !== '..' &&
		! rel.startsWith( `..${ sep }` ) &&
		! isAbsolute( rel );

}

function statIfPresent( file ) {

	try {

		return lstatSync( file );

	} catch ( error ) {

		if ( error?.code === 'ENOENT' ) return null;
		throw error;

	}

}

function realpathIfPresent( file ) {

	try {

		return realpathSync( file );

	} catch ( error ) {

		if ( error?.code === 'ENOENT' ) return null;
		throw error;

	}

}

function futurePhysicalPath( file, label ) {

	let existing = resolve( file );
	const missing = [];
	let stat = statIfPresent( existing );
	while ( ! stat ) {

		const parent = dirname( existing );
		if ( parent === existing ) throw new Error( `${ label } has no existing filesystem ancestor.` );
		missing.unshift( basename( existing ) );
		existing = parent;
		stat = statIfPresent( existing );

	}
	if ( missing.length === 0 && stat.isSymbolicLink() ) {

		throw new Error( `${ label } must not be a symbolic link: ${ existing }.` );

	}
	if ( missing.length > 0 && ! stat.isDirectory() && ! stat.isSymbolicLink() ) {

		throw new Error( `${ label } has a non-directory existing ancestor: ${ existing }.` );

	}
	let physicalAncestor;
	try {

		physicalAncestor = realpathSync( existing );

	} catch ( cause ) {

		throw new Error( `${ label } has an unresolved existing ancestor: ${ existing }.`, { cause } );

	}
	return resolve( physicalAncestor, ...missing );

}

function physicalReferencePath( file, label ) {

	const physical = futurePhysicalPath( file, label );
	const stat = statIfPresent( physical );
	if ( stat?.isSymbolicLink() ) throw new Error( `${ label } must not be a symbolic link: ${ physical }.` );
	return physical;

}

/**
 * Canonicalize and create a selected output root without first following it
 * into a repository or broad filesystem root.
 */
export function prepareOutputRoot( selectedRoot, {
	repositoryRoot,
	allowedRepositoryRoots = [],
	label = 'Output root',
} = {} ) {

	if ( typeof selectedRoot !== 'string' || selectedRoot.trim().length === 0 ) {

		throw new Error( `${ label } must be a non-empty path.` );

	}
	const lexicalRoot = resolve( selectedRoot );
	const physicalRoot = futurePhysicalPath( lexicalRoot, label );
	if ( physicalRoot === parse( physicalRoot ).root ) {

		throw new Error( `${ label } cannot be a filesystem root.` );

	}
	const physicalTemporaryRoot = futurePhysicalPath( tmpdir(), 'Operating-system temporary root' );
	if ( physicalRoot === physicalTemporaryRoot ) {

		throw new Error( `${ label } cannot be the broad operating-system temporary root.` );

	}
	const conventionalTemporaryRoot = realpathIfPresent( '/tmp' );
	if ( conventionalTemporaryRoot && physicalRoot === resolve( conventionalTemporaryRoot ) ) {

		throw new Error( `${ label } cannot be the broad conventional shared temporary root.` );

	}
	if ( repositoryRoot ) {

		const physicalRepository = physicalReferencePath( repositoryRoot, 'Repository root' );
		const allowed = allowedRepositoryRoots.map( ( root, index ) => (
			physicalReferencePath( root, `${ label } allowed repository root ${ index + 1 }` )
		) );
		if ( isContained( physicalRepository, physicalRoot, { allowRoot: true } ) ) {

			const permitted = allowed.some( ( root ) => isContained( root, physicalRoot, { allowRoot: true } ) );
			if ( ! permitted ) {

				throw new Error(
					`${ label } must use its declared generated directory or a path outside the repository.`,
				);

			}

		}
		if ( isContained( physicalRoot, physicalRepository, { allowRoot: true } ) ) {

			throw new Error( `${ label } cannot be the repository or one of its broad ancestor directories.` );

		}

	}
	mkdirSync( physicalRoot, { recursive: true } );
	const rootStat = lstatSync( physicalRoot );
	if ( rootStat.isSymbolicLink() || ! rootStat.isDirectory() ) {

		throw new Error( `${ label } must resolve to a real directory: ${ physicalRoot }.` );

	}
	const canonicalRoot = realpathSync( physicalRoot );
	if ( canonicalRoot !== physicalRoot ) {

		throw new Error( `${ label } changed filesystem identity while it was prepared.` );

	}
	return canonicalRoot;

}

export function assertSafeJsonOutputName( value, {
	label = 'JSON output filename',
	reservedNames = RESERVED_JSON_OUTPUT_NAMES,
} = {} ) {

	if (
		typeof value !== 'string' ||
		basename( value ) !== value ||
		! value.endsWith( '.json' ) ||
		! isCanonicalPortableSegment(
			value.slice( 0, - '.json'.length ),
			123,
			{ allowDeviceName: true },
		)
	) {

		throw new Error( `${ label } must be a JSON basename inside its output root.` );

	}
	if ( reservedNames.has( value.toLowerCase() ) ) {

		throw new Error( `${ label } ${ JSON.stringify( value ) } is reserved and cannot be overwritten.` );

	}
	if ( isWindowsDeviceBasename( value ) ) {

		throw new Error( `${ label } ${ JSON.stringify( value ) } is a reserved device filename.` );

	}
	return value;

}

export function assertCanonicalExampleName( value, label = 'Example case name' ) {

	if (
		typeof value !== 'string' ||
		basename( value ) !== value ||
		! value.endsWith( '.html' ) ||
		! isCanonicalPortableSegment( value.slice( 0, - '.html'.length ), 195 )
	) {

		throw new Error( `${ label } must be a canonical HTML basename.` );

	}
	return value;

}

export function assertCanonicalExampleId( value, label = 'Example identifier' ) {

	if (
		! isCanonicalPortableSegment( value, 200 )
	) {

		throw new Error( `${ label } must be a canonical path-segment identifier.` );

	}
	return value;

}

function identityOf( stat ) {

	return { dev: stat.dev, ino: stat.ino };

}

function assertSameIdentity( stat, expected, label ) {

	if ( ! expected ) return;
	if ( stat.dev !== expected.dev || stat.ino !== expected.ino ) {

		throw new Error( `${ label } changed filesystem identity while the output operation was in progress.` );

	}

}

function walkExistingOutputPath( root, file, {
	allowRoot = false,
	finalKind = null,
	label = 'Output path',
} = {} ) {

	const canonicalRoot = resolve( root );
	const absolute = resolve( file );
	if ( ! isContained( canonicalRoot, absolute, { allowRoot } ) ) {

		throw new Error( `${ label } escapes its output root ${ canonicalRoot}.` );

	}
	const rootStat = lstatSync( canonicalRoot );
	if ( rootStat.isSymbolicLink() || ! rootStat.isDirectory() ) {

		throw new Error( `${ label } root must be a real directory: ${ canonicalRoot}.` );

	}
	const rel = relative( canonicalRoot, absolute );
	let current = canonicalRoot;
	let targetStat = rootStat;
	let missing = false;
	for ( const segment of rel ? rel.split( sep ) : [] ) {

		current = join( current, segment );
		const stat = statIfPresent( current );
		if ( ! stat ) {

			missing = true;
			targetStat = null;
			continue;

		}
		if ( missing ) throw new Error( `${ label } has an existing child below a missing parent: ${ current}.` );
		if ( stat.isSymbolicLink() ) throw new Error( `${ label } must not traverse a symbolic link: ${ current}.` );
		if ( current !== absolute && ! stat.isDirectory() ) {

			throw new Error( `${ label } traverses a non-directory component: ${ current}.` );

		}
		targetStat = stat;

	}
	if ( targetStat && finalKind === 'file' && ! targetStat.isFile() ) {

		throw new Error( `${ label } is not a regular file: ${ absolute}.` );

	}
	if ( targetStat && finalKind === 'directory' && ! targetStat.isDirectory() ) {

		throw new Error( `${ label } is not a directory: ${ absolute}.` );

	}
	if ( targetStat ) {

		const physical = realpathSync( absolute );
		if ( ! isContained( canonicalRoot, physical, { allowRoot } ) ) {

			throw new Error( `${ label } resolves outside its output root ${ canonicalRoot}.` );

		}

	}
	return { absolute, exists: !! targetStat, stat: targetStat };

}

export function ensureOutputDirectory( root, directory, {
	allowRoot = false,
	label = 'Output directory',
} = {} ) {

	const checked = walkExistingOutputPath( root, directory, { allowRoot, label } );
	if ( ! checked.exists ) mkdirSync( checked.absolute, { recursive: true } );
	walkExistingOutputPath( root, checked.absolute, {
		allowRoot,
		finalKind: 'directory',
		label,
	} );
	return checked.absolute;

}

export function assertOutputDirectoryTarget( root, directory, {
	allowRoot = false,
	label = 'Output directory',
} = {} ) {

	const checked = walkExistingOutputPath( root, directory, {
		allowRoot,
		finalKind: 'directory',
		label,
	} );
	return checked.absolute;

}

export function assertOutputFileTarget( root, file, {
	label = 'Output file',
} = {} ) {

	const absolute = resolve( file );
	ensureOutputDirectory( root, dirname( absolute ), {
		allowRoot: true,
		label: `${ label } parent`,
	} );
	walkExistingOutputPath( root, absolute, { finalKind: 'file', label } );
	return absolute;

}

export function temporaryOutputFile( root, file, {
	label = 'Output file',
	suffix = '.tmp',
} = {} ) {

	const absolute = assertOutputFileTarget( root, file, { label } );
	const parent = dirname( absolute );
	const parentStat = lstatSync( parent );
	const temporary = join( parent, `.${ basename( absolute ) }${ suffix }-${ process.pid }-${ randomUUID() }` );
	walkExistingOutputPath( root, temporary, { label: `${ label } temporary file` } );
	return {
		absolute,
		temporary,
		parentIdentity: identityOf( parentStat ),
	};

}

export function commitTemporaryOutputFile( root, temporary, file, {
	expectedParentIdentity = null,
	expectedTemporaryIdentity = null,
	label = 'Output file',
} = {} ) {

	const absolute = assertOutputFileTarget( root, file, { label } );
	const parent = dirname( absolute );
	assertSameIdentity( lstatSync( parent ), expectedParentIdentity, `${ label } parent` );
	const checkedTemporary = walkExistingOutputPath( root, temporary, {
		finalKind: 'file',
		label: `${ label } temporary file`,
	} );
	if ( ! checkedTemporary.exists || checkedTemporary.stat.nlink !== 1 ) {

		throw new Error( `${ label } temporary file must be a singly linked regular file.` );

	}
	assertSameIdentity(
		checkedTemporary.stat,
		expectedTemporaryIdentity,
		`${ label } temporary file`,
	);
	// Node does not expose renameat(2), so the final path operation cannot be
	// made descriptor-relative. Rechecking the parent immediately before rename
	// closes the practical ancestor-swap window without ever following a final
	// symlink.
	assertSameIdentity( lstatSync( parent ), expectedParentIdentity, `${ label } parent` );
	renameSync( temporary, absolute );
	walkExistingOutputPath( root, absolute, { finalKind: 'file', label } );
	return absolute;

}

export function discardTemporaryOutputFile( root, temporary, label = 'Output temporary file' ) {

	const checked = walkExistingOutputPath( root, temporary, { finalKind: 'file', label } );
	if ( checked.exists ) unlinkSync( checked.absolute );

}

export function writeOutputFileAtomic( root, file, bytes, {
	label = 'Output file',
} = {} ) {

	const {
		absolute,
		temporary,
		parentIdentity,
	} = temporaryOutputFile( root, file, { label } );
	let descriptor = null;
	let temporaryIdentity = null;
	try {

		assertSameIdentity(
			lstatSync( dirname( temporary ) ),
			parentIdentity,
			`${ label } parent`,
		);
		descriptor = openSync( temporary, 'wx', 0o600 );
		const openedStat = fstatSync( descriptor );
		if ( ! openedStat.isFile() || openedStat.nlink !== 1 ) {

			throw new Error( `${ label } temporary file must be a singly linked regular file.` );

		}
		temporaryIdentity = identityOf( openedStat );
		writeFileSync( descriptor, bytes );
		fsyncSync( descriptor );
		assertSameIdentity(
			lstatSync( temporary ),
			temporaryIdentity,
			`${ label } temporary file`,
		);
		closeSync( descriptor );
		descriptor = null;
		return commitTemporaryOutputFile( root, temporary, absolute, {
			expectedParentIdentity: parentIdentity,
			expectedTemporaryIdentity: temporaryIdentity,
			label,
		} );

	} catch ( error ) {

		if ( descriptor !== null ) {

			try { closeSync( descriptor ); } catch {}

		}
		if ( existsSync( temporary ) ) {

			try { discardTemporaryOutputFile( root, temporary, `${ label } temporary file` ); } catch {}

		}
		throw error;

	}

}

export function removeOutputPath( root, file, {
	recursive = false,
	label = 'Output path',
} = {} ) {

	const absolute = resolve( file );
	ensureOutputDirectory( root, dirname( absolute ), {
		allowRoot: true,
		label: `${ label } parent`,
	} );
	const checked = walkExistingOutputPath( root, absolute, { label } );
	if ( checked.exists ) {

		const parentIdentity = identityOf( lstatSync( dirname( absolute ) ) );
		const rechecked = walkExistingOutputPath( root, absolute, { label } );
		if ( ! rechecked.exists ) return absolute;
		assertSameIdentity( rechecked.stat, identityOf( checked.stat ), label );
		assertSameIdentity( lstatSync( dirname( absolute ) ), parentIdentity, `${ label } parent` );
		// As with rename above, Node has no descriptor-relative rm API. The
		// identity checks ensure that normal symlink substitution is rejected.
		rmSync( absolute, { recursive, force: true } );

	}
	return absolute;

}
