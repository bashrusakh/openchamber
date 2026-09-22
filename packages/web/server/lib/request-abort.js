export const createRequestAbortSignal = (req, res) => {
  const controller = new AbortController();
  const abort = () => {
    if (!res?.writableEnded) controller.abort();
  };

  req?.once?.('aborted', abort);
  res?.once?.('close', abort);
  if (req?.aborted) controller.abort();

  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    cleanup: () => {
      req?.off?.('aborted', abort);
      res?.off?.('close', abort);
    },
  };
};
