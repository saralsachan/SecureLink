import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyTimings,
  logPerStage,
  logPipelineTimings,
  normaliseTimings,
  PIPELINE_STAGE_KEYS,
  startTimer,
  sumTimings,
  withTotal,
  type PipelineTimings
} from "../src/pipeline-timing.ts";

describe("pipeline timing helpers", () => {
  test("normaliseTimings rounds stages and recomputes the total", () => {
    const timings: PipelineTimings = { ...emptyTimings(), capture: 10.4, structuralMap: 5.2 };
    const result = normaliseTimings(timings);

    assert.equal(result.capture, 10);
    assert.equal(result.structuralMap, 5);
    assert.equal(result.total, 15);
    assert.equal(result.total, sumTimings(result));
  });

  test("withTotal sums all eight stage buckets", () => {
    const timings: PipelineTimings = {
      ...emptyTimings(),
      capture: 1,
      structuralMap: 2,
      vitInference: 3,
      sensitiveDetection: 4,
      redaction: 5,
      verify: 6,
      networkRoundTrip: 7,
      actionExecution: 8
    };
    const result = withTotal(timings);
    assert.equal(result.total, 36);
  });

  test("PIPELINE_STAGE_KEYS covers the requested aggregate object", () => {
    assert.deepEqual(
      [...PIPELINE_STAGE_KEYS],
      [
        "capture",
        "structuralMap",
        "vitInference",
        "sensitiveDetection",
        "redaction",
        "verify",
        "networkRoundTrip",
        "actionExecution"
      ]
    );
  });

  test("startTimer is monotonic", async () => {
    const stop = startTimer();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(stop() > 0);
  });

  test("logging helpers emit the aggregate object", () => {
    const logs: unknown[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => logs.push(args);

    try {
      const timings = { ...emptyTimings(), capture: 12.7 } satisfies PipelineTimings;
      logPerStage(timings);
      logPipelineTimings(timings, { server: { firewallMs: 1, vlmMs: 2, groundingMs: 3, totalMs: 6 } });
    } finally {
      console.info = original;
    }

    assert.ok(logs.length > 0, "console.info was called");
    assert.ok(
      JSON.stringify(logs).includes('"capture"'),
      "aggregate logged as an object"
    );
    assert.ok(JSON.stringify(logs).includes("firewallMs"));
  });
});