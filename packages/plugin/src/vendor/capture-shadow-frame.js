let nextCaptureFrameId = - 1;

/** Run one synchronous shadow capture draw outside the already-painted frame. */
export function withFreshShadowCaptureFrame( renderer, render ) {

	const frame = renderer?._nodes?.nodeFrame;
	if ( ! frame || ! Number.isFinite( frame.frameId ) ) return render();
	const original = frame.frameId;
	// ShadowNode ignores needsUpdate after it has drawn for the current frame.
	// A private negative stamp bypasses that guard without advancing the host's
	// frame clock. No await is allowed between installing and restoring it.
	frame.frameId = nextCaptureFrameId --;
	try {

		return render();

	} finally {

		frame.frameId = original;

	}

}
