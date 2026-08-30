import { useState, useEffect } from 'react';

/**
 * Delays visibility of a running command message by 1 second to avoid flicker
 * for fast-completing operations. Completed/failed messages are shown immediately.
 */
export function useCommandVisibility(status: string | undefined): { isVisible: boolean; isRunning: boolean } {
  const isRunning = status === 'running';
  const isInFlight = status === 'pending' || status === 'running';
  const [isVisible, setIsVisible] = useState(!isInFlight);

  useEffect(() => {
    if (!isInFlight) {
      if (!isVisible) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- show-after-delay is an inherent side effect
        setIsVisible(true);
      }
      return;
    }

    const timer = setTimeout(() => {
      setIsVisible(true);
    }, 1000);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isVisible drives show-after-delay which is inherently side-effect; adding isVisible would cause a re-render loop
  }, [isInFlight]);

  return { isVisible, isRunning };
}
