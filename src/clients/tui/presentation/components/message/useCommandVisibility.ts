import { useContext, useState, useEffect } from 'react';
import { LiveToolAgeContext } from '../../../live-tool-age.js';

/**
 * Delays visibility of a running command message by 1 second to avoid flicker
 * for fast-completing operations. Completed/failed messages are shown immediately.
 */
export function useCommandVisibility(status: string | undefined): { isVisible: boolean; isRunning: boolean } {
  // Port exception: a one-shot live render supplies the age the row's own timer would have measured.
  const age = useContext(LiveToolAgeContext);
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

  if (age !== undefined) return { isVisible: !isInFlight || age.inFlightMs >= 1000, isRunning };
  return { isVisible, isRunning };
}
