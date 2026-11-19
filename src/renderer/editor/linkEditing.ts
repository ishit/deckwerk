import { TYPING_STYLE_SENTINEL } from '@shared/paragraphs.js';

/**
 * Turning typed and pasted URLs into links, the way chat apps do it.
 *
 * Two gestures, both taken from Slack: pasting a URL while text is selected
 * makes that text the link, and typing a space or Return after a URL links
 * the URL you just finished typing. Nothing else creates a link on its own —
 * a URL sitting mid-sentence is left alone until the author ends it.
 *
 * The explicit command (Cmd/Ctrl+K, the inspector's link button, the text
 * context menu) goes through `linkSelection`, `unlinkSelection` and
 * `insertLinkAtCaret` below: what is selected is exactly what changes, and a
 * bare caret inside a link stands for the whole link.
 *
 * Only `http(s)` and `www.` are recognized. Everything else the clipboard can
 * carry (`mailto:`, `file:`, custom schemes) is stripped from anchors by the
 * paste sanitizer, so linking it here would produce an anchor that silently
 * loses its href on the next paste round-trip.
 *
 * DOM-in, DOM-out like listEditing.ts: the live contenteditable surface is
 * what is being edited, and the caret has to survive the surgery.
 */

/** Blocks a link may never span; a link is an inline run inside one of them. */
const BLOCKS = 'p, div, li, ul, ol, table, tr, td, th, h1, h2, h3, h4, h5, h6,'
  + ' blockquote, pre, figure';

const WHITESPACE = /[\s ]/;

