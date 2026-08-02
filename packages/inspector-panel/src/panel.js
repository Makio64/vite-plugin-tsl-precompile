/**
 * Precompile inspector panel.
 *
 * Extends three.js's Inspector `Extension` base (a `Tab` with an
 * `isExtension` flag). Renders a live list of captured artifacts and a
 * detail pane with WGSL + uniformPlan + unsupported-kind diagnostics.
 *
 * Lifecycle (inherited from Tab):
 *   - `init(inspector)` called once when the tab is added.
 *   - `update(inspector)` called every frame. We diff against the last
 *     render state and only rebuild rows that changed.
 *
 * @module PrecompilePanel
 */

import { Extension } from 'three/addons/inspector/Extension.js';
import { listAllCaptures, summarise } from './data-source.js';
import { captureRenderKey } from './render-key.js';

const ICON_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 3h12v2H2V3zm0 4h8v2H2V7zm0 4h12v2H2v-2z"/></svg>';

export class PrecompilePanel extends Extension {

	constructor() {

		super( 'Precompile', { builtin: false, icon: ICON_SVG, allowDetach: true } );
		this.isExtension = true;

		// Cached DOM references populated in _buildLayout().
		this._summary = null;
		this._list = null;
		this._detail = null;

		// Render-diff state.
		this._lastRender = { total: -1, ids: '' };
		this._selectedId = null;

	}

	init( _inspector ) {

		this._buildLayout();
		this._render();

	}

	update( _inspector ) {

		this._render();

	}

	_buildLayout() {

		const host = this.content;
		host.className = ( host.className || 'profiler-content' ) + ' tslp-root';

		const style = document.createElement( 'style' );
		style.textContent = STYLE;
		host.appendChild( style );

		const wrap = document.createElement( 'div' );
		wrap.className = 'tslp-wrap';

		this._summary = document.createElement( 'div' );
		this._summary.className = 'tslp-summary';
		wrap.appendChild( this._summary );

		const body = document.createElement( 'div' );
		body.className = 'tslp-body';
		wrap.appendChild( body );

		this._list = document.createElement( 'div' );
		this._list.className = 'tslp-list';
		body.appendChild( this._list );

		this._detail = document.createElement( 'div' );
		this._detail.className = 'tslp-detail';
		this._detail.innerHTML = '<div class="tslp-empty">Select a capture to see its WGSL + uniformPlan.</div>';
		body.appendChild( this._detail );

		host.appendChild( wrap );

	}

	_render() {

		const captures = listAllCaptures();
		const ids = captures.map( captureRenderKey ).join( '|' );

		// Fast path: nothing changed, skip DOM work.
		if ( this._lastRender.total === captures.length && this._lastRender.ids === ids ) return;

		this._lastRender = { total: captures.length, ids };

		this._renderSummary( captures );
		this._renderList( captures );
		this._renderDetail( captures );

	}

	_renderSummary( captures ) {

		const s = summarise( captures );
		const shapeCounts = Object.entries( s.byShape )
			.sort( ( a, b ) => a[ 0 ].localeCompare( b[ 0 ] ) )
			.map( ( [ shape, n ] ) => `<span class="tslp-pill">${ shape } · ${ n }</span>` )
			.join( '' );
		const warn = s.unknowns > 0
			? `<span class="tslp-pill tslp-pill-err">${ s.unknowns } unknown</span>`
			: '';
		const block = s.blocked > 0
			? `<span class="tslp-pill tslp-pill-warn">${ s.blocked } blocked</span>`
			: '';
		this._summary.innerHTML = `
			<div class="tslp-summary-totals">
				<span class="tslp-big">${ s.total }</span>
				<span class="tslp-small">captures</span>
				<span class="tslp-big">${ formatBytes( s.wgslBytes ) }</span>
				<span class="tslp-small">WGSL</span>
			</div>
			<div class="tslp-summary-pills">${ shapeCounts }${ warn }${ block }</div>
		`;

	}

