/** Types for scripts/bundle-server.mjs (read by test:deploy). */
export declare const BUNDLE_OPTIONS: Record<string, unknown> & { outfile: string; sourcemap: false; packages: 'external' };
/** The worker threads' bundles, built beside the server's with the same options. */
export declare const WORKER_BUNDLES: (Record<string, unknown> & { outfile: string; sourcemap: false; packages: 'external'; entryPoints: string[] })[];
