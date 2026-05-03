export function createMessageIdFactory(now: () => number = Date.now): () => string {
  let lastTimestamp = -1;
  let sequence = 0;

  return () => {
    const timestamp = now();

    if (timestamp === lastTimestamp) {
      sequence += 1;
    } else {
      lastTimestamp = timestamp;
      sequence = 0;
    }

    return `${timestamp}-${sequence}`;
  };
}

export const createMessageId = createMessageIdFactory();
