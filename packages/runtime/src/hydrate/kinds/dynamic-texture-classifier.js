/**
 * Table-driven dispatch for dynamic-texture binding kinds.
 *
 * Replaces the inline `if (planSource.kind === 'depth.texture') ...
 * if (planSource.kind === 'artifact.texture') ...` chain that used to live in
 * `hydrator.js`. The hydrator indexes texture-shaped descriptors from a
 * public `dynamicBindings` view when present, or directly from
 * `uniformPlan[].textures` for compact/programmatic artifacts, then passes
 * each match through this dispatcher. One of the per-kind classifiers below
 * decides which typed bag the runtime binding lands in.
 *
 * Adding a new texture-shaped dynamic kind = add one entry to `CLASSIFIERS`
 * (or a `*_PREFIX_CLASSIFIERS` rule) plus one handler. The hydrator's outer
 * loop does not change.
 *
 * @module Hydrate.Kinds.DynamicTextureClassifier
 */

import { dynamicBindingDescriptor } from '@tsl-precompile/contract/dynamic-bindings';

function isSampledTextureOrSampler( runtimeBinding ) {

	return !! ( runtimeBinding && ( runtimeBinding.isSampledTexture || runtimeBinding.isSampler ) );

}

function classifyDepthTexture( entry, runtimeBinding, descriptor, ctx ) {

	const source = entry.source || {};
	const depthBinding = {
		binding: runtimeBinding,
		artifact: ctx.artifact,
		bindingName: descriptor.name || '',
		source,
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
		material: ctx.graphMaterial || ctx.material,
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
	let textureType = entry.textureType;
	if ( ! textureType ) {

		const planGroup = ( ctx.artifact.uniformPlan || [] ).find( ( g ) => g.name === entry.group ) || {};
		const planTex = ( planGroup.textures || [] ).find( ( t ) => t.name === entry.binding ) || {};
		textureType = planTex.textureType;

	}
	ctx.artifactTextureBindings.push( {
		binding: runtimeBinding,
		artifact: ctx.artifact,
		groupName: entry.group || '',
		bindingName: descriptor.name || '',
		source: entry.source,
		textureType: textureType || '2d',
		material: ctx.graphMaterial || ctx.material,
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
	const baseNode = ctx.findReflectorBaseNodeInMaterial( ctx.graphMaterial || ctx.material, entry.source && entry.source.reflectorIndex );
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
		sourceIdentity: typeof source.viewportIdentity === 'string' && source.viewportIdentity.length > 0 ? source.viewportIdentity : null,
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
 * Build a `Map<"groupName::bindingName", entry>` so the hydrator can look up
 * the dynamic descriptor for a runtime binding in O(1).
 *
 * Only entries whose target is a sampled-texture or sampler land in the map;
 * uniform-slot dynamic bindings (camera.*, frame.*, light.*) are handled by
 * the codegen-emitted `update()` function and don't go through this path.
 *
 * Persisted artifacts carry the complete validated `dynamicBindings` view.
 * Generated modules omit it from the artifact literal, then reconstruct the
 * public compatibility view from references into `uniformPlan`. Consumers
 * that supply a compact artifact without that view use the narrow fallback
 * below; it skips uniform slots and allocates only entries the hydrator
 * consumes. Per-frame uniform slots remain handled by generated or generic
 * writers.
 *
 * @param {Object} artifact
 * @returns {Map<string, Object>}
 */
export function indexDynamicTextureBindings( artifact ) {

	const out = new Map();
	if ( ! artifact ) return out;
	if ( Array.isArray( artifact.dynamicBindings ) ) {

		for ( const entry of artifact.dynamicBindings ) {

			if ( entry.target !== 'sampled-texture' && entry.target !== 'sampler' ) continue;
			out.set( `${ entry.group || '' }::${ entry.binding || '' }`, entry );

		}
		return out;

	}

	for ( const group of Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [] ) {

		const groupName = group && group.name || '';
		for ( const textureEntry of group && group.textures || [] ) {

			const source = textureEntry && textureEntry.source;
			const descriptor = source && dynamicBindingDescriptor( source.kind );
			if ( ! descriptor || ( descriptor.target !== 'sampled-texture' && descriptor.target !== 'sampler' ) ) continue;
			const binding = textureEntry.name || null;
			const entry = {
				kind: source.kind,
				target: descriptor.target,
				group: groupName,
				binding,
				textureType: textureEntry.textureType || null,
				source,
			};
			out.set( `${ groupName }::${ binding || '' }`, entry );

		}

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
 * @param {Object} entry         — one indexed dynamic texture descriptor
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
