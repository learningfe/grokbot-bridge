const DEFAULT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

export async function postJson(
  url: string,
  bearer: string,
  body: unknown,
  options: { fetchImpl?: typeof fetch; delaysMs?: number[] } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delays = options.delaysMs ?? DEFAULT_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const outcome = await postOnce(fetchImpl, url, bearer, body);
    if (outcome === "ok") return;
    if (outcome instanceof Error && outcome.message.startsWith("webhook rejected")) {
      throw outcome;
    }
    lastError = outcome;
    const delay = delays[attempt];
    if (delay === undefined) break;
    await sleep(delay);
  }
  throw lastError instanceof Error ? lastError : new Error("webhook failed");
}

async function postOnce(
  fetchImpl: typeof fetch,
  url: string,
  bearer: string,
  body: unknown,
): Promise<"ok" | Error> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return "ok";
    if (response.status === 429 || response.status >= 500) {
      return new Error(`webhook status ${response.status}`);
    }
    return new Error(`webhook rejected ${response.status}`);
  } catch (error) {
    return error instanceof Error ? error : new Error("webhook request failed");
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("failed"));
      },
    );
  });
}
