import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

const EXAMPLES = [
  { name: 'getting-started', filter: 'examples-getting-started' },
  { name: 'ocean', filter: 'examples-ocean' },
  { name: 'pbr-shadows', filter: 'examples-pbr-shadows' },
  { name: 'shadow-debug', filter: 'examples-shadow-debug' },
  { name: 'postprocessing-debug', filter: 'examples-postprocessing-debug' },
  { name: 'pmrem-debug', filter: 'examples-pmrem-debug' },
  { name: 'mrt-debug', filter: 'examples-mrt-debug' },
  { name: 'background', filter: 'examples-background' },
  {
    name: 'compute-debug',
    filter: 'examples-compute-debug',
    paths: '/dispatch2d.html,/index.html,/instanced.html,/particles.html,/pipeline.html,/reduce.html,/texture.html,/uniform.html'
  }
];

const PORT = 8999;
const RECAPTURE_SCRIPT = resolve(REPO, 'packages/plugin/src/cli/recapture.js');

async function runDevAndRecapture(example) {
  console.log(`\n======================================================`);
  console.log(`Starting recapture for example: ${example.name}`);
  console.log(`======================================================`);

  return new Promise((resolvePromise, reject) => {
    // Spawn Vite dev server on a strict port via pnpm
    const devServer = spawn('pnpm', ['--filter', example.filter, 'dev', '--port', String(PORT), '--strictPort'], {
      cwd: REPO,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let isReady = false;
    let recaptureProc = null;

    const killServer = () => {
      if (devServer) {
        devServer.kill('SIGTERM');
      }
    };

    devServer.stdout.on('data', (data) => {
      const output = data.toString();
      process.stdout.write(`[dev-server] ${output}`);

      if ((output.includes('Local:') || output.includes('ready in')) && !isReady) {
        isReady = true;
        console.log(`[recapture-all] Dev server is ready. Launching recapture CLI...`);
        
        // Spawn recapture CLI
        const args = [RECAPTURE_SCRIPT, '--url', `http://localhost:${PORT}`];
        if (example.paths) {
          args.push('--paths', example.paths);
        }
        recaptureProc = spawn('node', args, {
          cwd: REPO,
          stdio: 'inherit',
        });

        recaptureProc.on('close', (code) => {
          killServer();
          if (code === 0) {
            console.log(`[recapture-all] Recapture completed successfully for ${example.name}`);
            resolvePromise();
          } else {
            console.error(`[recapture-all] Recapture failed with code ${code} for ${example.name}`);
            reject(new Error(`Recapture failed for ${example.name}`));
          }
        });
      }
    });

    devServer.stderr.on('data', (data) => {
      process.stderr.write(`[dev-server-err] ${data.toString()}`);
    });

    devServer.on('error', (err) => {
      console.error(`[dev-server-err] Failed to start dev server:`, err);
      reject(err);
    });

    devServer.on('close', (code) => {
      console.log(`[dev-server] Closed with code ${code}`);
      if (!isReady) {
        reject(new Error(`Dev server exited before ready`));
      }
    });
  });
}

async function main() {
  try {
    for (const example of EXAMPLES) {
      await runDevAndRecapture(example);
    }
    console.log('\nAll examples recaptured successfully! Running verification script...');
    execSync('pnpm verify', { cwd: REPO, stdio: 'inherit' });
    console.log('Verification completed successfully!');
  } catch (err) {
    console.error('Error during recapture-all run:', err);
    process.exit(1);
  }
}

main();
