// A small inline confirmation box (T-049, T-048 Н-5): the safe answer
// ("Отказ") gets the focus, so Enter never deletes anything by accident; the
// destructive one is shown in red, not as the primary button; Escape cancels.
import { h } from '../dom.js';

/**
 * @param {{ text: string, yes: string, label?: string, danger?: boolean, onYes: () => void, onNo: () => void }} opts
 * @returns {HTMLElement} the box; call `.focusCancel()` after it is in the page
 */
export function confirmBox({ text, yes, label = 'Потвърждение', danger = true, onYes, onNo }) {
  const cancel = h('button', { type: 'button', class: 'button', 'data-field': 'confirm-no', onclick: onNo }, 'Отказ');
  const box = h('div', { class: 'quiz__confirm', role: 'alertdialog', 'aria-label': label, 'aria-modal': 'false' },
    h('p', { class: 'quiz__confirm-text', text }),
    h('div', { class: 'quiz__confirm-actions' },
      cancel,
      h('button', { type: 'button', class: danger ? 'button button--danger' : 'button button--primary', 'data-field': 'confirm-yes', onclick: onYes }, yes),
    ));
  // T060 И-2 (T-061): Escape is "Отказ" (role=alertdialog), never "yes".
  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onNo?.();
  });
  box.focusCancel = () => cancel.focus();
  return box;
}
