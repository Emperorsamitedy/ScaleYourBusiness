// Idea 53 (I-53.1): the installable app — the manifest and the service
// worker. The worker is run in a sandbox with a stand-in `self`, so its two
// handlers are tested as they behave, and its source is scanned for the
// things it must never do (cache pages, offer an action button).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import manifest from "../../app/manifest";

const SW_SOURCE = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

type Listener = (event: Record<string, unknown>) => void;

function loadWorker(opts: { windows?: { url: string; navigate?: boolean }[] } = {}) {
  const listeners = new Map<string, Listener>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const windows = (opts.windows ?? []).map((w) => {
    const client: Record<string, unknown> = {
      url: w.url,
      focus: () => Promise.resolve(client),
    };
    if (w.navigate !== false) {
      client.navigate = (path: string) => {
        navigated.push(path);
        return Promise.resolve(client);
      };
    }
    return client;
  });
  const self = {
    location: { origin: "https://syb.example" },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: () => undefined,
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(windows),
      openWindow: (path: string) => {
        opened.push(path);
        return Promise.resolve(null);
      },
    },
  };
  runInNewContext(SW_SOURCE, { self, URL });
  const fire = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  return { listeners, shown, opened, navigated, fire };
}

const pushOf = (data: unknown) => ({
  data: {
    json: () => {
      if (data instanceof Error) throw data;
      return data;
    },
  },
});

describe("the web app manifest", () => {
  it("is installable standalone, with the two icon sizes", () => {
    const m = manifest();
    expect(m.display).toBe("standalone");
    expect(m.name).toBe("SYB");
    expect(m.start_url).toBe("/proposals");
    expect(m.icons?.map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
  });

  it("does not open in a browser tab (no 'browser' display)", () => {
    expect(manifest().display).not.toBe("browser");
  });
});

describe("the service worker", () => {
  it("handles only push, notificationclick and its own lifecycle", () => {
    const w = loadWorker();
    expect([...w.listeners.keys()].sort()).toEqual([
      "activate",
      "install",
      "notificationclick",
      "push",
    ]);
  });

  it("caches nothing and offers no action button", () => {
    expect(SW_SOURCE).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(SW_SOURCE).not.toMatch(/\bcaches\s*\./);
    expect(SW_SOURCE).not.toMatch(/\bactions\s*:/);
  });

  it("shows every push at once, with the server's words and the card's path", async () => {
    const w = loadWorker();
    await w.fire(
      "push",
      pushOf({ title: "SYB", body: "1 thing waits for your yes", url: `/proposals/${ID}` }),
    );
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]?.title).toBe("SYB");
    expect(w.shown[0]?.options.body).toBe("1 thing waits for your yes");
    expect(w.shown[0]?.options.data).toEqual({ url: `/proposals/${ID}` });
    expect(w.shown[0]?.options.actions).toBeUndefined();
  });

  it("still shows something for an unreadable push (Safari revokes a silent one)", async () => {
    const w = loadWorker();
    await w.fire("push", pushOf(new SyntaxError("not json")));
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]?.options.body).toBe("Something waits for your yes.");
  });

  it("opens the card the push named", async () => {
    const w = loadWorker();
    await w.fire("notificationclick", {
      notification: { close: () => undefined, data: { url: `/proposals/${ID}` } },
    });
    expect(w.opened).toEqual([`/proposals/${ID}`]);
  });

  it("refuses any other path or origin, and opens the queue instead", async () => {
    for (const url of ["https://evil.example/proposals", "/watch", "/proposals/../ops", "x"]) {
      const w = loadWorker();
      await w.fire("notificationclick", {
        notification: { close: () => undefined, data: { url } },
      });
      expect(w.opened).toEqual(["/proposals"]);
    }
  });

  it("reuses an open SYB window rather than opening another", async () => {
    const w = loadWorker({ windows: [{ url: "https://syb.example/watch" }] });
    await w.fire("notificationclick", {
      notification: { close: () => undefined, data: { url: `/proposals/${ID}` } },
    });
    expect(w.navigated).toEqual([`/proposals/${ID}`]);
    expect(w.opened).toEqual([]);
  });
});
