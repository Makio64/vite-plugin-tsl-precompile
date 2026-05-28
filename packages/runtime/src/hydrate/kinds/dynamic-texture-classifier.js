/**
 * Table-driven dispatch for dynamic-texture binding kinds.
 *
 * Replaces the inline `if (planSource.kind === 'depth.texture') ...
 * if (planSource.kind === 'artifact.texture') ...` chain that used to live in
 * `hydrator.js`. The hydrator now passes each `artifact.dynamicBindings`
 * entry whose target is a sampled-texture or sampler through this dispatcher,
 * and one of the per-kind classifiers below decides which typed bag the
 * runtime binding lands in.
 *
 * Adding a new texture-shaped dynamic kind = add one entry to `CLASSIFIERS`
 * (or a `*_PREFIX_CLASSIFIERS` rule) plus one handler. The hydrator's outer
 * loop does not change.
 *
 * @module Hydrate.Kinds.DynamicTextureClassifier
 */

import { collectArtifactDynamicBindings } from '@tsl-precompile/contract/dynamic-bindings';

function isSampledTextureOrSampler( runtimeBinding ) {

	return !! ( runtimeBinding && ( runtimeBinding.isSampledTexture || runtimeBinding.isSampler ) );

}

function classifyDepthTexture( entry, runtimeBinding, descriptor, ctx ) {

	const source = entry.source || {};
	const depthBinding = {
		binding: runtimeBinding,
		artifact: ctx.artifact,
		bindingName: descriptor.name || '',
		lightIndex: Number.isInteger( source.lightIndex ) ? source.lightIndex : 0,
		lightUuid: typeof source.lightUuid === 'string' ? source.lightUuid : null,
		vsm: source.vsm === true,
		// Non-light depth textures (e.g. RenderTarget.depthTexture sampled via
		// `material.colorNode = texture(depthTexture)`) have no owning
		// AnalyticLightNode. The plan source signals this with
		// `lightIndex: -1, fromMaterialGraph: true`. The rebinder resolves the
		// live DepthTexture by walking the owning material's node graph
		// instead of `light.shadow.map`.
		fromMaterialGraph: source.fromMaterialGraph === true,
		textureUuid: typeof source.textureUuid === 'string' ? source.textureUuid : null,
		material: ctx.material,
	};
	if ( typeof ctx.recordShadowBindingDiagnostic === 'function' ) {

		ctx.recordShadowBindingDiagnostic( {
			phase: 'hydrateDepth',
			bindingName: depthBinding.bindingName,
			lightIndex: depthBinding.lightIndex,
			lightUuid: depthBinding.lightUuid,
			fromMaterialGraph: depthBinding.fromMaterialGraph,
			vsm: depthBinding.vsm,
			textureUuid: depthBinding.textureUuid,
			artifactName: ctx.artifact && ctx.artifact.name || ctx.material && ctx.material.name || null,
			bindingKind: descriptor.kind || null,
			textureType: descriptor.textureType || null,
		} );

	}
	if ( depthBinding.fromMaterialGraph ) ctx.materialDepthBindings.push( depthBinding );
	else ctx.shadowDepthBindings.push( depthBinding );

}

function classifyArtifactTexture( entry, runtimeBinding, descriptor, ctx ) {

	if ( ! isSampledTextureOrSampler( runtimeBinding ) ) return;
	const planGroup = ( ctx.artifact.uniformPlan || [] ).find( ( g ) => g.name === entry.group ) || {};
	const planTex = ( planGroup.textures || [] ).find( ( t ) => t.name === entry.binding ) || {};
	ctx.artifactTextureBindings.push( {
		binding: runtimeBinding,
		artifact: ctx.artifact,
		groupName: entry.group || '',
		bindingName: descriptor.name || '',
		source: entry.source,
		textureType: planTex.textureType || '2d',
		material: ctx.material,
	} );

}

function classifyMaterialTexture( entry, runtimeBinding, descriptor, ctx ) {

	if ( ! isSampledTextureOrSampler( runtimeBinding ) ) return;
	ctx.materialTextureBindings.push( {
		binding: runtimeBinding,
		artifact: ctx.artifact,
		groupName: entry.group || '',
		bindingName: descriptor.name || '',
		source: entry.source,
		material: ctx.material,
	} );

}

