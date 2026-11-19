// A small inline confirmation box (T-049, T-048 Н-5): the safe answer
// ("Отказ") gets the focus, so Enter never deletes anything by accident; the
// destructive one is shown in red, not as the primary button.
import { h } from '../dom.js';

/**
 * @param {{ text: string, yes: string, label?: string, onYes: () => void, onNo: () => void }} opts
 * @returns {HTMLElement} the box; call `.focusCancel()` after it is in the page
 */
export function confirmBox({ text, yes, label = 'Потвърждение', onYes, onNo }) {
  const cancel = h('button', { type: 'button', class: 'button', 'data-field': 'confirm-no', onclick: onNo }, 'Отказ');
  const box = h('div', { class: 'quiz__confirm', role: 'alertdialog', 'aria-label': label, 'aria-modal': 'false' },
    h('p', { class: 'quiz__confirm-text', text }),
    h('div', { class: 'quiz__confirm-actions' },
      cancel,
      h('button', { type: 'button', class: 'button button--danger', 'data-field': 'confirm-yes', onclick: onYes }, yes),
    ));
  box.focusCancel = () => cancel.focus();
  return box;
}
