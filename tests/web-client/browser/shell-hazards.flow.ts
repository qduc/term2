import { expect, type Page, type Route } from '@playwright/test';
import { expectNoRunningTurn, openDraftChat, send, sessionIds, test, turns } from './flow-helpers.js';

/**
 * Late responses in the chat shell (web-transcript spec, section 5): a request that resolves after the user has
 * moved on must not change what the page now shows, and a chat must not be created twice or lost. Each flow holds
 * one request at the browser boundary until the user has acted, then lets it finish.
 */

/** Holds the first request matching `match` until `release()`; later ones pass. */
async function hold(page: Page, match: (url: URL, method: string) => boolean) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let seen!: () => void;
  const arrived = new Promise<void>((resolve) => (seen = resolve));
  let taken = false;
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    if (!taken && match(new URL(request.url()), request.method())) {
      taken = true;
      seen();
      await released;
    }
    await route.fallback();
  });
  return { arrived, release };
}

const approvalChip = (page: Page) => page.getByRole('button', { name: /^Approval mode:/ });

test('an approval change that resolves after switching chats does not show on the chat switched to', async ({
  page,
  launch,
}) => {
  const app = await launch({ scripts: { 'chat a': [{ text: 'reply a' }], 'chat b': [{ text: 'reply b' }] } });
  await openDraftChat(page, app);
  await send(page, 'chat a');
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  const chatA = new URL(page.url()).searchParams.get('agentSession')!;
  await page
    .getByRole('button', { name: `New chat in ${app.workspaceName}` })
    .first()
    .click();
  await send(page, 'chat b');
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  await expect(approvalChip(page)).toHaveAccessibleName('Approval mode: Ask before tools');

  // Back to chat A; change its approval mode, but hold the change at the boundary.
  await page
    .getByRole('button', { name: /^chat a,/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'chat a' })).toBeVisible();
  const held = await hold(
    page,
    (url, method) => method === 'POST' && url.pathname === `/api/term2/sessions/${chatA}/config`,
  );
  await approvalChip(page).click();
  await page.getByRole('menuitemradio', { name: /Smart auto-approve/ }).click();
  await held.arrived;

  // Switch to chat B while A's change is in flight, then let it finish.
  await page
    .getByRole('button', { name: /^chat b,/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'chat b' })).toBeVisible();
  held.release();
  await page.waitForResponse((response) => new URL(response.url()).pathname === `/api/term2/sessions/${chatA}/config`);
  // Chat B was never changed: it must still show its own mode.
  await expect(approvalChip(page)).toHaveAccessibleName('Approval mode: Ask before tools');
  await page.reload();
  await expect(approvalChip(page)).toHaveAccessibleName('Approval mode: Ask before tools');
});

test('a first send whose chat settings fail does not leave an extra chat behind when sent again', async ({
  page,
  launch,
}) => {
  const prompt = 'start with settings';
  const app = await launch({ scripts: { [prompt]: [{ text: 'started' }] } });
  await openDraftChat(page, app);
  // A pick in a draft is applied to the new chat before its first message.
  await approvalChip(page).click();
  await page.getByRole('menuitemradio', { name: /Smart auto-approve/ }).click();
  let failed = false;
  // The first settings write the draft makes for its new chat fails (a read is a POST too: match the body).
  await page.route('**/api/term2/sessions/**', async (route) => {
    const request = route.request();
    const write =
      /\/api\/term2\/sessions\/[^/]+\/config$/u.test(new URL(request.url()).pathname) &&
      request.method() === 'POST' &&
      (request.postData() ?? '').includes('expectedRevision');
    if (!failed && write) {
      failed = true;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":{"code":"gateway_unavailable","message":"Agent gateway unavailable","retryable":true}}',
      });
      return;
    }
    await route.fallback();
  });

  await send(page, prompt);
  await expect.poll(() => failed).toBe(true);
  // The text is still there to send again.
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  // One conversation was started, so one chat exists.
  expect(await sessionIds(page, app)).toHaveLength(1);
});

test('a chat list that was requested before the first send does not hide the chat it created', async ({
  page,
  launch,
}) => {
  const prompt = 'keep me in the list';
  const app = await launch({ scripts: { [prompt]: [{ text: 'listed' }] } });
  // The page's first chat-list request answers only after the first chat exists.
  const held = await hold(page, (url, method) => method === 'GET' && url.pathname === '/api/agent/sessions');
  await openDraftChat(page, app);
  await held.arrived;
  await send(page, prompt);
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  const list = page.getByRole('region', { name: 'Chats and folders' });
  await expect(list.getByRole('button', { name: new RegExp(`^${prompt},`) }).first()).toBeVisible();
  held.release();
  await page.waitForResponse((response) => new URL(response.url()).pathname === '/api/agent/sessions');
  // The older, empty answer must not remove the chat the page has since created.
  await expect(list.getByRole('button', { name: new RegExp(`^${prompt},`) }).first()).toBeVisible();
});