function classifyReflectorTexture( entry, runtimeBinding, descriptor, ctx ) {

	if ( ! isSampledTextureOrSampler( runtimeBinding ) ) return;
	const baseNode = ctx.findReflectorBaseNodeInMaterial( ctx.material, entry.source && entry.source.reflectorIndex );
	if ( ! baseNode ) return;
	ctx.reflectorTextureBindings.push( {
		binding: runtimeBinding,
		baseNode,
		source: entry.source || {},
	} );

}

function classifyViewportTexture( entry, runtimeBinding, descriptor, ctx ) {

	if ( descriptor.kind !== 'sampled-texture' || ! runtimeBinding.isSampledTexture ) return;
	const source = entry.source || {};
	const skipZeroThicknessTransmission = ctx.shouldSkipViewportCopyForZeroThicknessTransmission( ctx.artifact );
	ctx.viewportTextureBindings.push( {
		binding: runtimeBinding,
		fallbackTexture: runtimeBinding.texture,
		forceViewportFallback: skipZeroThicknessTransmission,
		generateMipmaps: source.generateMipmaps !== false,
		isDepth: source.isDepth === true || ctx.shaderDeclaresDepthTexture( ctx.artifact, descriptor.name || '' ),
		material: ctx.material,
		shared: source.shared === true,
		skipZeroThicknessTransmission,
	} );

}

const CLASSIFIERS = Object.freeze( {
	'depth.texture': classifyDepthTexture,
	'artifact.texture': classifyArtifactTexture,
	'reflector.texture': classifyReflectorTexture,
	'viewport.texture': classifyViewportTexture,
} );

/**
 * Build a `Map<"groupName::bindingName", entry>` from `artifact.dynamicBindings`
 * so the hydrator can look up the dynamic descriptor for a runtime binding in
 * O(1) instead of walking `uniformPlan` per binding.
 *
 * Only entries whose target is a sampled-texture or sampler land in the map;
 * uniform-slot dynamic bindings (camera.*, frame.*, light.*) are handled by
 * the codegen-emitted `update()` function and don't go through this path.
 *
 * `emit-manifest.js` inlines `dynamicBindings` into virtual modules at build
 * time, so production artifacts always carry it. As a defensive fallback for
 * dynamically-constructed test artifacts and any other consumer that bypasses
 * the codegen path, derive the section on the fly from `uniformPlan` via the
 * contract helper — same single source of truth, just lazily computed.
 *
 * @param {Object} artifact
 * @returns {Map<string, Object>}
 */
export function indexDynamicTextureBindings( artifact ) {

	const out = new Map();
	if ( ! artifact ) return out;
	const list = Array.isArray( artifact.dynamicBindings )
		? artifact.dynamicBindings
		: collectArtifactDynamicBindings( artifact );
	for ( const entry of list ) {

		if ( entry.target !== 'sampled-texture' && entry.target !== 'sampler' ) continue;
		out.set( `${ entry.group || '' }::${ entry.binding || '' }`, entry );

	}
	return out;

}

/**
 * Dispatch a single dynamic-texture binding entry to its per-kind classifier.
 * The classifier mutates `ctx`'s typed-bag arrays
 * (`shadowDepthBindings`, `materialDepthBindings`, `artifactTextureBindings`,
 * `materialTextureBindings`, `viewportTextureBindings`,
 * `reflectorTextureBindings`).
 *
 * @param {Object} entry         — one element of `artifact.dynamicBindings`
 * @param {Object} runtimeBinding — the live three.js binding (texture, sampler, …)
 * @param {Object} descriptor    — the bindGroupLayout descriptor
 * @param {Object} ctx           — typed-bag arrays + helper deps
 */
export function classifyDynamicTextureBinding( entry, runtimeBinding, descriptor, ctx ) {

	if ( ! entry || ! entry.kind ) return;
	const handler = CLASSIFIERS[ entry.kind ]
		|| ( entry.kind.startsWith( 'material.' ) && entry.target === 'sampled-texture' ? classifyMaterialTexture : null );
	if ( handler ) handler( entry, runtimeBinding, descriptor, ctx );

}
