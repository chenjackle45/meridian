export interface RequestAbortLink {
  controller: AbortController
  abort: (reason?: unknown) => void
  detach: () => void
}

/** Forward an HTTP request abort into the SDK query lifecycle. */
export function linkRequestAbort(signal: AbortSignal): RequestAbortLink {
  const controller = new AbortController()
  let attached = false

  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const forwardAbort = () => abort(signal.reason)

  if (signal.aborted) {
    forwardAbort()
  } else {
    signal.addEventListener("abort", forwardAbort, { once: true })
    attached = true
  }

  return {
    controller,
    abort,
    detach: () => {
      if (!attached) return
      signal.removeEventListener("abort", forwardAbort)
      attached = false
    },
  }
}
