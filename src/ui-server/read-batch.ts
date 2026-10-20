import type { ServerResponse } from "node:http";

type Waiting<Input, Output> = {
  input: Input;
  active(): boolean;
  resolve(value: Output | undefined): void;
  reject(error: unknown): void;
};

/**
 * One running read and one waiting batch. Arrivals after a read starts wait for
 * a new observation, so an older read cannot hide their intervening native edits.
 */
export function batchRead<Input, Output>(
  read: (readers: () => Input[]) => Promise<Output | undefined>,
) {
  const pending = new Set<Waiting<Input, Output>>();
  let running = false;
  const start = () => {
    if (running || !pending.size) return;
    running = true;
    const batch = [...pending];
    pending.clear();
    const readers = () => batch.filter((waiter) => waiter.active()).map((waiter) => waiter.input);
    void Promise.resolve()
      .then(() => (readers().length ? read(readers) : undefined))
      .then(
        (value) => {
          for (const waiter of batch) waiter.resolve(value);
        },
        (error: unknown) => {
          for (const waiter of batch) waiter.reject(error);
        },
      )
      .finally(() => {
        running = false;
        start();
      });
  };
  return (input: Input, res: ServerResponse): Promise<Output | undefined> => {
    const socket = res.req.socket;
    if (socket.destroyed || res.destroyed || res.writableEnded) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        res.off("close", closed);
        socket.off("close", closed);
        action();
      };
      const waiter: Waiting<Input, Output> = {
        input,
        active: () => !settled,
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
      };
      const closed = () => {
        pending.delete(waiter);
        waiter.resolve(undefined);
      };
      res.once("close", closed);
      // A pipelined response waiting for its socket does not emit response.close.
      socket.once("close", closed);
      pending.add(waiter);
      start();
    });
  };
}
