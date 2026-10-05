import assert from "node:assert/strict";
import test from "node:test";
import { ensureDockerReady } from "./backup-production.mjs";

const PRIVATE =
  "postgresql://private-user:private-password@private-host/postgres";

function harness(run, platform = "win32") {
  let elapsed = 0;
  const calls = [];
  const waits = [];
  return {
    calls,
    waits,
    elapsed: () => elapsed,
    dependencies: {
      platform,
      now: () => elapsed,
      run: async (args, options) => {
        calls.push({ args, ...options });
        return run(args, options, (ms) => {
          elapsed += ms;
        });
      },
      wait: async (ms) => {
        waits.push(ms);
        elapsed += ms;
      },
    },
  };
}

test("ready Docker needs one bounded probe and never starts Desktop", async () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const state = harness(async () => Buffer.from("ready"), platform);
    await ensureDockerReady(state.dependencies);
    assert.deepEqual(state.calls, [{ args: ["info"], timeoutMs: 10_000 }]);
    assert.deepEqual(state.waits, []);
  }
});

test("stopped Windows Docker starts Desktop once and polls until ready", async () => {
  let probes = 0;
  const state = harness(async (args) => {
    if (args[0] === "desktop") return Buffer.alloc(0);
    if (++probes < 3) throw new Error(PRIVATE);
    return Buffer.from("ready");
  });
  await ensureDockerReady(state.dependencies);
  assert.deepEqual(state.calls, [
    { args: ["info"], timeoutMs: 10_000 },
    { args: ["desktop", "start", "--detach"], timeoutMs: 30_000 },
    { args: ["info"], timeoutMs: 10_000 },
    { args: ["info"], timeoutMs: 10_000 },
  ]);
  assert.deepEqual(state.waits, [5_000]);
});

test("permanently starting Docker exhausts at most 180 seconds including startup", async () => {
  const state = harness(async (args, { timeoutMs }, advance) => {
    if (args[0] === "desktop") {
      advance(1_000);
      return Buffer.alloc(0);
    }
    advance(timeoutMs);
    throw new Error(PRIVATE);
  });
  await assert.rejects(ensureDockerReady(state.dependencies), {
    name: "Error",
    message: "Docker readiness timed out.",
  });
  assert.equal(state.elapsed(), 180_000);
  assert.equal(
    state.calls.filter(({ args }) => args[0] === "desktop").length,
    1,
  );
  assert.equal(state.calls.at(-1).timeoutMs, 4_000);
  assert.ok(
    state.calls.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 30_000),
  );
  assert.ok(state.waits.every((ms) => ms > 0 && ms <= 5_000));
});

test("Desktop startup failure is sanitized and does not retry startup or poll", async () => {
  const state = harness(async () => {
    throw new Error(PRIVATE);
  });
  await assert.rejects(ensureDockerReady(state.dependencies), (error) => {
    assert.equal(error.message, "Docker Desktop could not be started.");
    assert.equal(error.cause, undefined);
    assert.equal(String(error).includes(PRIVATE), false);
    return true;
  });
  assert.deepEqual(state.calls, [
    { args: ["info"], timeoutMs: 10_000 },
    { args: ["desktop", "start", "--detach"], timeoutMs: 30_000 },
  ]);
  assert.deepEqual(state.waits, []);
});

test("unready non-Windows Docker fails sanitized without starting Desktop", async () => {
  for (const platform of ["linux", "darwin"]) {
    const state = harness(async () => {
      throw new Error(PRIVATE);
    }, platform);
    await assert.rejects(ensureDockerReady(state.dependencies), (error) => {
      assert.equal(error.message, "Docker is not ready.");
      assert.equal(error.cause, undefined);
      assert.equal(String(error).includes(PRIVATE), false);
      return true;
    });
    assert.deepEqual(state.calls, [{ args: ["info"], timeoutMs: 10_000 }]);
    assert.deepEqual(state.waits, []);
  }
});
