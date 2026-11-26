/**
 * Category colours shared by the desktop and mobile report pages, so a category has the same colour everywhere.
 * Order of precedence: user-defined colour (dictionary_category.color) → palette slot by the category's position in
 * the sorted dictionary → palette slot by name hash (categories outside the dictionary, e.g. "(bez kategorii)").
 */
export const PIE_COLORS = [
  '#1976d2', '#e53935', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#fdd835', '#6d4c41',
  '#3949ab', '#d81b60', '#7cb342', '#f4511e', '#5e35b1', '#00897b', '#c0ca33', '#757575',
  '#039be5', '#ad1457', '#2e7d32', '#ef6c00', '#4527a0', '#00695c', '#9e9d24', '#546e7a',
];

/** Small non-negative string hash (palette slot for categories missing from the dictionary). */
export function hashString(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function resolveCategoryColor(
  category: string,
  ownColors: ReadonlyMap<string, string>,
  paletteIndex: ReadonlyMap<string, number>,
): string {
  const own = ownColors.get(category);
  if (own) return own;
  const slot = paletteIndex.get(category) ?? hashString(category);
  return PIE_COLORS[slot % PIE_COLORS.length];
}
