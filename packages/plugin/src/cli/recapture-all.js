import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecapturePlan } from './recapture-plan.js';
import {
	acquireRecaptureRepositoryLock,
	installRecaptureSignalHandlers,
	RECAPTURE_ALL_HELP,
	assertRecaptureAuxiliaryObligations,
	assertRecaptureArtifactInventoryCoverage,
	readRecaptureArtifactInventories,
	recaptureDevServerArgs,
	recaptureVerificationArgs,
	selectRecaptureExamples,
	stageFreshArtifactDirectories,
	terminateRecaptureChild,
	waitForRecaptureServerReady,
} from './recapture-all-support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

const ALL_EXAMPLES = createRecapturePlan(REPO);

const RECAPTURE_SCRIPT = resolve(REPO, 'packages/plugin/src/cli/recapture.js');
const PRODUCTION_PREVIEW_SCRIPT = resolve(REPO, 'packages/examples/preview-smoke/run-production-routes.mjs');
const VERIFY_SCRIPT = resolve(REPO, 'packages/plugin/src/cli/verify.js');
const USE_PROCESS_GROUPS = process.platform !== 'win32';

function spawnRecaptureChild(command, args, options) {

	const child = spawn(command, args, {
		...options,
		detached: USE_PROCESS_GROUPS,
	});
	child.__tslpProcessGroup = USE_PROCESS_GROUPS;
	return child;

}

function abortError(signal) {

	return signal && signal.reason instanceof Error
		? signal.reason
		: new Error('Recapture interrupted.');

}

