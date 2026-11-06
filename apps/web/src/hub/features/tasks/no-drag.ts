/**
 * Spread on anything inside a draggable card that has its own press (the ⋯
 * menu, the due date): the press must neither start a drag nor open the card.
 * The mouse and touch sensors listen to `mousedown` and `touchstart`, the
 * pointer events alone would not stop them.
 */
const stop = (event: { stopPropagation: () => void }) =>
  event.stopPropagation();

export const noDrag = {
  onPointerDown: stop,
  onMouseDown: stop,
  onTouchStart: stop,
  onClick: stop,
  onKeyDown: stop,
};
