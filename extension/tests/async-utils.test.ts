import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../src/async-utils.ts";

const never = () => new Promise<void>(() => {});
const tick = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("withTimeout", () => {
  test("resolves with the value when the promise settles in time", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 500, "too slow");
    assert.equal(result, "ok");
  });

  test("rejects with the clear message when the promise never settles", async () => {
    await assert.rejects(withTimeout(never(), 20, "agent stalled"), /agent stalled/);
  });

  test("propagates the original rejection, not a timeout", async () => {
    const boom = Promise.reject(new Error("original cause"));
    await assert.rejects(withTimeout(boom, 500, "timeout msg"), /original cause/);
  });

  test("keeps the original promise alive after timeout (no crash on late settle)", async () => {
    let settled = false;
    const late = tick(100).then(() => {
      settled = true;
      return 1;
    });
    await assert.rejects(withTimeout(late, 10, "late"), /late/);
    await tick(120);
    assert.equal(settled, true, "the delayed promise must not throw unhandled");
  });
});