async function runDevAndRecapture(example, signal, port) {
  console.log(`\n======================================================`);
  console.log(`Starting recapture for example: ${example.name} (${example.paths.length} routes)`);
  console.log(`======================================================`);

  return new Promise((resolvePromise, rejectPromise) => {
    // Spawn Vite dev server on a strict port via pnpm
    const devArgs = recaptureDevServerArgs(example, port);
    const devServer = spawnRecaptureChild('pnpm', devArgs, {
      cwd: REPO,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let isReady = false;
    let recaptureProc = null;
    let devClosed = false;
    let recaptureClosed = true;
    let outcomeSet = false;
    let outcomeError = null;
    let settled = false;
    const readinessController = new AbortController();

    const killChild = (child) => terminateRecaptureChild(child);

    const settleIfClosed = () => {
      if (!outcomeSet || !devClosed || !recaptureClosed || settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (outcomeError) rejectPromise(outcomeError);
      else resolvePromise();
    };

    const finish = (error = null) => {
      if (outcomeSet) return;
      outcomeSet = true;
      outcomeError = error;
      readinessController.abort(error || new Error('Recapture readiness is no longer needed.'));
      killChild(recaptureProc);
      killChild(devServer);
      settleIfClosed();
    };

    const onAbort = () => finish(abortError(signal));
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    devServer.stdout.on('data', (data) => {
      const output = data.toString();
      process.stdout.write(`[dev-server] ${output}`);
    });

    devServer.stderr.on('data', (data) => {
      process.stderr.write(`[dev-server-err] ${data.toString()}`);
    });

    devServer.on('error', (err) => {
      console.error(`[dev-server-err] Failed to start dev server:`, err);
      finish(err);
    });

    devServer.on('close', (code) => {
      devClosed = true;
      console.log(`[dev-server] Closed with code ${code}`);
      if (!outcomeSet && !isReady) {
        finish(new Error(`Dev server exited before ready`));
      } else if (!outcomeSet) {
        finish(new Error(`Dev server exited before recapture completed`));
      }
      settleIfClosed();
    });

    const readinessPath = example.paths[ 0 ] || '/';
    const readinessUrl = `http://127.0.0.1:${ port }${ readinessPath }`;
    void waitForRecaptureServerReady(readinessUrl, {
      signal: readinessController.signal,
      timeoutMs: 30_000,
    }).then(() => {
      if (outcomeSet) return;
      isReady = true;
      console.log(`[recapture-all] Dev server is ready. Launching recapture CLI...`);
      const args = [
        RECAPTURE_SCRIPT,
        '--url',
        `http://127.0.0.1:${ port }`,
        '--paths',
        example.paths.join(','),
      ];
      if ( example.backends.length > 0 ) args.push( '--backends', example.backends.join( ',' ) );
      if ( example.timeout ) args.push( '--timeout', String( example.timeout ) );
      recaptureProc = spawnRecaptureChild('node', args, {
        cwd: REPO,
        stdio: 'inherit',
      });
      recaptureClosed = false;

      recaptureProc.on('close', (code) => {
        recaptureClosed = true;
        if (!outcomeSet && code === 0) {
          console.log(`[recapture-all] Recapture completed successfully for ${example.name}`);
          finish();
        } else if (!outcomeSet) {
          console.error(`[recapture-all] Recapture failed with code ${code} for ${example.name}`);
          finish(new Error(`Recapture failed for ${example.name}`));
        }
        settleIfClosed();
      });
      recaptureProc.on('error', (error) => finish(error));
    }).catch((error) => finish(error));
  });
}

function runVerificationForExample(signal, example) {

	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawnRecaptureChild(process.execPath, [
			VERIFY_SCRIPT,
			...recaptureVerificationArgs( example ),
		], {
			cwd: REPO,
			stdio: 'inherit',
		});
		let settled = false;
		let requestedError = null;
		const settle = (error = null) => {

			if (settled) return;
			settled = true;
			signal?.removeEventListener('abort', onAbort);
			if (error) rejectPromise(error);
			else resolvePromise();

		};
		const onAbort = () => {

			requestedError = abortError(signal);
			terminateRecaptureChild(child);

		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener('abort', onAbort, { once: true });
		child.on('error', (error) => settle(requestedError || error));
		child.on('close', (code) => {

			if (requestedError) settle(requestedError);
			else if (code === 0) settle();
			else settle(new Error(`Verification failed with code ${code}`));

		});
	});

}

async function runVerification(signal, examples) {

	for ( const example of examples ) {

		console.log(`[recapture-all] Verifying artifact integrity and source coverage for ${example.name}...`);
		await runVerificationForExample(signal, example);

	}

}

function runProductionBuild(signal, example) {

	return new Promise((resolvePromise, rejectPromise) => {
		const args = [ '--filter', example.filter, 'build' ];
		if ( example.mode ) args.push( '--mode', example.mode );
		const child = spawnRecaptureChild('pnpm', args, {
			cwd: REPO,
			stdio: 'inherit',
		});
		let settled = false;
		let requestedError = null;
		const settle = (error = null) => {

			if (settled) return;
			settled = true;
			signal?.removeEventListener('abort', onAbort);
			if (error) rejectPromise(error);
			else resolvePromise();

		};
		const onAbort = () => {

			requestedError = abortError(signal);
			terminateRecaptureChild(child);

		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener('abort', onAbort, { once: true });
		child.on('error', (error) => settle(requestedError || error));
		child.on('close', (code) => {

			if (requestedError) settle(requestedError);
			else if (code === 0) settle();
			else settle(new Error(`Production build failed with code ${code} for ${example.name}`));

		});
	});

}

function runProductionPreview(signal, example, port) {

	if ( ! Array.isArray( example.productionPreviewRoutes ) || example.productionPreviewRoutes.length === 0 ) {

		return Promise.resolve();

	}
	return new Promise((resolvePromise, rejectPromise) => {
		const previewServer = spawnRecaptureChild('pnpm', [
			'--filter', example.filter,
			'preview',
			'--host', '127.0.0.1',
			'--port', String(port),
			'--strictPort',
		], {
			cwd: REPO,
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		});
		let isReady = false;
		let previewClosed = false;
		let probeClosed = true;
		let previewProbe = null;
		let outcomeSet = false;
		let outcomeError = null;
		let settled = false;
		const readinessController = new AbortController();

		const settleIfClosed = () => {

			if ( ! outcomeSet || ! previewClosed || ! probeClosed || settled ) return;
			settled = true;
			signal?.removeEventListener('abort', onAbort);
			if ( outcomeError ) rejectPromise(outcomeError);
			else resolvePromise();

		};
		const finish = (error = null) => {

			if ( outcomeSet ) return;
			outcomeSet = true;
			outcomeError = error;
			readinessController.abort(error || new Error('Production preview readiness is no longer needed.'));
			terminateRecaptureChild(previewProbe);
			terminateRecaptureChild(previewServer);
			settleIfClosed();

		};
		const onAbort = () => finish(abortError(signal));
		if ( signal?.aborted ) onAbort();
		else signal?.addEventListener('abort', onAbort, { once: true });

		previewServer.stdout.on('data', (data) => {

			process.stdout.write(`[preview-server] ${data.toString()}`);

		});
		previewServer.stderr.on('data', (data) => {

			process.stderr.write(`[preview-server-err] ${data.toString()}`);

		});
		previewServer.on('error', (error) => finish(error));
		previewServer.on('close', (code) => {

			previewClosed = true;
			console.log(`[preview-server] Closed with code ${code}`);
			if ( ! outcomeSet && ! isReady ) finish(new Error(`Production preview server exited before ready for ${example.name}`));
			else if ( ! outcomeSet ) finish(new Error(`Production preview server exited before smoke completion for ${example.name}`));
			settleIfClosed();

		});

		const readinessPath = example.productionPreviewRoutes[ 0 ].path;
		void waitForRecaptureServerReady(`http://127.0.0.1:${port}${readinessPath}`, {
			signal: readinessController.signal,
			timeoutMs: 30_000,
		}).then(() => {

			if ( outcomeSet ) return;
			isReady = true;
			console.log(`[recapture-all] Production preview is ready for ${example.name}. Launching compiler-free route smoke...`);
			previewProbe = spawnRecaptureChild(process.execPath, [
				PRODUCTION_PREVIEW_SCRIPT,
				'--example', example.name,
				'--base-url', `http://127.0.0.1:${port}/`,
			], {
				cwd: REPO,
				stdio: 'inherit',
			});
			probeClosed = false;
			previewProbe.on('error', (error) => finish(error));
			previewProbe.on('close', (code) => {

				probeClosed = true;
				if ( ! outcomeSet && code === 0 ) {

					console.log(`[recapture-all] Compiler-free production preview passed for ${example.name}`);
					finish();

				} else if ( ! outcomeSet ) {

					finish(new Error(`Production preview smoke failed with code ${code} for ${example.name}`));

				}
				settleIfClosed();

			});

		}).catch((error) => finish(error));
	});

}

async function main() {
  let transaction = null;
  let repositoryLock = null;
  const abortController = new AbortController();
  const signals = installRecaptureSignalHandlers(process, abortController);
  try {
    const selection = selectRecaptureExamples(ALL_EXAMPLES, process.argv.slice(2));
    if (selection.help) {
      console.log(RECAPTURE_ALL_HELP);
      return;
    }
    repositoryLock = acquireRecaptureRepositoryLock(REPO);
    transaction = stageFreshArtifactDirectories(REPO, selection.examples);
    abortController.signal.throwIfAborted();
    for (const example of selection.examples) {
      await runDevAndRecapture(example, abortController.signal, selection.port);
      abortController.signal.throwIfAborted();
    }
    const currentInventories = readRecaptureArtifactInventories(REPO, selection.examples);
    assertRecaptureAuxiliaryObligations(currentInventories, selection.examples);
    const inventoryReport = assertRecaptureArtifactInventoryCoverage(
      transaction.previousInventories,
      currentInventories,
      { allowPrune: selection.allowPrune },
    );
    for ( const entry of inventoryReport ) {
      if ( entry.added.length > 0 ) console.log(`[recapture-all] ${entry.name}: added ${entry.added.join(', ')}`);
      for ( const replacement of entry.replaced ) console.log(
        `[recapture-all] ${entry.name}: refreshed ${replacement.semantic} (${replacement.previous} -> ${replacement.current})`,
      );
      if ( entry.missing.length > 0 ) console.warn(`[recapture-all] ${entry.name}: intentionally pruned ${entry.missing.join(', ')}`);
    }
    console.log('\nAll examples recaptured successfully! Running integrity and source-coverage verification...');
    await runVerification(abortController.signal, selection.examples);
    console.log('Verification completed successfully!');
    if ( selection.build ) {
      for ( const example of selection.examples ) {
        console.log(`[recapture-all] Running production build for ${example.name}...`);
        await runProductionBuild(abortController.signal, example);
        if ( example.productionPreviewRoutes.length > 0 ) {
          console.log(`[recapture-all] Running compiler-free production preview for ${example.name}...`);
          await runProductionPreview(abortController.signal, example, selection.port);
        }
      }
      console.log('Production build and configured preview gates completed successfully!');
    } else {
      console.warn('[recapture-all] Production build and preview gates skipped by explicit --skip-build; restoring the original artifacts after diagnostics.');
    }
    if ( selection.build ) transaction.commit();
    else transaction.rollback();
  } catch (err) {
    let rollbackError = null;
    if (transaction?.state === 'active') {
      try {
        transaction.rollback();
      } catch (error) {
        rollbackError = error;
      }
    }
    console.error('Error during recapture-all run:', err);
    if (rollbackError) console.error('Artifact rollback also failed:', rollbackError);
    process.exitCode = signals.receivedSignal === 'SIGINT'
      ? 130
      : signals.receivedSignal === 'SIGTERM'
        ? 143
        : signals.receivedSignal === 'SIGHUP'
          ? 129
          : 1;
  } finally {
    try {
      repositoryLock?.release();
    } catch (error) {
      console.error('Recapture repository lock cleanup failed:', error);
      if (!process.exitCode) process.exitCode = 1;
    }
    signals.dispose();
  }
}

main();
