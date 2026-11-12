import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { launchChrome } from "../../src/browser/chromeLifecycle.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// These launches open only local blank pages. They do not use a provider or a
// signed-in profile. Both must remain independent after one is closed.
test.skipIf(process.platform !== "darwin" || !existsSync(chromePath))(
  "copied profiles bind separate Chrome-owned ports and clean up independently",
  async () => {
    vi.stubEnv("ORACLE_BROWSER_PORT", "");
    vi.stubEnv("ORACLE_BROWSER_DEBUG_PORT", "");
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-copy-concurrency-"));
    const occupied = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("no local test port");
    const config = resolveBrowserConfig({
      chromePath,
      headless: true,
      copyProfileSource: root,
      debugPort: null,
    });
    await Promise.all(["one", "two"].map((name) => mkdir(path.join(root, name))));
    const browsers: Awaited<ReturnType<typeof launchChrome>>[] = [];
    try {
      // A fixed port already belongs to another listener and must never be reused.
      await expect(
        launchChrome({ ...config, debugPort: address.port }, path.join(root, "occupied"), () => {}),
      ).rejects.toThrow("automatically assigned debugging port");
      const launched = await Promise.allSettled(
        ["one", "two"].map((name) =>
          launchChrome(config, path.join(root, name), () => {}).then((browser) => {
            browsers.push(browser);
            return browser;
          }),
        ),
      );
      for (const result of launched) {
        if (result.status === "rejected") throw result.reason;
      }
      expect(browsers).toHaveLength(2);
      expect(browsers[0].pid).not.toBe(browsers[1].pid);
      expect(browsers[0].port).not.toBe(browsers[1].port);
      for (const browser of browsers) {
        expect(browser.pid).toBeGreaterThan(0);
        expect(browser.port).toBeGreaterThan(0);
        expect(browser.port).not.toBe(address.port);
        expect((await fetch(`http://127.0.0.1:${browser.port}/json/version`)).ok).toBe(true);
      }
      await browsers[0].kill();
      expect((await fetch(`http://127.0.0.1:${browsers[1].port}/json/version`)).ok).toBe(true);
      process.kill(browsers[1].pid, 0);
    } finally {
      for (const browser of browsers) await browser.kill();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      vi.unstubAllEnvs();
    }
  },
  30_000,
);
