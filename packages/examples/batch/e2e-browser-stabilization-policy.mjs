/**
 * Disclosed, data-only browser stabilization policy for visual evidence.
 *
 * Example-specific temporal/media/canvas choices belong here instead of as
 * branches scattered through the 18k-line runner. Every policy is serialized
 * into the case configuration, so a report explains exactly which authored
 * workload was stabilized and why.
 */

const ALL_MODES = Object.freeze( [ 'stock', 'capture', 'replay' ] );

const POLICIES = new Map( [
	[
		'webgpu_texturegrad.html',
		Object.freeze( {
			id: 'texturegrad-webgpu-canvas-identity-v2',
			reason: 'WebGPU and WebGL initialize concurrently; backend identity selects the authored WebGPU gradient canvas independent of append order.',
			modeScope: ALL_MODES,
			canvasOrder: 'webgpu-backend-first',
		} ),
	],
	[
		'webgpu_compute_sort_bitonic.html',
		Object.freeze( {
			id: 'bitonic-canvas-position-identity-v1',
			reason: 'Two renderers initialize concurrently; horizontal layout, not append order, identifies the authored global and local views.',
			modeScope: ALL_MODES,
			canvasOrder: 'horizontal-right-first',
		} ),
	],
	[
		'webgpu_storage_buffer.html',
		Object.freeze( {
			id: 'storage-buffer-backend-canvas-identity-v1',
			reason: 'Two asynchronous renderer backends share the page; backend markers and authored position provide stable canvas identity.',
			modeScope: ALL_MODES,
			canvasOrder: 'webgpu-backend-first',
		} ),
	],
	[
		'webgpu_texturegather.html',
		Object.freeze( {
			id: 'texture-gather-backend-canvas-identity-v1',
			reason: 'Two asynchronous renderer backends render identical test geometry over deliberately different backgrounds; backend identity must select the same evidence canvas in every pass.',
			modeScope: ALL_MODES,
			canvasOrder: 'webgpu-backend-first',
		} ),
	],
	[
		'webgpu_video_frame.html',
		Object.freeze( {
			id: 'video-decoder-representative-frame-v1',
			reason: 'Decode to one deterministic representative timestamp before comparing stock, capture, and replay.',
			modeScope: ALL_MODES,
			freezeRepresentativeVideoDecoderFrame: true,
		} ),
	],
	[
		'webgpu_video_panorama.html',
		Object.freeze( {
			id: 'video-panorama-representative-frame-v1',
			reason: 'Seek every pass to the same representative media timestamp before comparing frames.',
			modeScope: ALL_MODES,
			freezeRepresentativeMediaFrame: true,
		} ),
	],
	[
		'webgpu_compute_audio.html',
		Object.freeze( {
			id: 'compute-audio-representative-spectrum-v1',
			reason: 'Wait for live analyser energy, then pin one deterministic representative spectrum across all passes.',
			modeScope: ALL_MODES,
			installAudioAnalyserReadiness: true,
		} ),
	],
] );

export function browserStabilizationPolicyForExample( name ) {

	return POLICIES.get( name ) || null;

}

export function canvasOrderForExample( name ) {

	return browserStabilizationPolicyForExample( name )?.canvasOrder || 'reverse-document';

}

export const BROWSER_STABILIZATION_POLICY_IDS = Object.freeze(
	[ ...POLICIES.values() ].map( ( policy ) => policy.id ).sort(),
);
