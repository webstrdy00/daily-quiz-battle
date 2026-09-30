import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { DailyStartResponse } from "@daily-quiz-battle/contracts";
import {
  clearDraft,
  clearUserDrafts,
  draftKey,
  draftPrefix,
  getDraftGeneration,
  mutateDraft,
  newDraft,
  readDraft,
  type QuizDraft,
} from "../src/lib/quiz-draft.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const attemptId = "20000000-0000-4000-8000-000000000001";
const otherAttemptId = "20000000-0000-4000-8000-000000000002";
const unseenAttemptId = "20000000-0000-4000-8000-000000000003";
const completionKey = "complete-40000000-0000-4000-8000-000000000001";
const selections = [0, 1, 2, 3, 0];
const storageError = /기기에 임시 보관하지 못했어요/;
const invalidDraftError = /기기의 임시 답안을 확인하지 못했어요/;
const removedDraftError = /기기의 답안이 삭제됐어요/;
const staleDraftError = /답안 상태가 변경되어 임시 보관을 중단했어요/;

type StorageOperation = "getItem" | "setItem" | "removeItem";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  failure: StorageOperation | null = null;
  discardWrites = false;

  private check(operation: StorageOperation): void {
    if (this.failure === operation)
      throw new Error(`Storage ${operation} failed`);
  }

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    this.check("getItem");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.check("setItem");
    if (!this.discardWrites) this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.check("removeItem");
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

class FifoLocks {
  private tails = new Map<string, Promise<void>>();

