export type GalleryTheme = "light" | "dark";

interface RuntimeSession {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export async function selectGalleryTheme(
  session: RuntimeSession,
  theme: GalleryTheme,
  options: { readonly verifySessionStorage?: boolean } = {},
): Promise<string | undefined> {
  const evaluation = (await session.send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    expression: `new Promise((resolve, reject) => {
      const toggle = document.getElementById('facet-theme-toggle');
      if (toggle === null) {
        reject(new Error('theme toggle missing'));
        return;
      }
      for (let index = 0; index < ${theme === "dark" ? 1 : 2}; index += 1) toggle.click();
      const deadline = Date.now() + 7000;
      const inspect = () => {
        const session = JSON.parse(window.sessionStorage.getItem('facet:gallery-session') ?? '{}');
        if (
          document.documentElement.dataset.theme === ${JSON.stringify(theme)}${options.verifySessionStorage ? ` && session.theme === ${JSON.stringify(theme)}` : ""}
        ) {
          resolve(document.documentElement.dataset.theme);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('theme toggle did not settle'));
          return;
        }
        setTimeout(inspect, 25);
      };
      inspect();
    })`,
  })) as { result?: { value?: string } };
  return evaluation.result?.value;
}
