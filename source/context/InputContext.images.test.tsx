// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act, useEffect, useState } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider, useInputContext } from './InputContext.js';

const flushReactUpdates = async (iterations = 1) => {
  await act(async () => {
    for (let i = 0; i < iterations; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
};

test('InputProvider exposes shared image state', async (t) => {
  let capturedContext: any;

  const Capture = () => {
    const context = useInputContext();

    useEffect(() => {
      capturedContext = context;
    }, [context]);

    return null;
  };

  render(
    <InputProvider>
      <Capture />
    </InputProvider>,
  );

  await flushReactUpdates(1);

  t.truthy(capturedContext);
  t.deepEqual(capturedContext.images, []);
  t.is(typeof capturedContext.setImages, 'function');
});

test('InputProvider preserves images across child unmounts', async (t) => {
  const image = { id: 'img-1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 };
  let seenImages: (typeof image)[] | null = null;

  const Seeder = ({ onSeeded }: { onSeeded: () => void }) => {
    const { images, setImages } = useInputContext();

    useEffect(() => {
      if (images.length === 0) {
        setImages([image]);
        onSeeded();
      }
    }, [images.length, onSeeded, setImages]);

    return null;
  };

  const Viewer = () => {
    const { images } = useInputContext();

    useEffect(() => {
      seenImages = images as (typeof image)[];
    }, [images]);

    return null;
  };

  const Harness = () => {
    const [showSeeder, setShowSeeder] = useState(true);

    return <InputProvider>{showSeeder ? <Seeder onSeeded={() => setShowSeeder(false)} /> : <Viewer />}</InputProvider>;
  };

  render(<Harness />);
  await flushReactUpdates(3);

  t.deepEqual(seenImages, [image]);
});
