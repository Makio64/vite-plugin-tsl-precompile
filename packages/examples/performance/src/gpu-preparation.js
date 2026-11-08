/** Observe actual WebGPU calls without replacing their returned pipeline promises. */
export function trackGPUPreparation( device, queue, { now = () => performance.now(), compilationHints = false } = {} ) {

	const names = [ 'createShaderModule', 'createPipelineLayout', 'createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync' ];
	const methods = Object.fromEntries( names.map( name => [ name, { supported: typeof device?.[ name ] === 'function', calls: 0, cpuMs: 0, failures: 0, completed: 0, asyncLatenciesMs: [] } ] ) );
	const pending = new Set(), sources = new Set(), restorers = [], layoutKeys = new Set(), layoutIds = new WeakMap();
	const stages = Object.fromEntries( [ 'vertex', 'fragment', 'compute', 'unknown' ].map( stage => [ stage, { calls: 0, bytes: 0, sources: new Set() } ] ) );
	let nextLayoutId = 1;
	let shaderBytes = 0, hintedModules = 0, skippedHintModules = 0, submitCalls = 0, submitCpuMs = 0, pendingStart = null, asyncWallMs = 0;
	function replace( target, name, wrapper ) {

		const original = target?.[ name ];
		if ( typeof original !== 'function' ) return;
		const observed = wrapper( original );
		target[ name ] = observed;
		restorers.push( () => { if ( target[ name ] === observed ) target[ name ] = original; } );

	}
	for ( const name of names ) replace( device, name, original => function ( ...args ) {

		const record = methods[ name ];
		record.calls ++;
		if ( name === 'createShaderModule' && typeof args[ 0 ]?.code === 'string' ) {

			sources.add( args[ 0 ].code );
			const bytes = new TextEncoder().encode( args[ 0 ].code ).byteLength;
			shaderBytes += bytes;
			// Native Three labels each program with its actual programmable stage.
			const stageName = /^(vertex|fragment|compute)(?:_|$)/.exec( args[ 0 ].label || '' )?.[ 1 ];
			const stage = stages[ stageName || 'unknown' ];
			stage.calls ++; stage.bytes += bytes; stage.sources.add( args[ 0 ].code );
			if ( compilationHints && stageName ) {

				if ( ! /\bfn\s+main\s*\(/.test( args[ 0 ].code ) ) throw new Error( 'Compilation hint trial requires the native Three main entry point' );
				args[ 0 ] = { ...args[ 0 ], compilationHints: [ { entryPoint: 'main' } ] };
				hintedModules ++;

			} else if ( compilationHints ) skippedHintModules ++;

		}
		if ( name === 'createPipelineLayout' ) layoutKeys.add( Array.from( args[ 0 ]?.bindGroupLayouts || [], layout => {

			if ( layout === null ) return 0;
			if ( ! layoutIds.has( layout ) ) layoutIds.set( layout, nextLayoutId ++ );
			return layoutIds.get( layout );

		} ).join( ',' ) );
		const started = now();
		let result;
		try { result = original.apply( this, args ); }
		catch ( error ) { record.failures ++; throw error; }
		finally { record.cpuMs += now() - started; }
		if ( name.endsWith( 'Async' ) && result && typeof result.then === 'function' ) {

			if ( pending.size === 0 ) pendingStart = started;
			let observation;
			const complete = failed => {

				record.completed ++;
				if ( failed ) record.failures ++;
				record.asyncLatenciesMs.push( now() - started );
				pending.delete( observation );
				if ( pending.size === 0 ) { asyncWallMs += now() - pendingStart; pendingStart = null; }

			};
			observation = result.then( () => complete( false ), () => complete( true ) );
			pending.add( observation );

		} else record.completed ++;
		return result;

	} );
	replace( queue, 'submit', original => function ( ...args ) {

		const started = now();
		try { return original.apply( this, args ); }
		finally { submitCalls ++; submitCpuMs += now() - started; }

	} );
	return {
		async settled() { while ( pending.size ) await Promise.all( [ ...pending ] ); },
		snapshot() {

			const api = Object.fromEntries( names.map( name => [ name, { ...methods[ name ], asyncLatenciesMs: [ ...methods[ name ].asyncLatenciesMs ] } ] ) );
			return {
				renderCalls: api.createRenderPipeline.calls + api.createRenderPipelineAsync.calls,
				computeCalls: api.createComputePipeline.calls + api.createComputePipelineAsync.calls,
				asyncCalls: api.createRenderPipelineAsync.calls + api.createComputePipelineAsync.calls,
				apiCpuMs: names.filter( name => /Pipeline(?:Async)?$/.test( name ) ).reduce( ( total, name ) => total + api[ name ].cpuMs, 0 ),
				shaderCalls: api.createShaderModule.calls, uniqueShaderSources: sources.size, shaderBytes, hintedModules, skippedHintModules,
				duplicateShaderRequests: api.createShaderModule.calls - sources.size,
				shaderStages: Object.fromEntries( Object.entries( stages ).map( ( [ stage, record ] ) => [ stage, { calls: record.calls, bytes: record.bytes, uniqueSources: record.sources.size, duplicateRequests: record.calls - record.sources.size } ] ) ),
				layoutCalls: api.createPipelineLayout.calls, uniqueOrderedBindGroupLayouts: layoutKeys.size, duplicateLayoutRequests: api.createPipelineLayout.calls - layoutKeys.size,
				submitSupported: typeof queue?.submit === 'function', submitCalls, submitCpuMs, pendingAsync: pending.size,
				asyncWallMs: asyncWallMs + ( pendingStart === null ? 0 : now() - pendingStart ), api,
			};

		},
		dispose() { for ( const restore of restorers ) restore(); sources.clear(); layoutKeys.clear(); for ( const record of Object.values( stages ) ) record.sources.clear(); },
	};

}

export function gpuPreparationDelta( after, before ) {

	const delta = {};
	for ( const [ name, value ] of Object.entries( after ) ) {

		if ( typeof value === 'number' ) delta[ name ] = value - ( before?.[ name ] || 0 );
		else if ( name === 'api' ) delta.api = Object.fromEntries( Object.entries( value ).map( ( [ method, record ] ) => [ method, {
			...record,
			...Object.fromEntries( [ 'calls', 'cpuMs', 'failures', 'completed' ].map( key => [ key, record[ key ] - ( before?.api?.[ method ]?.[ key ] || 0 ) ] ) ),
			asyncLatenciesMs: record.asyncLatenciesMs.slice( before?.api?.[ method ]?.asyncLatenciesMs.length || 0 ),
		} ] ) );
		else if ( name === 'shaderStages' ) delta.shaderStages = Object.fromEntries( Object.entries( value ).map( ( [ stage, record ] ) => [ stage, gpuPreparationDelta( record, before?.shaderStages?.[ stage ] ) ] ) );
		else delta[ name ] = value;

	}
	return delta;

}
