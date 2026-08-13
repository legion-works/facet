import { expect, test } from "bun:test";

import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import { resolveLauncher } from "../../src/validation/tier1/launcher";

test("Runtime.exceptionThrown includes the throwing document execution context", async () => {
  const launcher = resolveLauncher();
  const browser = new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
  let target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>> | undefined;
  try {
    target = await browser.launch();
    const exceptions: unknown[] = [];
    const contexts: unknown[] = [];
    target.session.on("Runtime.exceptionThrown", (event) => exceptions.push(event));
    target.session.on("Runtime.executionContextCreated", (event) => contexts.push(event));
    await target.session.send("Runtime.enable");
    await target.session.send("Page.enable");
    await target.session.send("Page.navigate", {
      url: "data:text/html,<script>throw new Error('protocol event proof')</script>",
    });
    await Bun.sleep(100);
    const exception = exceptions.find((event) => {
      const details = (event as { exceptionDetails?: { text?: string } }).exceptionDetails;
      return details?.text?.includes("Uncaught") === true;
    }) as { exceptionDetails?: { executionContextId?: number } } | undefined;
    expect(exception?.exceptionDetails?.executionContextId).toEqual(expect.any(Number));
    expect(contexts).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          id: exception?.exceptionDetails?.executionContextId,
          auxData: expect.objectContaining({ frameId: expect.any(String) }),
        }),
      }),
    );
  } finally {
    await target?.close();
  }
}, 90_000);