test('a new chat opens in the folder just chosen, even while another chat is open (#389)', async ({ page, launch }) => {
  const app = await launch({
    folders: ['second-folder'],
    scripts: {
      'first folder chat': [{ text: 'in the first folder' }],
      'second folder chat': [{ text: 'in the second folder' }],
    },
  });
  await openDraftChat(page, app);
  await send(page, 'first folder chat');
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);

  // With that chat open, choose another folder: the new chat is for that folder, not the open chat's.
  await page.getByRole('button', { name: 'Add a folder' }).click();
  await page
    .getByRole('dialog', { name: 'Choose a folder' })
    .getByRole('button', { name: 'Select second-folder' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'New chat' })).toBeVisible();
  await send(page, 'second folder chat');
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  const created = new URL(page.url()).searchParams.get('agentSession');
  const sessions = (await (await page.request.get(`${app.origin}/api/agent/sessions?limit=20`)).json()) as {
    sessions: { id: string; workspaceId: string }[];
  };
  const workspaces = (await (await page.request.get(`${app.origin}/api/agent/workspaces?limit=20`)).json()) as {
    workspaces: { workspaceId: string; label: string }[];
  };
  const folderOf = (id: string | null) =>
    workspaces.workspaces.find(
      (workspace) => workspace.workspaceId === sessions.sessions.find((item) => item.id === id)?.workspaceId,
    )?.label ?? '';
  expect(folderOf(created)).toMatch(/second-folder$/);
});

test('a message cannot be sent before the chat is connected', async ({ page, launch }) => {
  const prompt = 'wait for the stream';
  const app = await launch({ scripts: { first: [{ text: 'one' }], [prompt]: [{ text: 'connected reply' }] } });
  await openDraftChat(page, app);
  await send(page, 'first');
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);

  // Reload with the chat's event stream held: the page has no live connection yet.
  const held = await hold(page, (url, method) => method === 'GET' && url.pathname.endsWith('/events'));
  await page.reload();
  await held.arrived;
  // Nothing can be sent: the composer stays disabled until the stream attaches.
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  held.release();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  await send(page, prompt);
  await expect(turns(page).nth(1).getByRole('button', { name: 'Copy reply' })).toBeVisible();
  expect(app.model.turn(prompt)).toHaveLength(1);
});

/** Two finished chats, `chat a` then `chat b`, with chat A open again (so Back returns to B). Returns A's id. */
async function twoChatsWithAOpen(page: Page, app: Parameters<typeof openDraftChat>[1]) {
  await openDraftChat(page, app);
  await send(page, 'chat a');
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  const chatA = new URL(page.url()).searchParams.get('agentSession')!;
  await page
    .getByRole('button', { name: `New chat in ${app.workspaceName}` })
    .first()
    .click();
  await send(page, 'chat b');
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  await page
    .getByRole('button', { name: /^chat a,/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'chat a' })).toBeVisible();
  await expectNoRunningTurn(page);
  return chatA;
}

