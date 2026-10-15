// Three's private pipeline key can repeat across pages with different MRT
// component widths. Include only the emitted fragment output interface, never
// input varyings, generated member names, uniforms, or shader implementation.
export function fragmentOutputInterface( source, language ) {

	const shader = String( source || '' ).replace( /\/\*[\s\S]*?\*\//g, '' ).replace( /\/\/.*$/gm, '' );
	let outputs;
	if ( language === 'wgsl' ) {

		const entry = shader.match( /@fragment[\s\S]*?fn\s+\w+\s*\([\s\S]*?\)\s*->\s*([^\{]+)\{/ );
		if ( ! entry ) return null;
		const returnType = entry[ 1 ].trim();
		const direct = returnType.match( /@location\s*\(\s*(\d+)\s*\)\s*([\w<>\s]+)$/ );
		if ( direct ) return [ [ Number( direct[ 1 ] ), direct[ 2 ].replace( /\s/g, '' ) ] ];
		const name = returnType.match( /^\w+/ )?.[ 0 ];
		if ( ! name ) return null;
		const body = shader.match( new RegExp( `\\bstruct\\s+${ name }\\s*\\{([\\s\\S]*?)\\}` ) )?.[ 1 ];
		if ( body === undefined ) return null;
		outputs = [ ...body.matchAll( /@location\s*\(\s*(\d+)\s*\)\s*\w+\s*:\s*([^,;\n}]+)/g ) ]
			.map( match => [ Number( match[ 1 ] ), match[ 2 ].replace( /\s/g, '' ) ] );

	} else {

		outputs = [ ...shader.matchAll( /\blayout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*out\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+\w+\s*;/g ) ]
			.map( match => [ Number( match[ 1 ] ), match[ 2 ] ] );

	}
	return outputs.length ? outputs.sort( ( a, b ) => a[ 0 ] - b[ 0 ] ) : null;

}