  request<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    const result = previous.then(operation);
    // A rejected callback releases the lock rather than poisoning the queue.
    this.tails.set(
      name,
      result.then(
        () => {},
        () => {},
      ),
    );
    return result;
  }

  async idle(): Promise<void> {
    await Promise.all(this.tails.values());
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function environment(t: TestContext, hasLocks = true) {
  const storage = new MemoryStorage();
  const locks = new FifoLocks();
  const releases = new Set<() => void>();
  const originals = ["localStorage", "navigator", "crypto"].map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  }));
  let generation = 0;

  t.after(async () => {
    try {
      for (const release of releases) release();
      await locks.idle();
    } finally {
      for (const { name, descriptor } of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
  Object.defineProperties(globalThis, {
    localStorage: { configurable: true, value: storage },
    navigator: {
      configurable: true,
      value: hasLocks ? { locks } : {},
    },
    crypto: {
      configurable: true,
      value: {
        randomUUID: () =>
          `50000000-0000-4000-8000-${String(++generation).padStart(12, "0")}`,
      },
    },
  });
  return { storage, locks, releases };
}

async function holdUserLock(
  fixture: ReturnType<typeof environment>,
  id = userId,
): Promise<() => void> {
  const entered = deferred();
  const released = deferred();
  fixture.releases.add(released.resolve);
  void fixture.locks.request(`${draftPrefix}${id}`, () => {
    entered.resolve();
    return released.promise;
  });
  await entered.promise;
  return released.resolve;
}

function daily(
  id = attemptId,
  quizDate = "2026-09-30",
): Extract<DailyStartResponse, { status: "available" }> {
  return {
    status: "available",
    attempt: {
      id,
      status: "started",
      quizDate,
      answeredCount: 0,
      score: null,
      answers: [],
    },
    questions: Array.from({ length: 5 }, (_, index) => ({
      sequence: index + 1,
      revisionId: `30000000-0000-4000-8000-00000000000${index + 1}`,
      prompt: `Question ${index + 1}`,
      choices: ["A", "B", "C", "D"],
    })),
  };
}

function frozenDraft(base: QuizDraft): QuizDraft {
  return {
    ...base,
    currentQuestion: 5,
    frozen: {
      key: completionKey,
      answers: base.selections.map((selectedIndex, index) => {
        assert.notEqual(
          selectedIndex,
          null,
          "the submission fixture is complete",
        );
        return {
          sequence: index + 1,
          questionRevisionId: base.revisions[index],
          selectedIndex: selectedIndex!,
        };
      }),
    },
  };
}

test("server answers resume by sequence and saved progress overrides a fresh base", async (t) => {
  const { storage } = environment(t);
  const response = daily();
  response.attempt.answers = [
    {
      sequence: 4,
      questionRevisionId: response.questions[3].revisionId,
      selectedIndex: 0,
    },
    {
      sequence: 2,
      questionRevisionId: response.questions[1].revisionId,
      selectedIndex: 3,
    },
  ];
  response.attempt.answeredCount = 2;
  const base = newDraft(userId, response);
  assert.deepEqual(base.selections, [null, 3, null, 0, null]);
  assert.equal(readDraft(base), null);

  const saved = await mutateDraft(
    base,
    (stored) => {
      assert.equal(stored, null);
      return { ...base, selections: [0, 3, 2, 0, null], currentQuestion: 4 };
    },
    () => true,
  );
  assert.deepEqual(JSON.parse(storage.getItem(draftKey(base))!), saved);
  assert.deepEqual(readDraft(newDraft(userId, daily())), saved);

  const resumed = await mutateDraft(
    newDraft(userId, daily()),
    (stored) => {
      assert.deepEqual(stored, saved);
      return { ...stored!, selections: [0, 3, 2, 0, 1], currentQuestion: 5 };
    },
    () => true,
  );
  assert.deepEqual(readDraft(base), resumed);
});

test("stored identity, revision and progress corruption fails closed without rewriting data", (t) => {
  const { storage } = environment(t);
  const base = newDraft(userId, daily());
  const cases: [string, unknown][] = [
    ["user mismatch", { ...base, userId: otherUserId }],
    ["attempt mismatch", { ...base, attemptId: otherAttemptId }],
    ["date mismatch", { ...base, quizDate: "2026-10-01" }],
    [
      "revision mismatch",
      { ...base, revisions: [otherAttemptId, ...base.revisions.slice(1)] },
    ],
    ["unsupported version", { ...base, version: 2 }],
    ["missing selection", { ...base, selections: [0, 1, 2, 3] }],
    ["out-of-range selection", { ...base, selections: [4, 1, 2, 3, 0] }],
    ["out-of-range progress", { ...base, currentQuestion: 6 }],
    ["null document", null],
  ];
  const rawCases: [string, string][] = [
    ...cases.map(([label, value]): [string, string] => [
      label,
      JSON.stringify(value),
    ]),
    ["corrupt JSON", "{"],
    ["oversized document", `${JSON.stringify(base)}${" ".repeat(8193)}`],
  ];
  for (const [label, raw] of rawCases) {
    storage.setItem(draftKey(base), raw);
    assert.throws(() => readDraft(base), invalidDraftError, label);
    assert.equal(storage.getItem(draftKey(base)), raw, label);
  }
});

test("frozen requests round-trip only when key, schema, order, revisions and selections agree", async (t) => {
  const { storage } = environment(t);
  const base = newDraft(userId, daily());
  const frozen = frozenDraft({ ...base, selections: [...selections] });
  await mutateDraft(
    base,
    () => frozen,
    () => true,
  );
  assert.deepEqual(readDraft(base), frozen);
  const answers = frozen.frozen!.answers;
  const cases: [string, unknown][] = [
    [
      "wrong key prefix",
      { ...frozen.frozen, key: completionKey.replace("complete-", "retry-") },
    ],
    ["invalid key UUID", { ...frozen.frozen, key: "complete-not-a-uuid" }],
    ["missing answer", { ...frozen.frozen, answers: answers.slice(1) }],
    [
      "duplicate sequence",
      {
        ...frozen.frozen,
        answers: [answers[0], answers[0], ...answers.slice(2)],
      },
    ],
    [
      "reordered answers",
      { ...frozen.frozen, answers: [...answers].reverse() },
    ],
    [
      "wrong revision",
      {
        ...frozen.frozen,
        answers: [
          { ...answers[0], questionRevisionId: otherAttemptId },
          ...answers.slice(1),
        ],
      },
    ],
    [
      "wrong selection",
      {
        ...frozen.frozen,
        answers: [{ ...answers[0], selectedIndex: 1 }, ...answers.slice(1)],
      },
    ],
    [
      "unexpected answer field",
      {
        ...frozen.frozen,
        answers: [{ ...answers[0], extra: true }, ...answers.slice(1)],
      },
    ],
  ];
  for (const [label, value] of cases) {
    const raw = JSON.stringify({ ...frozen, frozen: value });
    storage.setItem(draftKey(base), raw);
    assert.throws(() => readDraft(base), invalidDraftError, label);
    assert.equal(storage.getItem(draftKey(base)), raw, label);
  }
  storage.setItem(
    draftKey(base),
    JSON.stringify({ ...frozen, selections: [null, 1, 2, 3, 0] }),
  );
  assert.throws(
    () => readDraft(base),
    invalidDraftError,
    "frozen answers cannot cover an unanswered selection",
  );
});

test("concurrent updates and freezes preserve the first frozen request in either FIFO order", async (t) => {
  const fixture = environment(t);
  for (const order of ["update-first", "freeze-first"] as const) {
    const base = newDraft(
      userId,
      daily(order === "update-first" ? attemptId : otherAttemptId),
    );
    const initial = { ...base, selections: [...selections] };
    await mutateDraft(
      base,
      () => initial,
      () => true,
    );
    const release = await holdUserLock(fixture);
    const changed = [3, 2, 1, 0, 3];
    let updateCalls = 0;
    let lateCalls = 0;
    const update = () =>
      mutateDraft(
        base,
        (stored) => {
          updateCalls++;
          assert.deepEqual(stored, initial);
          return { ...stored!, selections: changed, currentQuestion: 4 };
        },
        () => true,
      );
    const freeze = () =>
      mutateDraft(
        base,
        (stored) => {
          assert.ok(stored);
          return frozenDraft(stored);
        },
        () => true,
      );
    const first = order === "update-first" ? update() : freeze();
    const second = order === "update-first" ? freeze() : update();
    const late = mutateDraft(
      base,
      (stored) => {
        lateCalls++;
        return { ...stored!, selections: [1, 1, 1, 1, 1], frozen: null };
      },
      () => true,
    );
    assert.equal(updateCalls, 0, "writers wait for the shared user lock");
    release();
    const [firstResult, secondResult, lateResult] = await Promise.all([
      first,
      second,
      late,
    ]);
    const expectedSelections = order === "update-first" ? changed : selections;
    const expected = frozenDraft({
      ...base,
      selections: [...expectedSelections],
    });
    assert.deepEqual(
      order === "update-first" ? secondResult : firstResult,
      expected,
    );
    assert.deepEqual(secondResult, expected);
    assert.deepEqual(lateResult, expected);
    assert.equal(updateCalls, order === "update-first" ? 1 : 0);
    assert.equal(
      lateCalls,
      0,
      "a frozen request bypasses every later change callback",
    );
    assert.deepEqual(readDraft(base), expected);
    assert.deepEqual(
      JSON.parse(fixture.storage.getItem(draftKey(base))!),
      expected,
    );
  }
});

test("clearDraft prevents queued stale recreation without deleting a sibling attempt", async (t) => {
  const fixture = environment(t);
  const base = newDraft(userId, daily());
  const sibling = newDraft(userId, daily(otherAttemptId));
  for (const draft of [base, sibling])
    await mutateDraft(
      draft,
      () => draft,
      () => true,
    );
  const release = await holdUserLock(fixture);
  const clearing = clearDraft(base);
  let calls = 0;
  const stale = mutateDraft(
    base,
    () => {
      calls++;
      return base;
    },
    () => true,
  );
  const rejected = assert.rejects(stale, removedDraftError);
  release();
  await Promise.all([clearing, rejected]);
  assert.equal(calls, 0);
  assert.equal(readDraft(base), null);
  assert.deepEqual(
    readDraft(sibling),
    sibling,
    "clearing one attempt leaves its sibling intact",
  );
  await assert.rejects(
    mutateDraft(
      base,
      () => base,
      () => true,
    ),
    removedDraftError,
  );
  assert.equal(fixture.storage.getItem(draftKey(base)), null);
});

test("clearUserDrafts invalidates queued saved and unseen attempts while isolating another account", async (t) => {
  const fixture = environment(t);
  const first = newDraft(userId, daily());
  const second = newDraft(userId, daily(otherAttemptId, "2026-10-01"));
  const unseen = newDraft(userId, daily(unseenAttemptId));
  const other = newDraft(otherUserId, daily());
  for (const draft of [first, second, other]) {
    await mutateDraft(
      draft,
      () => draft,
      () => true,
    );
  }
  const before = getDraftGeneration(userId);
  const release = await holdUserLock(fixture);
  const clearing = clearUserDrafts(userId);
  let calls = 0;
  const rejected = [first, second, unseen].map((draft) =>
    assert.rejects(
      mutateDraft(
        draft,
        () => {
          calls++;
          return draft;
        },
        () => true,
      ),
      staleDraftError,
    ),
  );
  release();
  await Promise.all([clearing, ...rejected]);
  assert.equal(calls, 0);
  assert.notEqual(getDraftGeneration(userId), before);
  for (const draft of [first, second, unseen])
    assert.equal(readDraft(draft), null);
  assert.deepEqual(readDraft(other), other);
  assert.equal(getDraftGeneration(otherUserId), null);
  await assert.rejects(
    mutateDraft(
      first,
      () => first,
      () => true,
    ),
    removedDraftError,
  );
  const fresh = await mutateDraft(
    unseen,
    () => unseen,
    () => true,
  );
  assert.deepEqual(
    readDraft(unseen),
    fresh,
    "a newly current session may save a new attempt",
  );
});

test("account locks are independent and a queued writer rechecks its current session", async (t) => {
  const fixture = environment(t);
  const base = newDraft(userId, daily());
  const other = newDraft(otherUserId, daily());
  const release = await holdUserLock(fixture);
  let currentUser = userId;
  let calls = 0;
  const stale = mutateDraft(
    base,
    () => {
      calls++;
      return base;
    },
    () => currentUser === userId,
  );
  const rejected = assert.rejects(stale, staleDraftError);
  const otherSaved = mutateDraft(
    other,
    () => other,
    () => true,
  );
  await fixture.locks.request("test:barrier", () => {});
  assert.equal(
    calls,
    0,
    "another account does not release this account's lock",
  );
  assert.equal(readDraft(base), null);
  assert.deepEqual(readDraft(other), other);
  currentUser = otherUserId;
  const following = mutateDraft(
    base,
    () => base,
    () => true,
  );
  release();
  await Promise.all([rejected, following, otherSaved]);
  assert.equal(calls, 0);
  assert.deepEqual(
    readDraft(base),
    base,
    "a rejected writer does not poison the lock queue",
  );
  assert.deepEqual(readDraft(other), other);
});

test("storage read errors, write errors and lost writes never acknowledge an unsaved submission", async (t) => {
  const { storage } = environment(t);
  const base = newDraft(userId, daily());
  storage.failure = "getItem";
  assert.throws(() => readDraft(base), storageError);
  let calls = 0;
  await assert.rejects(async () =>
    mutateDraft(
      base,
      () => {
        calls++;
        return base;
      },
      () => true,
    ),
  );
  storage.failure = null;
  assert.equal(calls, 0);
  assert.equal(storage.length, 0);
  await mutateDraft(
    base,
    () => base,
    () => true,
  );
  const before = storage.getItem(draftKey(base));
  const frozen = frozenDraft({ ...base, selections: [...selections] });
  for (const failure of ["setItem", "discarded-write"] as const) {
    if (failure === "setItem") storage.failure = failure;
    else storage.discardWrites = true;
    await assert.rejects(
      mutateDraft(
        base,
        () => frozen,
        () => true,
      ),
      storageError,
    );
    storage.failure = null;
    storage.discardWrites = false;
    assert.equal(storage.getItem(draftKey(base)), before);
    assert.deepEqual(readDraft(base), base);
  }
});

test("failed deletion reports failure and its tombstone still prevents stale mutation", async (t) => {
  const { storage } = environment(t);
  const base = newDraft(userId, daily());
  await mutateDraft(
    base,
    () => base,
    () => true,
  );
  storage.failure = "removeItem";
  await assert.rejects(clearDraft(base), storageError);
  storage.failure = null;
  assert.deepEqual(
    readDraft(base),
    base,
    "the failed removal did not silently delete data",
  );
  let calls = 0;
  await assert.rejects(
    mutateDraft(
      base,
      () => {
        calls++;
        return base;
      },
      () => true,
    ),
    removedDraftError,
  );
  assert.equal(calls, 0);
});

test("failed removal markers preserve both accounts rather than acknowledging a clear", async (t) => {
  const { storage } = environment(t);
  const base = newDraft(userId, daily());
  const other = newDraft(otherUserId, daily());
  for (const draft of [base, other])
    await mutateDraft(
      draft,
      () => draft,
      () => true,
    );
  storage.failure = "setItem";
  await assert.rejects(clearDraft(base), storageError);
  await assert.rejects(clearUserDrafts(userId), storageError);
  storage.failure = null;
  assert.deepEqual(readDraft(base), base);
  assert.deepEqual(readDraft(other), other);
  assert.equal(getDraftGeneration(userId), null);
});

test("absent Web Locks fails closed for saving and clearing without touching persisted data", async (t) => {
  const { storage } = environment(t, false);
  const base = newDraft(userId, daily());
  storage.setItem(draftKey(base), JSON.stringify(base));
  let calls = 0;
  await assert.rejects(
    mutateDraft(
      base,
      () => {
        calls++;
        return base;
      },
      () => true,
    ),
    storageError,
  );
  await assert.rejects(clearDraft(base), storageError);
  await assert.rejects(clearUserDrafts(userId), storageError);
  assert.equal(calls, 0);
  assert.equal(storage.length, 1);
  assert.equal(getDraftGeneration(userId), null);
  assert.deepEqual(readDraft(base), base);
});
