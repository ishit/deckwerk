import { applyUiTheme, setUiThemePreference, type UiTheme } from '../uiTheme.js';

const SUN_ICON =
  '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/>'
  + '<path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06'
  + 'M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" fill="none" stroke="currentColor" '
  + 'stroke-width="1.5" stroke-linecap="round"/></svg>';

const MOON_ICON =
  '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z" fill="none" '
  + 'stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

/**
 * One click between light and dark editor chrome, at the toolbar's leading
 * edge. It shows the theme a click switches to (a sun in dark, a moon in
 * light) and stores an explicit choice; System stays in the DeckWerk menu.
 * It watches <html data-ui-theme>, so a choice made from that menu, another
 * window or the OS keeps the icon right.
 */
export function createThemeToggle(): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'theme-toggle';
  const render = (theme: UiTheme) => {
    const next = theme === 'dark' ? 'light' : 'dark';
    const label = `Switch to ${next} theme`;
    button.innerHTML = next === 'light' ? SUN_ICON : MOON_ICON;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.dataset.theme = theme;
  };
  const current = (): UiTheme => (document.documentElement.dataset.uiTheme === 'light' ? 'light' : 'dark');
  render(applyUiTheme());
  button.addEventListener('click', () => render(setUiThemePreference(current() === 'dark' ? 'light' : 'dark')));
  new window.MutationObserver(() => {
    if (button.dataset.theme !== current()) render(current());
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-theme'] });
  return button;
}
