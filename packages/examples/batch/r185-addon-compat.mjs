const R185_VERSION = '0.185.1';
const DISPLAY_ADDON_PREFIX = 'tsl/display/';
const GAUSSIAN_BLUR_ADDON = 'tsl/display/GaussianBlurNode.js';
const FULL_RENDERER_EFFECT_ADDONS = new Set( [
	GAUSSIAN_BLUR_ADDON,
	'tsl/display/RecurrentDenoiseNode.js',
	'tsl/display/SharpenNode.js',
	'tsl/display/TAAUNode.js',
	'tsl/display/TemporalReprojectNode.js',
] );
const FULL_WEBGPU_MODULE = '/build/three.webgpu.js';
const FULL_RENDERER_IMPORTS = new Set( [ 'DepthTexture', 'NodeMaterial', 'RenderTarget' ] );

function namedImportSpecifiers( value ) {

	return value.split( ',' ).map( specifier => specifier.trim() ).filter( Boolean );

}

function namedImportBinding( specifier ) {

	const match = specifier.match(
		/^(?:type\s+)?([_$A-Za-z][\w$]*)(?:\s+as\s+([_$A-Za-z][\w$]*))?$/,
	);
	if ( ! match ) return null;
	return {
		imported: match[ 1 ],
		local: match[ 2 ] || match[ 1 ],
		specifier,
	};

}

/**
 * These display effects are executed by the full-renderer fallback during
 * replay. Keep their materials and render-target resources in that same Three
 * module.
 *
 * The replay import map otherwise supplies slim RenderTarget instances while
 * rewriteReplayAddon supplies a full NodeMaterial. TAAU also constructs its
 * previous-depth attachment from the slim DepthTexture export. With r185,
 * those mixed render-target resources can be initialized by the slim device
 * and then used as full-renderer attachments or texture views, which WebGPU
 * rejects.
 */
