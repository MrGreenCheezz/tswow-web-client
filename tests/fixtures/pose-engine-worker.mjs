// A pose worker on a Node worker thread: the same loop the browser's PoseEngine.worker.ts runs.
import { workerData } from 'node:worker_threads';

// Source hooks are per thread; registering them here maps dist/code imports to the TS sources.
await import('../../tools/register-test-sources.mjs');
const { runPoseWorker } = await import('../../dist/code/browser/PoseEngineCore.js');
runPoseWorker(workerData.sab, workerData.index);
