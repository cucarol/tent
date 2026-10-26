/** Consume the service's empty SSE hints, including frames split across network chunks. */
export async function readChangeHints(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  connected: () => void,
  changed: () => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    event = "",
    connection = false;
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done || signal.aborted) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (!signal.aborted) {
            if (connection) connected();
            if (event === "change") changed();
          }
          event = "";
          connection = false;
        } else if (line === ": connected") connection = true;
        else if (line.startsWith("event:")) event = line.slice(6).trim();
        // The data is deliberately unused: only Core reads establish facts.
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Keep one authenticated subscription; polling continues when watching is unavailable. */
export function followChangeHints(
  open: (signal: AbortSignal) => Promise<Response>,
  refresh: () => void,
  unauthorized: (error: unknown) => boolean,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry = 1000;
  const connect = async () => {
    try {
      const response = await open(controller.signal);
      if (controller.signal.aborted || response.status === 503) {
        // No watcher on this service: keep the existing polling and release its response.
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok || !response.body) throw new Error(`HTTP_${response.status}`);
      await readChangeHints(response.body, controller.signal, refresh, refresh);
    } catch (error) {
      if (controller.signal.aborted || unauthorized(error)) return;
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    }
  };
  void connect();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
