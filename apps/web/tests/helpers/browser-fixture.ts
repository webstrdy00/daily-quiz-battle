import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

class FifoLocks {
  private tails = new Map<string, Promise<void>>();

  request<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    const result = previous.then(operation);
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

export interface FetchCall {
  url: URL;
  init: RequestInit;
}

type AppBundle = {
  act: (operation: () => void | Promise<void>) => Promise<void>;
  mount: (container: Element) => { unmount: () => void };
  api: typeof import("../../src/lib/api.ts");
  drafts: typeof import("../../src/lib/quiz-draft.ts");
};

const webDirectory = fileURLToPath(new URL("../../", import.meta.url));
const contractsSource = fileURLToPath(
  new URL("../../../../packages/contracts/src/index.ts", import.meta.url),
);
let bundlePromise: Promise<string> | undefined;
let instance = 0;

function appBundle(): Promise<string> {
  bundlePromise ??= build({
    stdin: {
      contents: `
        import { act, createElement } from "react";
        import { createRoot } from "react-dom/client";
        import App from "./src/App.tsx";
        export { act };
        export * as api from "./src/lib/api.ts";
        export * as drafts from "./src/lib/quiz-draft.ts";
        export function mount(container) {
          const root = createRoot(container);
          root.render(createElement(App));
          return root;
        }
      `,
      resolveDir: webDirectory,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    alias: { "@daily-quiz-battle/contracts": contractsSource },
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" },
    define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
      "import.meta.env": JSON.stringify({
        DEV: true,
        VITE_API_BASE_URL: "https://quiz-api.invalid",
        VITE_APP_ENV: "development",
        VITE_ANALYTICS_ENABLED: "false",
        VITE_DEV_ANONYMOUS_KEY: "dev-react-integration",
        VITE_RESULT_NOTIFICATION_TEMPLATE_CODE: "test-template",
      }),
    },
    plugins: [
      {
        name: "test-platform-adapter",
        setup(builder) {
          builder.onResolve({ filter: /(^|\/)platform(?:\.ts)?$/ }, () => ({
            path: "test-platform",
            namespace: "test-platform",
          }));
          builder.onLoad({ filter: /.*/, namespace: "test-platform" }, () => ({
            contents: `
              export async function getAnonymousKey() { return "dev-react-integration"; }
              export function setAnalyticsPublishingEnabled() {}
              export async function logAnalyticsEvent() {}
              export async function requestResultNotificationAgreement() { return "agreed"; }
              export async function shareChallenge() { return "shared"; }
              export class ResultNotificationAgreementUnavailableError extends Error {}
            `,
            loader: "js",
          }));
        },
      },
    ],
  }).then((result) => {
    assert.equal(result.outputFiles.length, 1);
    return result.outputFiles[0].text;
  });
  return bundlePromise;
}

export async function browserFixture(
  t: TestContext,
  options: {
    path?: string;
    fetch: (call: FetchCall) => Response | Promise<Response>;
  },
) {
  // jsdom's nonvisual document is hidden, so production polling stays paused.
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: `https://quiz.invalid${options.path ?? "/"}`,
  });
  const locks = new FifoLocks();
  const channels: MessageChannel[] = [];
  const NativeMessageChannel = globalThis.MessageChannel;
  Object.defineProperty(dom.window.navigator, "locks", { value: locks });
  const calls: FetchCall[] = [];
  const fetchErrors: unknown[] = [];
  const mockedFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const call = { url, init };
    calls.push(call);
    try {
      assert.equal(url.origin, "https://quiz-api.invalid");
      // Deliberately allow an already-sent response to arrive after abort.
      // Context guards must protect state even when cancellation loses a race.
      return await options.fetch(call);
    } catch (error) {
      fetchErrors.push(error);
      throw error;
    }
  };
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    StorageEvent: dom.window.StorageEvent,
    DOMException: dom.window.DOMException,
    MessageChannel: class extends NativeMessageChannel {
      constructor() {
        super();
        channels.push(this);
      }
    },
    fetch: mockedFetch,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = Object.keys(globals).map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  }));
  let app: AppBundle | undefined;
  let root: ReturnType<AppBundle["mount"]> | undefined;
  t.after(async () => {
    try {
      if (app) await app.act(async () => root?.unmount());
      await locks.idle();
    } finally {
      for (const channel of channels) {
        channel.port1.close();
        channel.port2.close();
      }
      dom.window.close();
      for (const { name, descriptor } of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  const source = `${await appBundle()}\n//# sourceURL=quiz-browser-fixture-${instance + 1}.mjs`;
  // Bundle act together with App to guarantee one React instance. Each import
  // gets fresh API/session/draft module state without writing a generated file.
  app = (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${++instance}`
  )) as AppBundle;
  const bundle = app;
  async function run(operation: () => void | Promise<void> = () => {}) {
    await bundle.act(async () => {
      await operation();
      await nextTurn();
    });
    await bundle.act(async () => {
      await locks.idle();
    });
  }
  await run(() => {
    root = bundle.mount(dom.window.document.getElementById("root")!);
  });

  function findButton(label: string): HTMLButtonElement | null {
    return (
      [...dom.window.document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes(label),
      ) ?? null
    );
  }
  async function click(element: HTMLElement) {
    assert.ok(element.isConnected, "the clicked element must be mounted");
    assert.equal(element.matches(":disabled"), false, "control is enabled");
    await run(() => element.click());
  }

  return {
    app: bundle,
    document: dom.window.document,
    storage: dom.window.localStorage,
    calls,
    fetchErrors,
    run,
    findButton,
    click,
    async clickButton(label: string) {
      const button = findButton(label);
      assert.ok(button, `Missing button: ${label}`);
      await click(button);
    },
    async waitFor(condition: () => boolean, description: string) {
      const deadline = performance.now() + 5_000;
      do {
        await run();
        if (condition()) return;
      } while (performance.now() < deadline);
      assert.fail(
        `Timed out waiting for ${description}. DOM: ${dom.window.document.body.textContent}. Requests: ${calls.map(({ url }) => url.pathname).join(", ")}`,
      );
    },
  };
}

export type BrowserFixture = Awaited<ReturnType<typeof browserFixture>>;