	_renderList( captures ) {

		if ( captures.length === 0 ) {

			this._list.innerHTML = `
				<div class="tslp-empty">
					<div>No captures yet.</div>
					<div class="tslp-small">Mark materials with <code>material.precompile(name)</code> and call <code>precompileAuxiliary(renderer, scene, camera, { devEndpoint })</code> to populate this list.</div>
				</div>
			`;
			return;

		}

		const rows = captures.map( ( c ) => {

			const selected = c.id === this._selectedId ? ' tslp-row-selected' : '';
			const unsupportedKinds = Array.isArray( c.unsupportedKinds ) ? c.unsupportedKinds : [];
			const unknownCount = unsupportedKinds.filter( ( u ) => u && u.severity === 'unknown' ).length;
			const blockedCount = unsupportedKinds.filter( ( u ) => u && u.severity === 'blocked' ).length;
			const severity = unknownCount > 0 ? ' tslp-row-err'
				: blockedCount > 0 ? ' tslp-row-warn'
					: '';
			const hash = ( c.hash || c.configHash || '—' ).slice( 0, 12 );
			const bytes = c.bytesLabel || formatBytes( c.vertexBytes + c.fragmentBytes + c.computeBytes );
			return `<div class="tslp-row${ selected }${ severity }" data-id="${ escape( c.id ) }" data-unknown-count="${ unknownCount }" data-blocked-count="${ blockedCount }">
				<span class="tslp-cell tslp-cell-shape">${ escape( c.shape ) }</span>
				<span class="tslp-cell tslp-cell-name">${ escape( c.name ) }</span>
				<span class="tslp-cell tslp-cell-hash">${ escape( hash ) }</span>
				<span class="tslp-cell tslp-cell-bytes">${ bytes }</span>
			</div>`;

		} ).join( '' );

		this._list.innerHTML = `
			<div class="tslp-row tslp-row-header">
				<span class="tslp-cell tslp-cell-shape">shape</span>
				<span class="tslp-cell tslp-cell-name">name</span>
				<span class="tslp-cell tslp-cell-hash">hash</span>
				<span class="tslp-cell tslp-cell-bytes">size</span>
			</div>
			${ rows }
		`;

		// Row click → select + re-render detail.
		this._list.querySelectorAll( '.tslp-row[data-id]' ).forEach( ( el ) => {

			el.addEventListener( 'click', () => {

				this._selectedId = el.getAttribute( 'data-id' );
				this._lastRender = { total: -1, ids: '' };   // force redraw on next tick
				this._renderList( listAllCaptures() );
				this._renderDetail( listAllCaptures() );

			} );

		} );

	}

	_renderDetail( captures ) {

		if ( ! this._selectedId ) {

			this._detail.innerHTML = '<div class="tslp-empty">Select a capture to see its WGSL + uniformPlan.</div>';
			return;

		}

		const entry = captures.find( ( c ) => c.id === this._selectedId );
		if ( ! entry ) {

			this._detail.innerHTML = '<div class="tslp-empty">This capture is no longer available (may have been cleared).</div>';
			return;

		}

		const { raw } = entry;
		const wgslVertex = raw && raw.vertexShader ? raw.vertexShader : '';
		const wgslFragment = raw && raw.fragmentShader ? raw.fragmentShader : '';
		const uniformPlan = raw && Array.isArray( raw.uniformPlan ) ? raw.uniformPlan : [];

		this._detail.innerHTML = `
			<div class="tslp-detail-head">
				<div class="tslp-detail-title">${ escape( entry.name ) }</div>
				<div class="tslp-detail-meta">
					<span>shape: <b>${ escape( entry.shape ) }</b></span>
					<span>hash: <code>${ escape( ( entry.hash || entry.configHash || '—' ).slice( 0, 16 ) ) }</code></span>
					<span>WGSL: ${ entry.bytesLabel || formatBytes( entry.vertexBytes + entry.fragmentBytes + entry.computeBytes ) }</span>
				</div>
			</div>
			${ renderUnsupportedKinds( entry.unsupportedKinds ) }
			${ renderUniformPlan( uniformPlan ) }
			${ renderWgsl( 'Vertex WGSL', wgslVertex ) }
			${ renderWgsl( 'Fragment WGSL', wgslFragment ) }
		`;

	}

}

function renderUnsupportedKinds( kinds ) {

	if ( ! kinds || kinds.length === 0 ) return '';
	const rows = kinds.map( ( u ) => `<tr class="tslp-u-${ escape( u.severity || '' ) }">
		<td>${ escape( u.severity || '' ) }</td>
		<td><code>${ escape( u.kind || '' ) }</code></td>
		<td>${ escape( String( u.reason || '' ) ) }</td>
	</tr>` ).join( '' );
	return `<details open class="tslp-section">
		<summary>${ kinds.length } unsupported-kind${ kinds.length === 1 ? '' : 's' }</summary>
		<table class="tslp-table"><thead><tr><th>severity</th><th>kind</th><th>reason</th></tr></thead><tbody>${ rows }</tbody></table>
	</details>`;

}

