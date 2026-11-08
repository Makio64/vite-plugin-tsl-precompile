import { parse } from '@babel/parser';
import _generate from '@babel/generator';
import * as t from '@babel/types';

const generate = _generate.default || _generate;
const compact = node => generate( node, { compact: true, comments: false } ).code;
const nativeSelection = parse( `if ( parameters.forceWebGL ) {
	BackendClass = WebGLBackend;
} else {
	BackendClass = WebGPUBackend;
	parameters.getFallback = () => {
		warn( 'WebGPURenderer: WebGPU is not available, running under WebGL2 backend.' );
		return new WebGLBackend( parameters );
	};
}` ).program.body[ 0 ];

/** Remove the optional fallback only from an explicitly WebGPU-only source build. */
export function rewriteWebGPUOnlyRenderer( ast, enabled ) {

	if ( enabled !== true ) return;
	const renderer = ast.program.body.find( node => t.isClassDeclaration( node ) && node.id?.name === 'WebGPURenderer' );
	const constructor = renderer?.body.body.find( node => t.isClassMethod( node ) && node.kind === 'constructor' );
	const statements = constructor?.body.body;
	if ( ! statements || ! t.isVariableDeclaration( statements[ 0 ], { kind: 'let' } ) ||
		statements[ 0 ].declarations.length !== 1 || ! t.isIdentifier( statements[ 0 ].declarations[ 0 ].id, { name: 'BackendClass' } ) ||
		statements[ 0 ].declarations[ 0 ].init !== null || compact( statements[ 1 ] ) !== compact( nativeSelection ) ) {

		throw new Error( 'WebGPURenderer: WebGPU-only backend selection shape changed' );

	}
	const replacement = parse( `if ( parameters.forceWebGL ) {
		throw new Error( '[tsl-precompile] webgpuOnly source builds require WebGPU; forceWebGL is unavailable.' );
	}
	let BackendClass = WebGPUBackend;
	parameters.getFallback = null;` ).program.body;
	statements.splice( 0, 2, ...replacement );
	const imports = ast.program.body.filter( node => t.isImportDeclaration( node ) && /\/webgl-fallback\/WebGLBackend\.js$/.test( node.source.value ) );
	if ( imports.length !== 1 ) throw new Error( 'WebGPURenderer: WebGPU-only fallback import shape changed' );
	ast.program.body.splice( ast.program.body.indexOf( imports[ 0 ] ), 1 );

}
