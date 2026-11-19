// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  insertLinkAtCaret,
  linkSelection,
  normalizeLinkInput,
  selectionLinks,
  unlinkSelection,
} from '../src/renderer/editor/linkEditing.js';

/** A box whose html is `html`, with `[` and `]` marking the selection (or `|` a caret). */
function box(marked: string): { body: HTMLElement; range: Range } {
  const body = document.createElement('div');
  document.body.replaceChildren(body);
  body.innerHTML = marked;
  const range = document.createRange();
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const marks: Array<{ node: Text; offset: number; mark: string }> = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    for (let index = text.data.search(/[[\]|]/); index >= 0; index = text.data.search(/[[\]|]/)) {
      marks.push({ node: text, offset: index, mark: text.data[index]! });
      text.deleteData(index, 1);
    }
  }
  const caret = marks.find((mark) => mark.mark === '|');
  if (caret) {
    range.setStart(caret.node, caret.offset);
    range.collapse(true);
  } else {
    const open = marks.find((mark) => mark.mark === '[')!;
    const close = marks.find((mark) => mark.mark === ']')!;
    range.setStart(open.node, open.offset);
    range.setEnd(close.node, close.offset);
  }
  return { body, range };
}

describe('normalizeLinkInput', () => {
  it('reads a bare address the way an address bar does', () => {
    expect(normalizeLinkInput('example.com')).toEqual({ href: 'https://example.com' });
    expect(normalizeLinkInput('  www.example.com/a?b=1#c ')).toEqual({ href: 'https://www.example.com/a?b=1#c' });
    expect(normalizeLinkInput('localhost:3000/x')).toEqual({ href: 'https://localhost:3000/x' });
    expect(normalizeLinkInput('//cdn.example.com/a')).toEqual({ href: 'https://cdn.example.com/a' });
  });

  it('keeps an address typed with its scheme as written', () => {
    expect(normalizeLinkInput('http://intranet/wiki')).toEqual({ href: 'http://intranet/wiki' });
    expect(normalizeLinkInput('HTTPS://Example.com/Path')).toEqual({ href: 'HTTPS://Example.com/Path' });
  });

  it('refuses what the presentation could not open', () => {
    for (const refused of ['', '   ', 'hello', 'two words.com', 'mailto:a@b.com',
      'javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com']) {
      expect(normalizeLinkInput(refused), refused).toHaveProperty('error');
    }
  });
});

describe('selectionLinks', () => {
  it('names the link a bare caret is in', () => {
    const { body, range } = box('<p>see <a href="https://a.test">the d|ocs</a> here</p>');
    const found = selectionLinks(body, range);
    expect(found.caretLink?.textContent).toBe('the docs');
    expect(found.href).toBe('https://a.test');
  });

  it('counts only links a selection actually covers characters of', () => {
    const { body, range } = box('<p><a href="https://a.test">one</a>[ two ]<a href="https://b.test">three</a></p>');
    expect(selectionLinks(body, range).covered).toEqual([]);
    const second = box('<p><a href="https://a.test">o[ne</a> two <a href="https://b.test">th]ree</a></p>');
    expect(selectionLinks(second.body, second.range).covered.map((a) => a.getAttribute('href')))
      .toEqual(['https://a.test', 'https://b.test']);
    expect(selectionLinks(second.body, second.range).caretLink).toBeNull();
  });
});

