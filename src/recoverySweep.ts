/** A recovery sweep must drain before the host closes its database or changes releases. */
export function startRecoverySweep(input: {
  intervalMs: number;
  immediate?: boolean;
  run(): Promise<void>;
  onError(error: unknown): void;
}): () => Promise<void> {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const sweep = () => {
    if (stopped || pending) return;
    pending = Promise.resolve().then(input.run).catch(input.onError).finally(() => { pending = undefined; });
  };
  const timer = setInterval(sweep, input.intervalMs);
  timer.unref();
  if (input.immediate) sweep();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
