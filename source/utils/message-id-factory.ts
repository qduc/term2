/**
 * Factory for creating counter-based message ID generators.
 *
 * IDs are of the form `<timestamp>-<sequence>` where the sequence resets
 * whenever the timestamp advances.  This guarantees monotonic ordering
 * within a millisecond while still producing short, readable IDs.
 */
export function createMessageIdFactory(now?: () => number): () => string {
  let lastTimestamp = 0;
  let sequence = 0;
  const timeFn = now ?? Date.now;

  return (): string => {
    const timestamp = timeFn();
    if (timestamp !== lastTimestamp) {
      lastTimestamp = timestamp;
      sequence = 0;
    }
    return `${timestamp}-${sequence++}`;
  };
}
