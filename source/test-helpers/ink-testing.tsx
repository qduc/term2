import React, { act } from 'react';
import { render } from 'ink-testing-library';

type TeardownContext = {
  teardown: (callback: () => void | Promise<void>) => void;
};

type InkRenderResult = ReturnType<typeof render>;

export const renderInAct = async (element: React.ReactElement, context: TeardownContext): Promise<InkRenderResult> => {
  let result!: InkRenderResult;

  await act(async () => {
    result = render(element);
    await Promise.resolve();
  });

  context.teardown(async () => {
    await act(async () => {
      result.unmount();
    });
  });

  return result;
};

export const rerenderInAct = async (view: InkRenderResult, element: React.ReactElement): Promise<void> => {
  await act(async () => {
    view.rerender(element);
  });
};
