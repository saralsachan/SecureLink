/**
 * Pipeline timing instrumentation shared by the popup, the content script and
 * the Node profiling harness.
 *
 * The aggregate object mirrors the requested shape exactly:
 *
 *   { capture, structuralMap, vitInference, sensitiveDetection, redaction,
 *     verify, networkRoundTrip, actionExecution, total }
 *
 * `networkRoundTrip` is the wall time of the POST (including whatever the
 * server did inside it); the server reports its own firewall / VLM / grounding
 * split separately in `server` so total stays a genuine sum.
 */
export type PipelineTimings = {
  capture: number;
  structuralMap: number;
  vitInference: number;
  sensitiveDetection: number;
  redaction: number;
  verify: number;
  networkRoundTrip: number;
  actionExecution: number;
  /** Sum of the eight stage buckets above. */
  total: number;
};

export type ServerTimings = {
  firewallMs: number;
  vlmMs: number;
  groundingMs: number;
  totalMs: number;
};

export type PipelineMetrics = {
  /** Phase 2 delta sync: how many elements were re-processed this step. */
  changedElements: number;
  /** Phase 2 delta sync: total elements in the merged map sent to the server. */
  totalElements: number;
  /** Phase 2 delta sync: true when only changed elements were re-extracted. */
  deltaUsed: boolean;
  step: number;
  stage: string;
};

export const PIPELINE_STAGE_KEYS = [
  "capture",
  "structuralMap",
  "vitInference",
  "sensitiveDetection",
  "redaction",
  "verify",
  "networkRoundTrip",
  "actionExecution"
] as const satisfies readonly (keyof PipelineTimings)[];

export function emptyTimings(): PipelineTimings {
  return {
    capture: 0,
    structuralMap: 0,
    vitInference: 0,
    sensitiveDetection: 0,
    redaction: 0,
    verify: 0,
    networkRoundTrip: 0,
    actionExecution: 0,
    total: 0
  };
}

export function sumTimings(timings: PipelineTimings): number {
  let sum = 0;
  for (const key of PIPELINE_STAGE_KEYS) {
    sum += timings[key];
  }
  return sum;
}

export function withTotal(timings: PipelineTimings): PipelineTimings {
  return { ...timings, total: sumTimings(timings) };
}

/** Round every measurement to whole ms and recompute the total. */
export function normaliseTimings(timings: PipelineTimings): PipelineTimings {
  const normalised = {} as PipelineTimings;
  for (const key of PIPELINE_STAGE_KEYS) {
    normalised[key] = Math.round(timings[key]);
  }
  return withTotal({ ...normalised, total: 0 } as PipelineTimings).total !== undefined
    ? { ...normalised, total: sumTimings(normalised) }
    : normalised;
}

/** A mono stopwatch: call the returned fn to get elapsed ms. */
export function startTimer(): () => number {
  const started = performance.now();
  return () => performance.now() - started;
}

/** Run *fn* and return its wall-clock duration in ms. */
export function time<T>(fn: () => T): { value: T; ms: number } {
  const stop = startTimer();
  const value = fn();
  return { value, ms: stop() };
}

export async function timeAsync<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const stop = startTimer();
  const value = await fn();
  return { value, ms: stop() };
}

export function logPerStage(timings: PipelineTimings, metrics?: PipelineMetrics): void {
  for (const key of PIPELINE_STAGE_KEYS) {
    console.info(`SecureLink stage ${key}: ${timings[key].toFixed(1)} ms`);
  }
  if (metrics) {
    console.info(
      `SecureLink delta: ${metrics.changedElements} changed / ${metrics.totalElements} total ` +
        `(delta=${metrics.deltaUsed}, step=${metrics.step})`
    );
  }
}

/** Log the aggregate object exactly, then the server split if present. */
export function logPipelineTimings(
  timings: PipelineTimings,
  extra?: { server?: ServerTimings | null; metrics?: PipelineMetrics }
): void {
  const aggregate = normaliseTimings(timings);
  console.info("SecureLink pipeline timings:", aggregate);
  if (extra?.server) {
    console.info("SecureLink server timings:", extra.server);
  }
  if (extra?.metrics) {
    console.info(
      "SecureLink pipeline metrics:",
      JSON.stringify(extra.metrics)
    );
  }
}