/** The href this text should link to, or null if it is not a URL. */
export function linkHrefForText(text: string): string | null {
  const candidate = text.trim();
  if (!candidate || WHITESPACE.test(candidate)) return null;
  // A scheme is only a link once it has a host: "https://" alone is not one.
  if (/^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(candidate)) return candidate;
  if (/^www\.[^\s/?#.]+\.[^\s/?#.]+(?:[/?#]\S*)?$/i.test(candidate)) return `https://${candidate}`;
  return null;
}

/**
 * Drop the punctuation that ends the sentence rather than the URL.
 *
 * A closing bracket the URL opened itself stays (Wikipedia's
 * "…_(disambiguation)"); one that closes a bracket around the URL does not.
 */
function trimSentencePunctuation(text: string): string {
  let end = text.length;
  while (end > 0) {
    const char = text[end - 1]!;
    if ('.,;:!?\'"'.includes(char)) {
      end -= 1;
      continue;
    }
    const opening = ')]}'.includes(char) ? '([{'[')]}'.indexOf(char)]! : null;
    if (opening) {
      const head = text.slice(0, end);
      const opened = head.split(opening).length - 1;
      const closed = head.split(char).length - 1;
      if (closed > opened) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return text.slice(0, end);
}

/** The anchor around a node, if it lies inside the edited text. */
function enclosingAnchor(node: Node, body: HTMLElement): HTMLAnchorElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const anchor = element?.closest('a') ?? null;
  return anchor && body.contains(anchor) ? anchor : null;
}

function placeCaretAfter(node: Node, selection: Selection): Range {
  const caret = (node.ownerDocument ?? document).createRange();
  caret.setStartAfter(node);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  return caret;
}

/**
 * Make the selected text a link to `href` — the paste-over-a-selection
 * gesture. Returns the anchor, or null when the selection is not something a
 * single link can wrap (empty, spanning paragraphs, already a link).
 */
export function linkifySelection(
  body: HTMLElement,
  selection: Selection,
  href: string,
): HTMLAnchorElement | null {
  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed || !body.contains(range.commonAncestorContainer)) return null;
  if (enclosingAnchor(range.startContainer, body)) return null;
  if (enclosingAnchor(range.endContainer, body)) return null;
  const preview = range.cloneContents();
  if (preview.querySelector(BLOCKS)) return null;
  if (!(preview.textContent ?? '').replaceAll(TYPING_STYLE_SENTINEL, '').trim()) return null;

  const doc = body.ownerDocument ?? document;
  const anchor = doc.createElement('a');
  anchor.setAttribute('href', href);
  const contents = range.extractContents();
  // Nested anchors are not expressible in HTML; the URL just pasted wins.
  for (const nested of [...contents.querySelectorAll('a')].reverse()) {
    nested.replaceWith(...nested.childNodes);
  }
  anchor.appendChild(contents);
  range.insertNode(anchor);
  placeCaretAfter(anchor, selection);
  return anchor;
}

/** A URL the caret has just finished typing, located but not yet linked. */
export type TypedLink = {
  node: Text;
  /** Offsets of the URL itself within `node`. */
  start: number;
  end: number;
  /** Where the caret sits now, so it can be put back after the surgery. */
  caret: number;
  href: string;
};

/**
 * Find the URL the caret has just typed past — called from the space that
 * ended it and from Return. Detection is separate from `applyTypedLink` so
 * the caller can seal the typed run into its own undo entry first.
 */
export function typedLinkAtCaret(
  body: HTMLElement,
  selection: Selection | null,
): TypedLink | null {
  if (!selection?.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (!(node instanceof Text) || !body.contains(node)) return null;
  if (enclosingAnchor(node, body)) return null;
  const caret = range.startOffset;
  const data = node.data;

  // Space arrives with the caret after it, Return with the caret on the URL's
  // last character; skipping the whitespace makes both see the same token.
  let end = caret;
  while (end > 0 && WHITESPACE.test(data[end - 1]!)) end -= 1;
  let start = end;
  while (start > 0 && !WHITESPACE.test(data[start - 1]!)) start -= 1;
  // A pending bold/italic run opens with an invisible sentinel; it is editor
  // plumbing at the head of the typed text, not part of the URL.
  while (start < end && data[start] === TYPING_STYLE_SENTINEL) start += 1;
  const token = data.slice(start, end);
  if (token.includes(TYPING_STYLE_SENTINEL)) return null;
  // The token may continue into the previous run (a URL typed half in bold).
  // What is in this node is then only its tail — and a truncated URL still
  // parses as one, so refuse rather than link the wrong address.
  if (start === 0) {
    const before = node.previousSibling?.textContent ?? '';
    if (before && !WHITESPACE.test(before[before.length - 1]!)) return null;
  }

  const text = trimSentencePunctuation(token);
  const href = linkHrefForText(text);
  if (!href) return null;
  return { node, start, end: start + text.length, caret, href };
}

/** Wrap a located URL in an anchor, leaving the caret where it was. */
export function applyTypedLink(link: TypedLink, selection: Selection): HTMLAnchorElement {
  const { node, start, end, caret } = link;
  const doc = node.ownerDocument ?? document;
  const url = start > 0 ? node.splitText(start) : node;
  const tail = end - start < url.data.length ? url.splitText(end - start) : null;
  const anchor = doc.createElement('a');
  anchor.setAttribute('href', link.href);
  url.replaceWith(anchor);
  anchor.appendChild(url);
  if (tail) {
    const range = doc.createRange();
    range.setStart(tail, Math.max(0, Math.min(caret - end, tail.data.length)));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    placeCaretAfter(anchor, selection);
  }
  return anchor;
}

/** What the author typed into the link field, as an href or a reason it is not one. */
export type LinkInput = { href: string } | { error: string };

/**
 * Read a typed address the way a browser's address bar does: `example.com`
 * means `https://example.com`. Only web addresses are accepted — the
 * presentation opens nothing else, and the paste sanitizer strips any other
 * scheme from an anchor, so a `mailto:` link would not survive a copy.
 */
export function normalizeLinkInput(raw: string): LinkInput {
  const text = raw.trim();
  if (!text) return { error: 'Enter a web address.' };
  if (WHITESPACE.test(text)) return { error: 'A web address cannot contain spaces.' };
  let candidate = text;
  const schemeless = !/^https?:\/\//i.test(candidate);
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (schemeless) {
    // `localhost:3000` is a host and a port, not a scheme.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(candidate)) {
      return { error: 'Only web addresses (http:// or https://) can be linked.' };
    }
    candidate = `https://${candidate}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { error: 'That is not a web address.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Only web addresses (http:// or https://) can be linked.' };
  }
  // Without a scheme, a word with no dot ("hello") is far likelier to be a
  // slip than an intranet host; with one typed out, take the host as given.
  const host = url.hostname;
  if (!host || (schemeless && !host.includes('.') && host !== 'localhost' && !host.startsWith('['))) {
    return { error: 'That is not a web address.' };
  }
  return { href: candidate };
}

/** Where a selection sits relative to the links in a text box. */
export interface SelectionLinks {
  /**
   * The link a bare caret is inside: the command edits or removes all of it.
   * Null for an expanded selection, which only ever changes what it covers.
   */
  caretLink: HTMLAnchorElement | null;
  /** Every link at least one selected character belongs to. */
  covered: HTMLAnchorElement[];
  /** The address to offer for editing: the caret's link, else the first covered. */
  href: string | null;
}

/** The anchors inside `body` that hold selected characters, in document order. */
function coveredAnchors(body: HTMLElement, range: Range): HTMLAnchorElement[] {
  if (range.collapsed) return [];
  const doc = body.ownerDocument ?? document;
  return [...body.querySelectorAll<HTMLAnchorElement>('a')].filter((anchor) => {
    const inner = doc.createRange();
    inner.selectNodeContents(anchor);
    // Clamp the selection to the anchor; a zero-width touch at its edge does
    // not count as covering it.
    if (range.compareBoundaryPoints(Range.START_TO_START, inner) > 0) {
      inner.setStart(range.startContainer, range.startOffset);
    }
    if (range.compareBoundaryPoints(Range.END_TO_END, inner) < 0) {
      inner.setEnd(range.endContainer, range.endOffset);
    }
    return !inner.collapsed
      && inner.toString().replaceAll(TYPING_STYLE_SENTINEL, '').length > 0;
  });
}

export function selectionLinks(body: HTMLElement, range: Range): SelectionLinks {
  if (!body.contains(range.commonAncestorContainer)) {
    return { caretLink: null, covered: [], href: null };
  }
  if (range.collapsed) {
    const caretLink = enclosingAnchor(range.startContainer, body);
    return {
      caretLink,
      covered: caretLink ? [caretLink] : [],
      href: caretLink?.getAttribute('href') ?? null,
    };
  }
  const covered = coveredAnchors(body, range);
  return { caretLink: null, covered, href: covered[0]?.getAttribute('href') ?? null };
}

/** Text nodes no run of prose lives in: indentation between blocks. */
const STRUCTURAL_PARENTS = 'ul, ol, table, thead, tbody, tfoot, tr, colgroup';

/**
 * The text nodes a range selects, each split so that it lies wholly inside
 * the range. Whitespace that only formats the markup (between list items,
 * between table rows) is not prose and is left out.
 */
function isolateSelectedText(body: HTMLElement, range: Range): Text[] {
  const doc = body.ownerDocument ?? document;
  const { startContainer, startOffset, endContainer, endOffset } = range;
  const texts: Text[] = [];
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    if (!range.intersectsNode(text)) continue;
    const start = text === startContainer ? startOffset : 0;
    const end = text === endContainer ? endOffset : text.data.length;
    if (end <= start) continue;
    texts.push(text);
  }
  const isolated: Text[] = [];
  for (const text of texts) {
    let node = text;
    const end = text === endContainer ? endOffset : node.data.length;
    if (end < node.data.length) node.splitText(end);
    const start = text === startContainer ? startOffset : 0;
    if (start > 0) node = node.splitText(start);
    const parent = node.parentElement;
    if (parent && (parent === body || parent.matches(STRUCTURAL_PARENTS))
      && !node.data.replace(/[\s⁠]/g, '')) continue;
    isolated.push(node);
  }
  return isolated;
}

/** Drop inline wrappers a split left with nothing to show. */
function removeEmptyInlines(root: ParentNode): void {
  for (const element of [...root.querySelectorAll<HTMLElement>('*')].reverse()) {
    if (element.matches(`${BLOCKS}, br, img, svg, video, hr`)) continue;
    if (element.querySelector('br, img, svg, video, hr')) continue;
    if (element.textContent) continue;
    element.remove();
  }
}

/** A fragment holds something worth keeping: text, or a break or picture. */
function fragmentHasContent(fragment: DocumentFragment): boolean {
  return Boolean(fragment.textContent) || Boolean(fragment.querySelector('br, img, svg, video'));
}

/**
 * Take the selected text out of every link it is in. A link that runs past
 * the selection is split, so the part outside keeps its address.
 */
function unlinkTexts(body: HTMLElement, texts: Text[]): void {
  const doc = body.ownerDocument ?? document;
  for (const anchor of [...body.querySelectorAll<HTMLAnchorElement>('a')]) {
    const inside = texts.filter((text) => anchor.contains(text));
    if (inside.length === 0) continue;
    const first = inside[0]!;
    const last = inside[inside.length - 1]!;
    // Everything from the last selected character to the anchor's end keeps
    // the link, in a copy of the anchor placed after it.
    const tail = doc.createRange();
    tail.setStartAfter(last);
    tail.setEnd(anchor, anchor.childNodes.length);
    if (!tail.collapsed) {
      const rest = tail.extractContents();
      removeEmptyInlines(rest);
      if (fragmentHasContent(rest)) {
        const after = anchor.cloneNode(false) as HTMLAnchorElement;
        after.appendChild(rest);
        anchor.after(after);
      }
    }
    const head = doc.createRange();
    head.setStart(anchor, 0);
    head.setEndBefore(first);
    if (!head.collapsed) {
      const rest = head.extractContents();
      removeEmptyInlines(rest);
      if (fragmentHasContent(rest)) {
        const before = anchor.cloneNode(false) as HTMLAnchorElement;
        before.appendChild(rest);
        anchor.before(before);
      }
    }
    // What is left holds only selected text (and the wrappers around it).
    removeEmptyInlines(anchor);
    anchor.replaceWith(...anchor.childNodes);
  }
}

/** Fold a link into an identical neighbour, so one address reads as one link. */
function mergeWithNeighbours(anchor: HTMLAnchorElement): HTMLAnchorElement {
  const href = anchor.getAttribute('href');
  const previous = anchor.previousSibling;
  let merged = anchor;
  if (previous instanceof HTMLAnchorElement && previous.getAttribute('href') === href
    && previous.attributes.length === anchor.attributes.length) {
    previous.append(...anchor.childNodes);
    anchor.remove();
    merged = previous;
  }
  const next = merged.nextSibling;
  if (next instanceof HTMLAnchorElement && next.getAttribute('href') === href
    && next.attributes.length === merged.attributes.length) {
    merged.append(...next.childNodes);
    next.remove();
  }
  return merged;
}

/**
 * Link exactly the selected text to `href`, whatever it was linked to before.
 * A selection across several paragraphs or list items gets one link per
 * line, since a link is an inline run inside a block. The text itself is not
 * changed, so the caller can restore the selection by character offsets.
 * Returns the links made (empty when nothing linkable was selected).
 */
export function linkSelection(body: HTMLElement, range: Range, href: string): HTMLAnchorElement[] {
  if (range.collapsed || !body.contains(range.commonAncestorContainer)) return [];
  const texts = isolateSelectedText(body, range);
  if (!texts.some((text) => text.data.replaceAll(TYPING_STYLE_SENTINEL, '').trim())) return [];
  unlinkTexts(body, texts);

  // Consecutive selected text in the same block is one run, and one link.
  const runs: Text[][] = [];
  let block: Element | null | undefined;
  for (const text of texts) {
    const own = text.parentElement?.closest(BLOCKS) ?? null;
    const holder = own && body.contains(own) ? own : null;
    if (runs.length === 0 || holder !== block) runs.push([]);
    runs[runs.length - 1]!.push(text);
    block = holder;
  }

  const doc = body.ownerDocument ?? document;
  const made: HTMLAnchorElement[] = [];
  for (const run of runs) {
    if (!run.some((text) => text.data.replaceAll(TYPING_STYLE_SENTINEL, '').trim())) continue;
    const span = doc.createRange();
    span.setStartBefore(run[0]!);
    span.setEndAfter(run[run.length - 1]!);
    const contents = span.extractContents();
    for (const nested of [...contents.querySelectorAll('a')].reverse()) {
      nested.replaceWith(...nested.childNodes);
    }
    removeEmptyInlines(contents);
    const anchor = doc.createElement('a');
    anchor.setAttribute('href', href);
    anchor.appendChild(contents);
    span.insertNode(anchor);
    made.push(anchor);
  }
  // Wrappers the extraction split and emptied, beside the new links.
  for (const anchor of made) {
    for (const sibling of [anchor.previousSibling, anchor.nextSibling]) {
      if (sibling instanceof HTMLElement && !sibling.matches(`${BLOCKS}, br, img, svg, video, hr`)
        && !sibling.textContent && !sibling.querySelector('br, img, svg, video, hr')) {
        sibling.remove();
      }
    }
  }
  return made.map(mergeWithNeighbours);
}

/**
 * Remove links: from exactly the selected text, or — for a bare caret — the
 * whole link it is in. Returns whether anything changed. The text is not
 * changed, so the caller can restore the selection by character offsets.
 */
export function unlinkSelection(body: HTMLElement, range: Range): boolean {
  if (!body.contains(range.commonAncestorContainer)) return false;
  if (range.collapsed) {
    const anchor = enclosingAnchor(range.startContainer, body);
    if (!anchor) return false;
    anchor.replaceWith(...anchor.childNodes);
    return true;
  }
  if (coveredAnchors(body, range).length === 0) return false;
  unlinkTexts(body, isolateSelectedText(body, range));
  return true;
}

/**
 * Insert `text` linked to `href` at a bare caret that is not in a link, and
 * put the caret after it. Returns the new link.
 */
export function insertLinkAtCaret(
  body: HTMLElement,
  range: Range,
  href: string,
  text: string,
): HTMLAnchorElement | null {
  if (!range.collapsed || !body.contains(range.commonAncestorContainer)) return null;
  if (enclosingAnchor(range.startContainer, body) || !text) return null;
  const doc = body.ownerDocument ?? document;
  const anchor = doc.createElement('a');
  anchor.setAttribute('href', href);
  anchor.textContent = text;
  const at = range.startContainer;
  if (at instanceof Text) {
    const tail = at.splitText(range.startOffset);
    tail.before(anchor);
    if (!tail.data) tail.remove();
  } else {
    // A caret on an empty line sits before its placeholder <br>; the link
    // takes the line's place and the break is no longer needed.
    const child = at.childNodes[range.startOffset] ?? null;
    if (child instanceof HTMLBRElement && !child.nextSibling
      && ![...at.childNodes].some((node) => node !== child && node.textContent)) {
      child.replaceWith(anchor);
    } else {
      at.insertBefore(anchor, child);
    }
  }
  return anchor;
}