describe('linkSelection', () => {
  it('links exactly the selected words, through inline formatting', () => {
    const { body, range } = box('<p>read <b>the [fine</b> manual] now</p>');
    const made = linkSelection(body, range, 'https://m.test');
    expect(made).toHaveLength(1);
    expect(body.innerHTML).toBe('<p>read <b>the </b><a href="https://m.test"><b>fine</b> manual</a> now</p>');
  });

  it('relinks part of a link and leaves the rest on its old address', () => {
    const { body, range } = box('<p><a href="https://old.test">alpha [beta] gamma</a></p>');
    linkSelection(body, range, 'https://new.test');
    expect(body.innerHTML).toBe('<p><a href="https://old.test">alpha </a><a href="https://new.test">beta</a>'
      + '<a href="https://old.test"> gamma</a></p>');
  });

  it('replaces every link the selection runs across', () => {
    const { body, range } = box('<p><a href="https://a.test">o[ne</a> two <a href="https://b.test">th]ree</a></p>');
    linkSelection(body, range, 'https://c.test');
    expect(body.innerHTML).toBe('<p><a href="https://a.test">o</a><a href="https://c.test">ne two th</a>'
      + '<a href="https://b.test">ree</a></p>');
  });

  it('makes one link per line across paragraphs and list items', () => {
    const { body, range } = box('<ul>\n  <li>fi[rst</li>\n  <li>second</li>\n  <li>th]ird</li>\n</ul>');
    const made = linkSelection(body, range, 'https://l.test');
    expect(made).toHaveLength(3);
    expect(body.innerHTML).toBe('<ul>\n  <li>fi<a href="https://l.test">rst</a></li>\n'
      + '  <li><a href="https://l.test">second</a></li>\n  <li><a href="https://l.test">th</a>ird</li>\n</ul>');
  });

  it('joins a link to an identical neighbour', () => {
    const { body, range } = box('<p><a href="https://a.test">one</a>[ two] three</p>');
    linkSelection(body, range, 'https://a.test');
    expect(body.innerHTML).toBe('<p><a href="https://a.test">one two</a> three</p>');
  });

  it('leaves the text itself alone, so the selection can be restored by offsets', () => {
    const { body, range } = box('<p>a <i>b[c</i> d</p><p>e] f</p>');
    const before = body.textContent;
    linkSelection(body, range, 'https://x.test');
    expect(body.textContent).toBe(before);
  });

  it('does nothing for a selection with no characters in it', () => {
    const { body, range } = box('<p>a[ ]b</p>');
    expect(linkSelection(body, range, 'https://x.test')).toEqual([]);
    expect(body.innerHTML).toBe('<p>a b</p>');
  });
});

describe('unlinkSelection', () => {
  it('removes the whole link around a bare caret', () => {
    const { body, range } = box('<p>see <a href="https://a.test">the <b>d|ocs</b></a> here</p>');
    expect(unlinkSelection(body, range)).toBe(true);
    expect(body.innerHTML).toBe('<p>see the <b>docs</b> here</p>');
  });

  it('removes a link from exactly the selected text', () => {
    const { body, range } = box('<p><a href="https://a.test">alpha [beta] gamma</a></p>');
    expect(unlinkSelection(body, range)).toBe(true);
    expect(body.innerHTML).toBe('<p><a href="https://a.test">alpha </a>beta<a href="https://a.test"> gamma</a></p>');
  });

  it('reports no change where there is no link', () => {
    const { body, range } = box('<p>plain [text]</p>');
    expect(unlinkSelection(body, range)).toBe(false);
    const caret = box('<p>pla|in</p>');
    expect(unlinkSelection(caret.body, caret.range)).toBe(false);
  });
});

describe('insertLinkAtCaret', () => {
  it('puts linked text at the caret', () => {
    const { body, range } = box('<p>go to | now</p>');
    const anchor = insertLinkAtCaret(body, range, 'https://example.com', 'example.com');
    expect(anchor?.textContent).toBe('example.com');
    expect(body.innerHTML).toBe('<p>go to <a href="https://example.com">example.com</a> now</p>');
  });

  it('takes the place of an empty line’s placeholder break', () => {
    const body = document.createElement('div');
    document.body.replaceChildren(body);
    body.innerHTML = '<p><br></p>';
    const range = document.createRange();
    range.setStart(body.firstChild!, 0);
    range.collapse(true);
    insertLinkAtCaret(body, range, 'https://example.com', 'example');
    expect(body.innerHTML).toBe('<p><a href="https://example.com">example</a></p>');
  });

  it('never nests a link inside another', () => {
    const { body, range } = box('<p><a href="https://a.test">in|side</a></p>');
    expect(insertLinkAtCaret(body, range, 'https://b.test', 'b')).toBeNull();
  });
});