test('an edited message whose send resolves after switching chats does not land in the other chat', async ({
  page,
  launch,
}) => {
  const app = await launch({
    scripts: {
      'chat a': [{ text: 'reply a' }],
      'chat b': [{ text: 'reply b' }],
      'edited a': [{ text: 'reply edited' }],
    },
  });
  const chatA = await twoChatsWithAOpen(page, app);
  await turns(page).first().getByRole('button', { name: 'Edit message' }).click();
  await page.getByRole('textbox', { name: 'Edit message' }).fill('edited a');
  // Hold the resent message at the boundary; switch to chat B before it answers.
  const held = await hold(
    page,
    (url, method) => method === 'POST' && url.pathname === `/api/agent/sessions/${chatA}/messages`,
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await held.arrived;
  await page
    .getByRole('button', { name: /^chat b,/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'chat b' })).toBeVisible();
  held.release();
  await page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/agent/sessions/${chatA}/messages`,
  );
  await expectNoRunningTurn(page);
  // Chat B's message box is its own: A's text and A's notice stay out of it.
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  await expect(page.getByText('The chat was rewound, but the message wasn’t sent.')).toHaveCount(0);
});

test('a rewind that restores its prompt after switching chats does not put it in the other chat', async ({
  page,
  launch,
}) => {
  const app = await launch({ scripts: { 'chat a': [{ text: 'reply a' }], 'chat b': [{ text: 'reply b' }] } });
  const chatA = await twoChatsWithAOpen(page, app);
  await page.getByRole('textbox', { name: 'Message' }).fill('/rewind');
  await page
    .getByRole('listbox', { name: 'Quick actions' })
    .getByRole('option', { name: /Rewind conversation/ })
    .click();
  await page
    .getByRole('radio', { name: /chat a/ })
    .first()
    .click();
  const held = await hold(
    page,
    (url, method) => method === 'POST' && url.pathname === `/api/agent/sessions/${chatA}/rewind`,
  );
  await page.getByRole('button', { name: 'Rewind & edit prompt' }).click();
  await held.arrived;
  // The dialog covers the page; the browser's Back button still switches chats.
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('agentSession')).not.toBe(chatA);
  held.release();
  await page.waitForResponse((response) => new URL(response.url()).pathname === `/api/agent/sessions/${chatA}/rewind`);
  // The dialog hides the rest of the page from assistive technology until it closes.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'chat b' })).toBeVisible();
  await expectNoRunningTurn(page);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
});

test('after a tool row finishes, the status line appears once the short delay has passed (#415)', async ({
  page,
  launch,
}) => {
  const prompt = 'read then think';
  const app = await launch({
    files: { 'notes.txt': 'the quick brown fox\n' },
    scripts: {
      // The step after the tool holds before any text, so the turn waits with a finished tool row.
      [prompt]: [{ call: { tool: 'read_file', args: { path: 'notes.txt' } } }, { text: '', hold: 'after-tool' }],
    },
  });
  await openDraftChat(page, app);
  await send(page, prompt);
  await app.model.held('after-tool');
  await expect(turns(page).first().getByRole('button', { name: 'Read 1 file' })).toBeVisible();
  // The status that follows a tool row is held back briefly (the machine's timer), then shown.
  await expect(page.getByRole('status').filter({ hasText: 'Working…' })).toBeVisible();
  app.model.release('after-tool');
  await expectNoRunningTurn(page);
  await expect(page.getByRole('status').filter({ hasText: 'Working…' })).toHaveCount(0);
});

test('the running tasks panel opens and closes only when the user says so, across a background task (#394, #396)', async ({
  page,
  launch,
}) => {
  const prompt = 'start a helper';
  const app = await launch({
    scripts: {
      [prompt]: [
        { call: { tool: 'run_subagent', args: { execution: 'background', role: 'explorer', task: 'look around' } } },
        { text: 'started it' },
      ],
      'look around': [{ text: 'looked around', hold: 'helper' }],
    },
  });
  const closePanel = page.getByRole('button', { name: 'Close running tasks' });
  await openDraftChat(page, app);
  await send(page, prompt);
  await app.model.held('helper');
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  const pill = page.getByRole('button', { name: /1 running/ });
  await expect(pill).toBeVisible();
  // A task starting does not open the panel (#396).
  await expect(closePanel).toHaveCount(0);
  await pill.click();
  await expect(closePanel).toBeVisible();
  // The task finishing does not close it either: it says nothing is running (#394, #396).
  app.model.release('helper');
  await expect(page.getByText('Nothing is running.')).toBeVisible();
  await expect(closePanel).toBeVisible();
  await closePanel.click();
  await expect(closePanel).toHaveCount(0);
});

test('a chat switch closes the rewind dialog it was opened for', async ({ page, launch }) => {
  const app = await launch({ scripts: { 'chat a': [{ text: 'reply a' }], 'chat b': [{ text: 'reply b' }] } });
  await twoChatsWithAOpen(page, app);
  await page.getByRole('textbox', { name: 'Message' }).fill('/rewind');
  await page
    .getByRole('listbox', { name: 'Quick actions' })
    .getByRole('option', { name: /Rewind conversation/ })
    .click();
  await expect(page.getByRole('dialog', { name: 'Rewind conversation' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'chat b' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('editing the first message is sent even when the rewound chat would block a first send', async ({
  page,
  launch,
}) => {
  const app = await launch({ scripts: { 'chat a': [{ text: 'reply a' }], 'edited a': [{ text: 'reply edited' }] } });
  await openDraftChat(page, app);
  await send(page, 'chat a');
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expectNoRunningTurn(page);
  // From now on the catalog does not list the chat's model, which blocks a chat's first message, but not a resend.
  await page.route('**/api/term2/models', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { models: { id: string }[] };
    body.models = body.models.filter((model) => model.id !== 'mock-alpha');
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(turns(page)).toHaveCount(1);
  await expectNoRunningTurn(page);
  await turns(page).first().getByRole('button', { name: 'Edit message' }).click();
  await page.getByRole('textbox', { name: 'Edit message' }).fill('edited a');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // The rewind empties the chat; the edited text still goes, as it did before the rewind.
  await expect(turns(page).first().getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await expect(turns(page).first()).toContainText('edited a');
  await expect(turns(page).first()).toContainText('reply edited');
  expect(app.model.turn('edited a')).toHaveLength(1);
});