function renderUniformPlan( plan ) {

	if ( ! plan || plan.length === 0 ) return '';
	const rows = [];
	for ( const group of plan ) {

		rows.push( `<tr class="tslp-group-head"><td colspan="5">group <code>${ escape( group.name || '' ) }</code> · byteLength ${ group.byteLength | 0 }</td></tr>` );
		for ( const slot of ( group.slots || [] ) ) {

			const src = slot.source || {};
			rows.push( `<tr>
				<td><code>${ escape( slot.name || '' ) }</code></td>
				<td>${ slot.offset | 0 }</td>
				<td>${ slot.size | 0 }</td>
				<td><code>${ escape( slot.dtype || '' ) }</code></td>
				<td><code>${ escape( src.kind || '' ) }</code>${ src.property ? ` <span class="tslp-muted">${ escape( src.property ) }</span>` : '' }</td>
			</tr>` );

		}

	}
	return `<details class="tslp-section">
		<summary>uniformPlan (${ plan.reduce( ( n, g ) => n + ( g.slots ? g.slots.length : 0 ), 0 ) } slots)</summary>
		<table class="tslp-table"><thead><tr><th>name</th><th>off</th><th>size</th><th>dtype</th><th>kind</th></tr></thead><tbody>${ rows.join( '' ) }</tbody></table>
	</details>`;

}

function renderWgsl( title, src ) {

	if ( ! src ) return '';
	return `<details class="tslp-section">
		<summary>${ escape( title ) } (${ formatBytes( src.length ) })</summary>
		<pre class="tslp-wgsl">${ escape( src ) }</pre>
	</details>`;

}

function formatBytes( n ) {

	if ( n < 1024 ) return n + ' B';
	if ( n < 1024 * 1024 ) return ( n / 1024 ).toFixed( 1 ) + ' KB';
	return ( n / 1024 / 1024 ).toFixed( 2 ) + ' MB';

}

function escape( s ) {

	return String( s == null ? '' : s )
		.replace( /&/g, '&amp;' )
		.replace( /</g, '&lt;' )
		.replace( />/g, '&gt;' )
		.replace( /"/g, '&quot;' );

}

const STYLE = `
.tslp-wrap { display: flex; flex-direction: column; height: 100%; font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace; color: #d7dae0; }
.tslp-summary { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
.tslp-summary-totals { display: flex; gap: 6px; align-items: baseline; }
.tslp-big { font-size: 18px; font-weight: 600; color: #a6e22e; }
.tslp-small { font-size: 11px; opacity: 0.6; }
.tslp-summary-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.tslp-pill { padding: 2px 8px; background: rgba(166,226,46,0.12); color: #a6e22e; border-radius: 10px; }
.tslp-pill-warn { background: rgba(255,193,7,0.14); color: #ffc107; }
.tslp-pill-err { background: rgba(244,71,71,0.14); color: #f44747; }
.tslp-body { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 1px; background: rgba(255,255,255,0.06); overflow: hidden; }
.tslp-list { overflow: auto; background: #16181d; }
.tslp-detail { overflow: auto; background: #16181d; padding: 10px 12px; }
.tslp-row { display: grid; grid-template-columns: 90px minmax(0, 1fr) 110px 72px; gap: 8px; padding: 6px 10px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.04); }
.tslp-row:hover:not(.tslp-row-header) { background: rgba(255,255,255,0.04); }
.tslp-row-header { cursor: default; font-weight: 600; opacity: 0.7; background: rgba(0,0,0,0.2); position: sticky; top: 0; }
.tslp-row-selected { background: rgba(166,226,46,0.08) !important; }
.tslp-row-err { color: #f44747; }
.tslp-row-warn { color: #ffc107; }
.tslp-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tslp-cell-hash, .tslp-cell-bytes { text-align: right; opacity: 0.8; }
.tslp-empty { padding: 20px; opacity: 0.6; display: flex; flex-direction: column; gap: 8px; }
.tslp-detail-head { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.08); }
.tslp-detail-title { font-size: 14px; font-weight: 600; }
.tslp-detail-meta { display: flex; gap: 14px; opacity: 0.7; flex-wrap: wrap; }
.tslp-section { margin: 6px 0; }
.tslp-section > summary { cursor: pointer; padding: 4px 0; opacity: 0.85; }
.tslp-section > summary:hover { opacity: 1; }
.tslp-table { width: 100%; border-collapse: collapse; margin: 4px 0 8px 0; font-size: 11px; }
.tslp-table th { text-align: left; padding: 3px 6px; border-bottom: 1px solid rgba(255,255,255,0.1); opacity: 0.7; }
.tslp-table td { padding: 3px 6px; border-bottom: 1px dotted rgba(255,255,255,0.06); vertical-align: top; }
.tslp-group-head { background: rgba(255,255,255,0.03); }
.tslp-u-unknown td { color: #f44747; }
.tslp-u-blocked td { color: #ffc107; }
.tslp-wgsl { white-space: pre; overflow: auto; padding: 8px; background: #0d0f13; border-radius: 3px; max-height: 260px; margin: 0; color: #c9d1d9; font-size: 11px; }
.tslp-muted { opacity: 0.5; }
`;
