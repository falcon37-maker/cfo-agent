// Registry of edit categories. Mirrors the read-side categories/index.ts
// shape but stays in its own folder — no cross imports.

import type { EditCategoryModule } from "../_base";
import { editCoreCategory } from "./edit_core";
import { adSpendEditCategory } from "./ad_spend_edit";
import { cogsEditCategory } from "./cogs_edit";
import { revenueEditCategory } from "./revenue_edit";

export const ALL_EDIT_CATEGORIES: EditCategoryModule[] = [
  editCoreCategory,
  adSpendEditCategory,
  cogsEditCategory,
  revenueEditCategory,
];

export function getEditCategory(id: string): EditCategoryModule | null {
  return ALL_EDIT_CATEGORIES.find((c) => c.id === id) ?? null;
}
