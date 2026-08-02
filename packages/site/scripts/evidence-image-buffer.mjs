import sharp from 'sharp';

function assertVerifiedImageBytes( sourceBytes ) {

	if ( ! Buffer.isBuffer( sourceBytes ) ) {

		throw new TypeError( 'Verified evidence image bytes must be a Buffer.' );

	}
	return sourceBytes;

}

export async function renderBoundShot( sourceBytes, width, height, { quality = 78 } = {} ) {

	return sharp( assertVerifiedImageBytes( sourceBytes ) )
		.resize( { width, height, fit: 'cover', position: 'attention' } )
		.webp( { quality } )
		.toBuffer();

}

export async function probeThumbHealth( sourceBytes ) {

	const bytes = assertVerifiedImageBytes( sourceBytes );
	try {

		if ( bytes.length < 2048 ) return 'blank';
		const stats = await sharp( bytes ).stats();
		const maxStdev = Math.max( ...stats.channels.slice( 0, 3 ).map( ( channel ) => channel.stdev ) );
		return maxStdev < 1 ? 'blank' : 'ok';

	} catch {

		return 'blank';

	}

}
