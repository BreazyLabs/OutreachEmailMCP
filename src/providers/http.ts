/**
 * One upstream HTTP timeout for every Google / Microsoft call.
 *
 * Node's fetch waits up to five minutes for headers by default. The poller
 * walks the mailboxes one after another and the send worker holds a job
 * while it talks to the provider, so a single hung connection stalled
 * everything behind it for that long. Sixty seconds covers the slowest
 * legitimate call (fetching a large raw message) with room to spare.
 */
export const UPSTREAM_TIMEOUT_MS = 60_000;

export function upstreamSignal(ms = UPSTREAM_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}