function routeEffectRendererImportsToFullThree( source ) {

	const movedByLocalName = new Map();
	const webgpuImport = /^([ \t]*)import\s*\{([^}]*)\}\s*from\s*(['"])three\/webgpu\3\s*;?[ \t]*$/gm;
	let rewritten = source.replace(
		webgpuImport,
		( statement, indent, specifierSource, quote ) => {

			const kept = [];
			for ( const specifier of namedImportSpecifiers( specifierSource ) ) {

				const binding = namedImportBinding( specifier );
				if ( binding && FULL_RENDERER_IMPORTS.has( binding.imported ) ) {

					if ( ! movedByLocalName.has( binding.local ) ) movedByLocalName.set( binding.local, binding );

				} else {

					kept.push( specifier );

				}

			}
			if ( kept.length === 0 ) return '';
			return `${ indent }import { ${ kept.join( ', ' ) } } from ${ quote }three/webgpu${ quote };`;

		},
	);

	if ( movedByLocalName.size === 0 ) return source;

	const directImport = /^([ \t]*)import\s*\{([^}]*)\}\s*from\s*(['"])\/build\/three\.webgpu\.js\3\s*;?[ \t]*$/gm;
	const existingLocalNames = new Set();
	for ( const match of rewritten.matchAll( directImport ) ) {

		for ( const specifier of namedImportSpecifiers( match[ 2 ] ) ) {

			const binding = namedImportBinding( specifier );
			if ( binding ) existingLocalNames.add( binding.local );

		}

	}

	const missing = [ ...movedByLocalName.values() ].filter( binding => ! existingLocalNames.has( binding.local ) );
	if ( missing.length === 0 ) return rewritten;

	let merged = false;
	rewritten = rewritten.replace(
		directImport,
		( statement, indent, specifierSource, quote ) => {

			if ( merged ) return statement;
			merged = true;
			const specifiers = namedImportSpecifiers( specifierSource );
			specifiers.push( ...missing.map( binding => binding.specifier ) );
			return `${ indent }import { ${ specifiers.join( ', ' ) } } from ${ quote }${ FULL_WEBGPU_MODULE }${ quote };`;

		},
	);

	if ( merged ) return rewritten;
	return `import { ${ missing.map( binding => binding.specifier ).join( ', ' ) } } from '${ FULL_WEBGPU_MODULE }';\n${ rewritten }`;

}

function addContextImport( source ) {

	return source.replace(
		/^import\s*\{([^}\n]*)\}\s*from\s*(['"])three\/tsl\2;?$/m,
		( statement, specifiers, quote ) => {

			const names = specifiers.split( ',' ).map( value => value.trim() ).filter( Boolean );
			if ( names.some( name => /^(?:context|context\s+as\s+)/.test( name ) ) ) return statement;
			return `import { ${ names.join( ', ' ) }, context } from ${ quote }three/tsl${ quote };`;

		},
	);

}

/**
 * Backport the material-level shared-context portion of three.js PR #34025
 * to the exact r185.1 display addons used by the compatibility harness.
 *
 * r185 wrapped each internal shader node in `.context(...)`. That can hide
 * uniforms from sibling pipeline stages. r185 already supports
 * `NodeMaterial.contextNode`, so moving the shared context there is a narrow,
 * version-gated compatibility fix that does not require the newer pipeline
 * event API introduced by the rest of the PR.
 */
export function rewriteR185AddonCompatibility( source, {
	relativePath = '',
	threeVersion = '',
} = {} ) {

	const input = String( source );
	if ( threeVersion !== R185_VERSION || ! relativePath.startsWith( DISPLAY_ADDON_PREFIX ) ) return input;

	let output = input;

	// FSR1Node and SharpenNode call their local shared-context object
	// `context`, which would collide with the TSL context() import.
	if ( /\.context\(\s*context\s*\)/.test( output ) && /const context = builder\.getSharedContext\(\);/.test( output ) ) {

		output = output
			.replace( /const context = builder\.getSharedContext\(\);/g, 'const sharedContext = builder.getSharedContext();' )
			.replace( /\.context\(\s*context\s*\)/g, '.context( sharedContext )' );

	}

	output = output.replace(
		/^(\s*)((?:this\.)?[_$A-Za-z][\w$]*(?:\.[_$A-Za-z][\w$]*)*)\.(fragmentNode|colorNode|vertexNode)\s*=\s*(.+)\.context\(\s*(builder\.getSharedContext\(\)|this\._sharedContext|sharedContext)\s*\);\s*$/gm,
		( _statement, indent, material, property, nodeExpression, sharedContext ) => (
			`${ indent }${ material }.contextNode = context( ${ sharedContext } );\n` +
			`${ indent }${ material }.${ property } = ${ nodeExpression };`
		),
	);

	// RecurrentDenoise's local named helper closes over adaptiveTrust,
	// resolution and the raw texture. r185 caches setLayout() function WGSL
	// across builders even though anonymous uniform names are builder-local,
	// so a warm build can reuse object.nodeUniformN references without adding
	// the corresponding fields to that builder's uniform struct. Keep this
	// one helper ordinary/inlined so every builder traverses its dependencies.
	if ( relativePath === 'tsl/display/RecurrentDenoiseNode.js' ) {

		output = output.replace(
			/(\}\s*\))\.setLayout\(\s*\{\s*name:\s*'getNeighborhoodStats',\s*type:\s*'vec4',\s*inputs:\s*\[\s*\{\s*name:\s*'uvCoord',\s*type:\s*'vec2'\s*\},\s*\{\s*name:\s*'centerSample',\s*type:\s*'vec4'\s*\}\s*\]\s*\}\s*\);/,
			'$1;',
		);

	}

	// TemporalReprojectNode returns its resolve node directly from a helper,
	// so move that helper's context to the owning material as well.
	output = output.replace(
		/^(\s*)return resolve\(\)\.context\(\s*builder\.getSharedContext\(\)\s*\);\s*$/m,
		( _statement, indent ) => (
			`${ indent }this._resolveMaterial.contextNode = context( builder.getSharedContext() );\n\n` +
			`${ indent }return resolve();`
		),
	);

	// r185 TRAA/TAAU resolve materials did not wrap the resolve node, but the
	// official fix assigns the same pipeline context at material level.
	if ( relativePath === 'tsl/display/TRAANode.js' ) {

		output = output.replace(
			/^(\s*)this\._resolveMaterial\.colorNode = resolve\(\);$/m,
			'$1this._resolveMaterial.contextNode = context( builder.getSharedContext() );\n$&',
		);

	} else if ( relativePath === 'tsl/display/TAAUNode.js' ) {

		if ( ! output.includes( 'this._resolveMaterial.contextNode = sharedContext;' ) ) {

			output = output.replace(
				/^(\s*)this\._resolveMaterial\.colorNode = resolve\(\);$/m,
				'$1const sharedContext = context( builder.getSharedContext() );\n\n$1this._resolveMaterial.contextNode = sharedContext;\n$&',
			);

		}
		if ( ! output.includes( 'this._seedMaterial.contextNode = sharedContext;' ) ) {

			output = output.replace(
				/^(\s*)this\._seedMaterial\.outputNode = outputNode;$/m,
				'$1this._seedMaterial.contextNode = sharedContext;\n$&',
			);

		}

	}

	// SSRNode declares five blur mip levels on a constructor-time 1×1 target.
	// Normal rendering resizes it before first use, but capture/replay graph
	// discovery can initialize the target earlier. Sixteen is the smallest
	// legal base dimension for five WebGPU mip levels and is replaced by the
	// actual drawing-buffer size on the first authored update.
	if ( relativePath === 'tsl/display/SSRNode.js' ) {

		output = output
			.replace(
				/this\._blurRenderTarget = new RenderTarget\(\s*1,\s*1,\s*\{\s*depthBuffer:/,
				'this._blurRenderTarget = new RenderTarget( 16, 16, { depthBuffer:',
			)
			.replace(
				/width = Math\.round\(\s*this\.resolutionScale \* width\s*\);\s*\n\s*height = Math\.round\(\s*this\.resolutionScale \* height\s*\);/,
				'width = Math.max( 16, Math.round( this.resolutionScale * width ) );\n\t\theight = Math.max( 16, Math.round( this.resolutionScale * height ) );',
			);

	}

	const contextCompatible = output === input ? input : addContextImport( output );
	return FULL_RENDERER_EFFECT_ADDONS.has( relativePath )
		? routeEffectRendererImportsToFullThree( contextCompatible )
		: contextCompatible;

}
