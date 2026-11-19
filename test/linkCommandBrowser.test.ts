import { afterAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import {
  BOX_B,
  CONTENT_B,
  MOD,
  startUndoSession,
  type Snapshot,
  type UndoSession,
} from './support/undoRestorationSession.js';

/**
 * The explicit link command: Cmd/Ctrl+K, the inspector's link button and the
 * text context menu all open one form that adds, changes or removes the link
 * on the text being edited.
 *
 * Every gesture is real input (CDP key and pointer events), and the oracle is
 * the html the collaboration server persisted — what the author gets back.
 * BOX_B starts as `<p>first paragraph</p><p>second paragraph</p>`.
 */

const POPOVER = '.link-popover';
const HREF_FIELD = `${POPOVER} input[name="link-href"]`;
const TEXT_FIELD = `${POPOVER} input[name="link-text"]`;

let closeSession: (() => Promise<void>) | null = null;

describe.skipIf(!electronBinary)('link command', () => {
  let session: UndoSession;

  afterAll(async () => {
    await closeSession?.();
  });

  async function start(): Promise<void> {
    if (session) return;
    const started = await startUndoSession('link-command', 'Links');
    session = started.session;
    closeSession = started.close;
    // Record what would open in the browser instead of opening it.
    await session.cdp.evaluate(`(() => {
      window.__opened = [];
      window.open = (...args) => { window.__opened.push(String(args[0])); return null; };
      return true;
    })()`);
  }

  function htmlOf(snapshot: Snapshot): string {
    return (JSON.parse(snapshot[`0:${BOX_B}`]!) as { html: string }).html;
  }

  async function persisted(label: string): Promise<string> {
    return htmlOf(await session.settle(label));
  }

  async function opened(): Promise<string[]> {
    return session.cdp.evaluate<string[]>('window.__opened.splice(0)');
  }

  async function popoverOpen(): Promise<boolean> {
    return session.cdp.evaluate<boolean>(`Boolean(document.querySelector('${POPOVER}'))`);
  }

  async function focused(selector: string): Promise<boolean> {
    return session.cdp.evaluate<boolean>(
      `document.activeElement === document.querySelector(${JSON.stringify(selector)})`);
  }

  async function selectedText(): Promise<string> {
    const value = await session.cdp.evaluate<string>('window.getSelection()?.toString() ?? ""');
    return value.replaceAll('⁠', '');
  }

  async function commandK(): Promise<void> {
    await session.cdp.chord('k', 'KeyK', 75, MOD);
    await eventually(async () => popoverOpen(), 'Cmd/Ctrl+K did not open the link form');
  }

  /**
   * A point on the second character of `word` in the box, for clicks — of
   * its first occurrence, or with `inLink` of the one inside a link.
   */
  async function pointIn(word: string, options: { fraction?: number; inLink?: boolean } = {}): Promise<{ x: number; y: number }> {
    return session.cdp.evaluate<{ x: number; y: number }>(`(() => {
      const root = document.querySelector(${JSON.stringify(CONTENT_B)});
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (${JSON.stringify(options.inLink ?? false)} && !node.parentElement.closest('a')) continue;
        const index = node.data.indexOf(${JSON.stringify(word)});
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index + 1);
        range.setEnd(node, index + 2);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width * ${options.fraction ?? 0.5}, y: rect.top + rect.height / 2 };
      }
      throw new Error('no ' + ${JSON.stringify(word)} + ' in the box');
    })()`);
  }

  it('links the selected words with Cmd/Ctrl+K, and one undo takes the link back', {
    timeout: 120_000,
  }, async () => {
    await start();
    await session.edit(CONTENT_B);
    await session.cdp.selectTextRange(CONTENT_B, 0, 5);
    expect(await selectedText()).toBe('first');

    await commandK();
    expect(await focused(HREF_FIELD), 'the form takes the keyboard').toBe(true);
    expect(await session.cdp.evaluate<boolean>(`!document.querySelector('${TEXT_FIELD}')`),
      'linking a selection does not ask for its words').toBe(true);
    await session.cdp.typeKeys('example.com/docs');
    await session.cdp.key('Enter', 13);

    expect(await popoverOpen()).toBe(false);
    expect(await persisted('after linking')).toBe(
      '<p><a href="https://example.com/docs">first</a> paragraph</p><p>second paragraph</p>');
    // The author is back in the text with the same words selected.
    expect(await session.editing(CONTENT_B)).toBe(true);
    expect(await focused(CONTENT_B), 'focus went back to the text').toBe(true);
    expect(await selectedText()).toBe('first');

    await session.undo();
    expect(await persisted('after undo')).toBe('<p>first paragraph</p><p>second paragraph</p>');
  });

  it('edits the whole link under a bare caret, and removes it', { timeout: 120_000 }, async () => {
    await start();
    await session.edit(CONTENT_B);
    await session.cdp.selectTextRange(CONTENT_B, 15, 21);
    expect(await selectedText()).toBe('second');
    await commandK();
    await session.cdp.typeKeys('a.test');
    await session.cdp.key('Enter', 13);
    expect(await persisted('linked')).toBe(
      '<p>first paragraph</p><p><a href="https://a.test">second</a> paragraph</p>');

    // A plain click on a link being edited places the caret; it opens nothing.
    await opened();
    const inside = await pointIn('second', { inLink: true });
    await session.cdp.clickAt(inside.x, inside.y);
    await wait(150);
    expect(await opened(), 'a plain click opened the link').toEqual([]);
    expect(await session.editing(CONTENT_B)).toBe(true);

    await commandK();
    expect(await session.cdp.evaluate<string>(`document.querySelector('${HREF_FIELD}').value`))
      .toBe('https://a.test');
    // The address is selected, so typing replaces it.
    await session.cdp.typeKeys('b.test/new');
    await session.cdp.key('Enter', 13);
    expect(await persisted('retargeted')).toBe(
      '<p>first paragraph</p><p><a href="https://b.test/new">second</a> paragraph</p>');

    await commandK();
    await session.cdp.clickByText(`${POPOVER} button`, 'Remove link');
    expect(await popoverOpen()).toBe(false);
    expect(await persisted('unlinked')).toBe('<p>first paragraph</p><p>second paragraph</p>');
    expect(await session.editing(CONTENT_B)).toBe(true);
  });

  it('asks for the words at a bare caret, and what is typed next is not linked', {
    timeout: 120_000,
  }, async () => {
    await start();
    await session.edit(CONTENT_B);
    const end = await pointIn('paragraph');
    await session.cdp.clickAt(end.x, end.y);
    await session.cdp.key('End', 35);
    await session.cdp.typeKeys(' see');
    await session.cdp.typeKeys(' ');

    await commandK();
    expect(await focused(TEXT_FIELD), 'the words come first').toBe(true);
    await session.cdp.typeKeys('docs');
    await session.cdp.key('Tab', 9);
    expect(await focused(HREF_FIELD)).toBe(true);
    await session.cdp.typeKeys('docs.example.com');
    await session.cdp.key('Enter', 13);
    await session.cdp.typeKeys('!');
    // Typed text reaches the deck when its run seals.
    await session.seal();

    expect(await persisted('inserted')).toBe(
      '<p>first paragraph see <a href="https://docs.example.com">docs</a>!</p><p>second paragraph</p>');
  });

  it('refuses an address the deck cannot open, and Escape goes back to the text', {
    timeout: 120_000,
  }, async () => {
    await start();
    await session.edit(CONTENT_B);
    const before = await persisted('before');
    await session.cdp.selectTextRange(CONTENT_B, 0, 5);
    await commandK();
    await session.cdp.typeKeys('mailto:me@example.com');
    await session.cdp.key('Enter', 13);
    expect(await popoverOpen(), 'an unusable address closed the form').toBe(true);
    expect(await session.cdp.evaluate<string>(
      `document.querySelector('${POPOVER} .link-popover-problem').textContent`)).toMatch(/web address/);

    await session.cdp.key('Escape', 27);
    expect(await popoverOpen()).toBe(false);
    expect(await session.editing(CONTENT_B), 'Escape in the form ended the text edit').toBe(true);
    expect(await focused(CONTENT_B)).toBe(true);
    expect(await selectedText()).toBe('first');
    expect(await persisted('after escape')).toBe(before);
  });

  it('reaches the same form from the inspector and the context menu', { timeout: 120_000 }, async () => {
    await start();
    await session.edit(CONTENT_B);
    // The last word of the box, wherever earlier cases left it.
    const at = await session.cdp.evaluate<number>(
      `document.querySelector(${JSON.stringify(CONTENT_B)}).textContent.lastIndexOf('paragraph')`);
    await session.cdp.selectTextRange(CONTENT_B, at, at + 'paragraph'.length);
    expect(await selectedText()).toBe('paragraph');
    await session.cdp.click('.text-format-link', 'inspector link button');
    await eventually(async () => popoverOpen(), 'the link button did not open the form');
    await session.cdp.typeKeys('c.test');
    await session.cdp.key('Enter', 13);
    const linked = await persisted('linked from the inspector');
    expect(linked).toContain('<a href="https://c.test">paragraph</a>');
    await eventually(async () => session.cdp.evaluate<boolean>(
      `document.querySelector('.text-format-link')?.getAttribute('aria-pressed') === 'true'`),
    'the link button does not show the selection is linked');

    // Cmd/Ctrl+click opens it.
    await opened();
    const inside = await pointIn('paragraph', { inLink: true });
    await session.cdp.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: inside.x, y: inside.y, button: 'left', buttons: 1, clickCount: 1, modifiers: MOD,
    });
    await session.cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: inside.x, y: inside.y, button: 'left', buttons: 0, clickCount: 1, modifiers: MOD,
    });
    await eventually(async () => (await session.cdp.evaluate<number>('window.__opened.length')) > 0,
      'Cmd/Ctrl+click did not open the link');
    expect(await opened()).toEqual(['https://c.test/']);

    await session.cdp.rightClickAt(inside.x, inside.y);
    const labels = await session.cdp.evaluate<string[]>(
      `[...document.querySelectorAll('#ctx-menu button')].map((row) => row.textContent)`);
    expect(labels).toEqual(expect.arrayContaining(['Edit link…', 'Open link', 'Remove link']));
    await session.cdp.clickByText('#ctx-menu button', 'Open link');
    expect(await opened()).toEqual(['https://c.test']);

    await session.cdp.rightClickAt(inside.x, inside.y);
    await session.cdp.clickByText('#ctx-menu button', 'Remove link');
    const unlinked = await persisted('unlinked from the menu');
    expect(unlinked).not.toContain('https://c.test');
    expect(unlinked).toBe(linked.replace('<a href="https://c.test">paragraph</a>', 'paragraph'));
  });

  it('selects and edits a linked box with plain clicks, opening nothing', { timeout: 120_000 }, async () => {
    await start();
    // Link the whole box, so no click can land on unlinked text.
    await session.edit(CONTENT_B);
    await session.cdp.chord('a', 'KeyA', 65, MOD);
    await commandK();
    await session.cdp.typeKeys('x.test');
    await session.cdp.key('Enter', 13);
    await persisted('whole box linked');
    expect(await session.cdp.evaluate<boolean>(`(() => {
      const root = document.querySelector(${JSON.stringify(CONTENT_B)});
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.data.replaceAll('\u2060', '').trim() && !node.parentElement.closest('a')) return false;
      }
      return true;
    })()`), 'select-all and Cmd/Ctrl+K left words unlinked').toBe(true);
    await session.cdp.key('Escape', 27);
    await eventually(async () => !(await session.editing(CONTENT_B)), 'Escape did not end the edit');
    await opened();

    // A plain click on the link selects its box, as on any text.
    const inside = await pointIn('paragraph', { inLink: true });
    await session.cdp.evaluate('window.store.select([])');
    await session.cdp.clickAt(inside.x, inside.y);
    await wait(250);
    expect(await session.cdp.evaluate<string[]>('[...window.store.get().selection]')).toEqual([BOX_B]);
    expect(await opened(), 'a plain click on a link in the editor opened it').toEqual([]);

    // A double-click on it edits the text.
    await session.cdp.doubleClickAt(inside.x, inside.y);
    await eventually(async () => session.editing(CONTENT_B), 'double-clicking a link did not edit its box');
    expect(await opened(), 'double-clicking a link opened it').toEqual([]);
    await session.undo();
  });
});

describe.skipIf(electronBinary)('link command (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
