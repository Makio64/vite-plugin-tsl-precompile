/** Own capture payloads and visits until a complete case has been reported. */
export async function withE2ECaseResources( captures, name, run ) {

	const visits = new Set();
	captures.delete( name );
	try {

		return await run( ( visit ) => {

			visits.add( visit );
			return visit;

		} );

	} finally {

		for ( const visit of visits ) {

			try {

				if ( visit.cleanup ) await visit.cleanup();

			} catch {

				// A broken page must not keep the remaining visits or payload alive.

			} finally {

				visit.cleanup = null;
				visit.page = null;
				visit.context = null;
				visit.shot = null;

			}

		}
		captures.delete( name );

	}

}
