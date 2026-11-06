import type { FunctionColors, FunctionKey } from "@kan/hub/public";
import { DEFAULT_FUNCTION_COLORS } from "@kan/hub/public";

import { api } from "~/utils/api";
import { boardColour } from "./board-colour";

/**
 * The colours 技术 / 活动 / 运营 are painted in, set in the back office.
 * Falls back to the defaults while loading or when signed out, so a page
 * never waits for them.
 */
export function useFunctionColors(): FunctionColors {
  const { data } = api.hub.settings.functionColors.useQuery(undefined, {
    staleTime: 5 * 60_000,
    retry: false,
  });
  return data ?? DEFAULT_FUNCTION_COLORS;
}

/**
 * The colour for a task's function. A task on any other board gets a steady
 * colour of its board's own when that board is given, and neutral grey if not.
 */
export function colorOf(
  colors: FunctionColors,
  key: FunctionKey | null,
  boardPublicId?: string,
): string {
  if (key) return colors[key];
  return boardPublicId ? boardColour(boardPublicId) : "#9CA3AF";
}

/** A see-through version of a #RRGGBB colour, for soft backgrounds. */
export function tint(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
