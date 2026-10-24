// Development and tests only: starts a worker thread whose entry point is
// TypeScript (server/src/*Worker.ts). The tsx loader the server runs under is
// not carried into worker threads, so the worker registers it for itself and
// then loads its entry. In production the workers are bundled .mjs files and
// this file is never used (workerPool.ts, workerFile).
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
await import(workerData.entry);
