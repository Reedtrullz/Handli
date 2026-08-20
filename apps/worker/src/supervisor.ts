export interface SupervisedWorkerRuntime {
  readonly exitCode: 0 | 1;
  requestShutdown(): Promise<void>;
  runCycle(): Promise<unknown>;
}

export interface WorkerSupervisorOptions {
  cycleIntervalMs: number;
  observer?: WorkerSupervisorObserver;
  signal: AbortSignal;
}

export interface WorkerSupervisorObserver {
  cycleCompleted(result: unknown): void;
  cycleFailed(): void;
  cycleStarted(): void;
  schedulerStarted(): void;
  schedulerStopped(exitCode: 0 | 1): void;
  schedulerStopping(): void;
}

function waitForNextCycle(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function superviseWorker(
  runtime: SupervisedWorkerRuntime,
  options: WorkerSupervisorOptions,
): Promise<0 | 1> {
  if (
    !Number.isSafeInteger(options.cycleIntervalMs)
    || options.cycleIntervalMs < 1_000
    || options.cycleIntervalMs > 15 * 60 * 1_000
  ) {
    throw new TypeError("cycleIntervalMs must be an integer from 1000 through 900000");
  }

  let finalExitCode: 0 | 1 = 1;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= runtime.requestShutdown();
  };
  options.signal.addEventListener("abort", shutdown, { once: true });
  if (options.signal.aborted) shutdown();
  options.observer?.schedulerStarted();

  try {
    while (!options.signal.aborted) {
      options.observer?.cycleStarted();
      try {
        const result = await runtime.runCycle();
        options.observer?.cycleCompleted(result);
      } catch {
        options.observer?.cycleFailed();
        shutdown();
        await shutdownPromise;
        finalExitCode = 1;
        return finalExitCode;
      }
      await waitForNextCycle(options.cycleIntervalMs, options.signal);
    }
    options.observer?.schedulerStopping();
    shutdown();
    await shutdownPromise;
    finalExitCode = runtime.exitCode;
    return finalExitCode;
  } finally {
    options.signal.removeEventListener("abort", shutdown);
    options.observer?.schedulerStopped(finalExitCode);
  }
}
