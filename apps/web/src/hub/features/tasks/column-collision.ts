import type { CollisionDetection } from "@dnd-kit/core";
import { pointerWithin, rectIntersection } from "@dnd-kit/core";

/**
 * The column the pointer is over, and nothing when it is over none. The card
 * being dragged is wide and the columns are tall, so the card's own box often
 * overlaps a column the pointer is not on; going by the box would drop the
 * task there when the pointer is over a gap, the closed 其他 strip or empty
 * page. The card's box is only used when there are no pointer coordinates at
 * all, which is a drag started from the keyboard.
 */
export const columnUnderPointer: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);
