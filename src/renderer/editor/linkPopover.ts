import { normalizeLinkInput } from './linkEditing.js';
import { closePopover, isPopoverOpen, openPopoverAtRect } from './ui.js';

/**
 * The small form that adds, changes and removes a link on the text being
 * edited — Cmd/Ctrl+K, the inspector's link button and the text context menu
 * all open it. It only collects an address; the canvas owns the text, the
 * selection and the undo entry, through the callbacks.
 *
 * Its class is in TEXT_EDIT_PANEL_CHROME (keptSelection.ts), so moving focus
 * into its field keeps the edit live and the selected words highlighted.
 */

export const LINK_POPOVER_CLASS = 'link-popover';

export interface LinkPopoverRequest {
  /** Where on screen the text it is about sits; it opens below (or above). */
  rect: Pick<DOMRect, 'left' | 'top' | 'bottom'>;
  /** The control that asked for it, when one did. */
  trigger?: HTMLElement | null;
  /** The address already there, offered for editing. */
  href: string | null;
  /** Whether there is a link here to remove. */
  canRemove: boolean;
  /** A bare caret outside any link: ask for the words to link as well. */
  askText: boolean;
  onApply(href: string, text: string | null): void;
  onRemove(): void;
  onOpen(href: string): void;
  /** Escape: nothing changes, and the author goes back to the text. */
  onCancel(): void;
}

let open: HTMLElement | null = null;

/** Whether the link form is showing. */
export function linkPopoverOpen(): boolean {
  return open !== null && isPopoverOpen(open);
}

function field(label: string, input: HTMLInputElement): HTMLLabelElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  const caption = document.createElement('span');
  caption.textContent = label;
  wrapper.append(caption, input);
  return wrapper;
}

function textInput(name: string, value: string, placeholder: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.name = name;
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  return input;
}

function actionButton(label: string, className: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', action);
  return node;
}

export function openLinkPopover(request: LinkPopoverRequest): HTMLElement {
  const popover = document.createElement('div');
  popover.className = LINK_POPOVER_CLASS;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', request.href ? 'Edit link' : 'Add link');

  const words = request.askText ? textInput('link-text', '', 'Defaults to the address') : null;
  const address = textInput('link-href', request.href ?? '', 'example.com or https://…');
  address.setAttribute('aria-describedby', 'link-popover-problem');
  if (words) popover.appendChild(field('Text', words));
  popover.appendChild(field('Link', address));

  const problem = document.createElement('div');
  problem.id = 'link-popover-problem';
  problem.className = 'link-popover-problem';
  problem.setAttribute('role', 'alert');
  popover.appendChild(problem);

  const finish = (then: () => void) => {
    closePopover();
    open = null;
    then();
  };
  const apply = () => {
    const parsed = normalizeLinkInput(address.value);
    if ('error' in parsed) {
      problem.textContent = parsed.error;
      address.setAttribute('aria-invalid', 'true');
      address.focus();
      address.select();
      return;
    }
    const text = words ? (words.value.trim() || address.value.trim()) : null;
    finish(() => request.onApply(parsed.href, text));
  };

  const actions = document.createElement('div');
  actions.className = 'button-row link-popover-actions';
  if (request.href) {
    const href = request.href;
    const visit = actionButton('Open', 'link-popover-open', () => request.onOpen(href));
    visit.title = `Open ${href} in your browser`;
    actions.appendChild(visit);
  }
  if (request.canRemove) {
    actions.appendChild(actionButton('Remove link', 'link-popover-remove danger', () => finish(request.onRemove)));
  }
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  actions.appendChild(spacer);
  actions.appendChild(actionButton('Apply', 'primary link-popover-apply', apply));
  popover.appendChild(actions);

  address.addEventListener('input', () => {
    problem.textContent = '';
    address.removeAttribute('aria-invalid');
  });
  popover.addEventListener('keydown', (event) => {
    // The form's keys are the form's: nothing here reaches the canvas or the
    // shell's shortcuts (Delete, arrows, Cmd/Ctrl+Z on the slide).
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(request.onCancel);
    } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      apply();
    }
  });

  openPopoverAtRect(request.rect, popover, { trigger: request.trigger ?? null });
  open = popover;
  (words ?? address).focus();
  if (!words) address.select();
  return popover;
}

/** Close the link form if it is open, without changing anything. */
export function closeLinkPopover(): void {
  if (linkPopoverOpen()) closePopover();
  open = null;
}
