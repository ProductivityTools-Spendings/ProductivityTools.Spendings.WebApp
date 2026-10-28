import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { forkJoin } from 'rxjs';
import {
  CategoryMapping,
  DictionaryCategoryMappingService,
  UnmappedName,
} from '../services/dictionary-category-mapping.service';
import { SpendingService } from '../services/spending.service';
import {
  CategoryGroup,
  CategoryWithGroup,
  DictionaryCategoryGroupService,
} from '../services/dictionary-category-group.service';

type Tab = 'mappings' | 'groups';

/** Fallback colour used for groups created without an explicit colour. */
const DEFAULT_GROUP_COLOR = '#1976d2';

/** Row of the "Grupy" table on the groups tab. */
interface GroupRow {
  id: number;
  name: string;
  sortOrder: number;
  color: string | null;
  /** number of categories assigned to the group */
  categoriesCount: number;
  // working copy used by the inline edit inputs
  draftName: string;
  draftSortOrder: number;
  draftColor: string;
  editing: boolean;
  saving: boolean;
}

/** Row of the "Kategorie" table on the groups tab. */
interface CategoryRow {
  name: string;
  groupId: number | null;
  groupName: string | null;
  /** Chart colour ("#rrggbb"); null = automatic palette colour */
  color: string | null;
  saving: boolean;
}

interface EditRow {
  id: number;
  key: string;
  category: string;
  spendingsCount: number;
  /** working copy used by the inputs */
  draftKey: string;
  draftCategory: string;
  editing: boolean;
  saving: boolean;
}

/** Dictionary "transaction name → category" (dictionary_category_mapping). Reuses the accounts dictionary styles. */
@Component({
  selector: 'app-dictionary-category-mappings',
  imports: [FormsModule],
  templateUrl: './dictionary-category-mappings.html',
  styleUrl: '../dictionary-accounts/dictionary-accounts.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DictionaryCategoryMappings implements OnInit {
  private readonly service = inject(DictionaryCategoryMappingService);
  private readonly spendingService = inject(SpendingService);
  private readonly groupService = inject(DictionaryCategoryGroupService);

  /** Which tab is shown: "Nazwa → kategoria" (mappings) or "Grupy kategorii" (groups). */
  protected readonly tab = signal<Tab>('mappings');

  // ---- groups tab state ----
  protected readonly groups = signal<GroupRow[]>([]);
  protected readonly groupCategories = signal<CategoryRow[]>([]);
  protected readonly groupsLoading = signal(false);
  /** true once the groups tab data has been fetched at least once */
  private groupsLoaded = false;
  /** Text filter over category name and group name on the groups tab. */
  protected groupFilter = '';
  // new-group form
  protected newGroupName = '';
  protected newGroupColor = DEFAULT_GROUP_COLOR;
  protected newGroupSortOrder: number | null = null;
  protected readonly creatingGroup = signal(false);

  protected readonly rows = signal<EditRow[]>([]);
  protected readonly unmapped = signal<UnmappedName[]>([]);
  protected readonly categories = signal<string[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly status = signal<string | null>(null);
  /** Text filter over key and category. */
  protected filter = '';

  // new-entry form
  protected newKey = '';
  protected newCategory = '';
  protected readonly creating = signal(false);

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    forkJoin({
      all: this.service.getAll(),
      unmapped: this.service.getUnmapped(),
      categories: this.spendingService.getCategories(),
    }).subscribe({
      next: ({ all, unmapped, categories }) => {
        this.rows.set(all.map(toRow));
        this.unmapped.set(unmapped);
        this.categories.set(categories);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(describeError(err, 'Nie udało się pobrać słownika.'));
        this.loading.set(false);
      },
    });
  }

  protected visibleRows(): EditRow[] {
    const f = this.filter.trim().toLowerCase();
    if (!f) return this.rows();
    return this.rows().filter((r) => r.key.toLowerCase().includes(f) || r.category.toLowerCase().includes(f));
  }

  protected create(): void {
    const key = this.newKey.trim();
    const category = this.newCategory.trim();
    if (!key || !category) {
      this.error.set('Podaj nazwę transakcji i wybierz kategorię.');
      return;
    }
    this.creating.set(true);
    this.error.set(null);
    this.service.create(key, category).subscribe({
      next: (created) => {
        this.rows.update((rs) => [...rs, toRow(created)].sort(byCategory));
        this.unmapped.update((us) => us.filter((u) => u.name !== key));
        this.newKey = '';
        this.newCategory = '';
        this.creating.set(false);
        this.status.set(`Dodano: ${created.key} → ${created.category}. Kliknij „Uzupełnij kategorie” na stronie transakcji, aby zastosować.`);
      },
      error: (err) => {
        this.error.set(describeError(err, 'Nie udało się dodać wpisu.'));
        this.creating.set(false);
      },
    });
  }

  /** Pre-fills the form from the "unmapped" list. */
  protected prefill(u: UnmappedName): void {
    this.newKey = u.name;
    document.getElementById('new-category')?.focus();
  }

  protected startEdit(row: EditRow): void {
    this.patch(row.id, { editing: true, draftKey: row.key, draftCategory: row.category });
  }

  protected cancelEdit(row: EditRow): void {
    this.patch(row.id, { editing: false, draftKey: row.key, draftCategory: row.category });
  }

  protected save(row: EditRow): void {
    const key = row.draftKey.trim();
    const category = row.draftCategory.trim();
    if (!key || !category) {
      this.error.set('Nazwa transakcji i kategoria nie mogą być puste.');
      return;
    }
    this.patch(row.id, { saving: true });
    this.error.set(null);
    this.service.update(row.id, key, category).subscribe({
      next: (saved) => {
        this.patch(row.id, { key: saved.key, category: saved.category, spendingsCount: saved.spendingsCount, editing: false, saving: false });
        this.rows.update((rs) => [...rs].sort(byCategory));
        this.status.set(`Zapisano: ${saved.key} → ${saved.category}.`);
      },
      error: (err) => {
        this.patch(row.id, { saving: false });
        this.error.set(describeError(err, 'Nie udało się zapisać.'));
      },
    });
  }

  protected remove(row: EditRow): void {
    if (!confirm(`Usunąć wpis ${row.key} → ${row.category}?`)) {
      return;
    }
    this.patch(row.id, { saving: true });
    this.service.delete(row.id).subscribe({
      next: () => {
        this.rows.update((rs) => rs.filter((r) => r.id !== row.id));
        this.status.set(`Usunięto: ${row.key}.`);
        this.service.getUnmapped().subscribe((us) => this.unmapped.set(us));
      },
      error: (err) => {
        this.patch(row.id, { saving: false });
        this.error.set(describeError(err, 'Nie udało się usunąć.'));
      },
    });
  }

  private patch(id: number, changes: Partial<EditRow>): void {
    this.rows.update((rs) => rs.map((r) => (r.id === id ? { ...r, ...changes } : r)));
  }

  // ---------------------------------------------------------------------------
  // Groups tab
  // ---------------------------------------------------------------------------

  protected selectTab(tab: Tab): void {
    this.tab.set(tab);
    this.status.set(null);
    this.error.set(null);
    if (tab === 'groups' && !this.groupsLoaded) {
      this.loadGroups();
    }
  }

  /** Fetches groups and all categories (GET /category-groups + GET /category-groups/categories). */
  protected loadGroups(): void {
    this.groupsLoading.set(true);
    this.error.set(null);
    forkJoin({
      groups: this.groupService.getAll(),
      categories: this.groupService.getCategories(),
    }).subscribe({
      next: ({ groups, categories }) => {
        this.groups.set(groups.map(toGroupRow).sort(byGroupOrder));
        this.groupCategories.set(categories.map(toCategoryRow).sort(byCategoryName));
        this.groupsLoaded = true;
        this.groupsLoading.set(false);
      },
      error: (err) => {
        this.error.set(describeError(err, 'Nie udało się pobrać grup kategorii.'));
        this.groupsLoading.set(false);
      },
    });
  }

  protected visibleGroupCategories(): CategoryRow[] {
    const f = this.groupFilter.trim().toLowerCase();
    if (!f) return this.groupCategories();
    return this.groupCategories().filter(
      (c) => c.name.toLowerCase().includes(f) || (c.groupName ?? '').toLowerCase().includes(f),
    );
  }

  /** Number of categories without a group (for the summary line). */
  protected ungroupedCount(): number {
    return this.groupCategories().filter((c) => c.groupId === null).length;
  }

  /** Colour of the group a category belongs to, or null when ungrouped / colourless. */
  protected groupColor(groupId: number | null): string | null {
    if (groupId === null) return null;
    return this.groups().find((g) => g.id === groupId)?.color ?? null;
  }

  protected createGroup(): void {
    const name = this.newGroupName.trim();
    if (!name) {
      this.error.set('Podaj nazwę grupy.');
      return;
    }
    this.creatingGroup.set(true);
    this.error.set(null);
    this.groupService
      .create({
        name,
        color: this.newGroupColor || null,
        sortOrder: this.newGroupSortOrder ?? this.nextSortOrder(),
      })
      .subscribe({
        next: (created) => {
          this.groups.update((gs) => [...gs, toGroupRow(created)].sort(byGroupOrder));
          this.newGroupName = '';
          this.newGroupColor = DEFAULT_GROUP_COLOR;
          this.newGroupSortOrder = null;
          this.creatingGroup.set(false);
          this.status.set(`Dodano grupę: ${created.name}.`);
        },
        error: (err) => {
          this.error.set(describeError(err, 'Nie udało się dodać grupy.'));
          this.creatingGroup.set(false);
        },
      });
  }

  /** Next free order number: one more than the current maximum. */
  private nextSortOrder(): number {
    return this.groups().reduce((max, g) => Math.max(max, g.sortOrder), 0) + 1;
  }

  protected startGroupEdit(g: GroupRow): void {
    this.patchGroup(g.id, {
      editing: true,
      draftName: g.name,
      draftSortOrder: g.sortOrder,
      draftColor: g.color ?? DEFAULT_GROUP_COLOR,
    });
  }

  protected cancelGroupEdit(g: GroupRow): void {
    this.patchGroup(g.id, { editing: false });
  }

  protected saveGroup(g: GroupRow): void {
    const name = g.draftName.trim();
    if (!name) {
      this.error.set('Nazwa grupy nie może być pusta.');
      return;
    }
    this.patchGroup(g.id, { saving: true });
    this.error.set(null);
    this.groupService
      .update(g.id, { name, sortOrder: Number(g.draftSortOrder) || 0, color: g.draftColor || null })
      .subscribe({
        next: (saved) => {
          this.patchGroup(g.id, {
            name: saved.name,
            sortOrder: saved.sortOrder,
            color: saved.color,
            categoriesCount: saved.categories?.length ?? g.categoriesCount,
            editing: false,
            saving: false,
          });
          this.groups.update((gs) => [...gs].sort(byGroupOrder));
          // keep the group name shown in the categories table in sync
          this.groupCategories.update((cs) =>
            cs.map((c) => (c.groupId === saved.id ? { ...c, groupName: saved.name } : c)),
          );
          this.status.set(`Zapisano grupę: ${saved.name}.`);
        },
        error: (err) => {
          this.patchGroup(g.id, { saving: false });
          this.error.set(describeError(err, 'Nie udało się zapisać grupy.'));
        },
      });
  }

  protected removeGroup(g: GroupRow): void {
    const suffix = g.categoriesCount > 0 ? ` Kategorie z tej grupy (${g.categoriesCount}) zostaną bez grupy.` : '';
    if (!confirm(`Usunąć grupę „${g.name}”?${suffix}`)) return;
    this.patchGroup(g.id, { saving: true });
    this.error.set(null);
    this.groupService.delete(g.id).subscribe({
      next: () => {
        this.groups.update((gs) => gs.filter((x) => x.id !== g.id));
        // the backend clears group_id via FK ON DELETE SET NULL; mirror it locally
        this.groupCategories.update((cs) =>
          cs.map((c) => (c.groupId === g.id ? { ...c, groupId: null, groupName: null } : c)),
        );
        this.status.set(`Usunięto grupę: ${g.name}.`);
      },
      error: (err) => {
        this.patchGroup(g.id, { saving: false });
        this.error.set(describeError(err, 'Nie udało się usunąć grupy.'));
      },
    });
  }

  /** Called on <select> change in the categories table; saves immediately. */
  protected assignGroup(c: CategoryRow, event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = select.value;
    const groupId = value === '' ? null : Number(value);
    if (groupId === c.groupId) return;
    const previousGroupId = c.groupId;
    this.patchCategory(c.name, { saving: true });
    this.error.set(null);
    this.groupService.setCategoryGroup(c.name, groupId).subscribe({
      next: (saved) => {
        this.patchCategory(c.name, { groupId: saved.groupId, groupName: saved.groupName, saving: false });
        this.adjustGroupCount(previousGroupId, -1);
        this.adjustGroupCount(saved.groupId, +1);
        this.status.set(
          saved.groupId === null
            ? `Kategoria „${saved.name}” jest teraz bez grupy.`
            : `Przypisano „${saved.name}” do grupy „${saved.groupName}”.`,
        );
      },
      error: (err) => {
        // The bound value did not change, so Angular will not touch the DOM;
        // restore the previous option on the element directly.
        select.value = previousGroupId === null ? '' : previousGroupId.toString();
        this.patchCategory(c.name, { saving: false });
        this.error.set(describeError(err, 'Nie udało się przypisać grupy.'));
      },
    });
  }

  protected readonly randomizing = signal(false);

  /**
   * Gives categories random, clearly different colours (hues spread by the golden angle from a random start,
   * alternating lightness) and saves them in one request. `onlyAuto` = only categories without their own colour.
   */
  protected randomizeColors(onlyAuto: boolean): void {
    const targets = this.groupCategories().filter((c) => !onlyAuto || !c.color).map((c) => c.name);
    if (targets.length === 0) {
      this.status.set('Wszystkie kategorie mają już własny kolor.');
      return;
    }
    if (!onlyAuto && !confirm(`Nadać losowe kolory wszystkim ${targets.length} kategoriom? Obecne kolory zostaną zastąpione.`)) {
      return;
    }
    const colors = randomDistinctColors(targets.length);
    const payload: Record<string, string> = {};
    targets.forEach((name, i) => (payload[name] = colors[i]));
    this.randomizing.set(true);
    this.error.set(null);
    this.groupService.setCategoryColors(payload).subscribe({
      next: (saved) => {
        const byName = new Map(saved.map((c) => [c.name, c.color ?? null]));
        this.groupCategories.update((cs) => cs.map((c) => (byName.has(c.name) ? { ...c, color: byName.get(c.name)! } : c)));
        this.randomizing.set(false);
        this.status.set(`Nadano losowe kolory ${targets.length} kategoriom.`);
      },
      error: (err) => {
        this.randomizing.set(false);
        this.error.set(describeError(err, 'Nie udało się zapisać kolorów.'));
      },
    });
  }

  /** Saves the category's chart colour (null = back to the automatic palette colour). */
  protected setCategoryColor(c: CategoryRow, color: string | null): void {
    if ((color ?? null) === c.color) return;
    this.patchCategory(c.name, { saving: true });
    this.error.set(null);
    this.groupService.setCategoryColor(c.name, color).subscribe({
      next: (saved) => {
        this.patchCategory(c.name, { color: saved.color ?? null, saving: false });
        this.status.set(saved.color
          ? `Ustawiono kolor kategorii „${saved.name}”.`
          : `Kategoria „${saved.name}” ma znowu kolor automatyczny.`);
      },
      error: (err) => {
        this.patchCategory(c.name, { saving: false });
        this.error.set(describeError(err, 'Nie udało się zapisać koloru.'));
      },
    });
  }

  private adjustGroupCount(groupId: number | null, delta: number): void {
    if (groupId === null) return;
    this.groups.update((gs) =>
      gs.map((g) => (g.id === groupId ? { ...g, categoriesCount: Math.max(0, g.categoriesCount + delta) } : g)),
    );
  }

  private patchGroup(id: number, changes: Partial<GroupRow>): void {
    this.groups.update((gs) => gs.map((g) => (g.id === id ? { ...g, ...changes } : g)));
  }

  private patchCategory(name: string, changes: Partial<CategoryRow>): void {
    this.groupCategories.update((cs) => cs.map((c) => (c.name === name ? { ...c, ...changes } : c)));
  }
}

function toGroupRow(g: CategoryGroup): GroupRow {
  return {
    id: g.id, name: g.name, sortOrder: g.sortOrder ?? 0, color: g.color ?? null,
    categoriesCount: g.categories?.length ?? 0,
    draftName: g.name, draftSortOrder: g.sortOrder ?? 0, draftColor: g.color ?? DEFAULT_GROUP_COLOR,
    editing: false, saving: false,
  };
}

function toCategoryRow(c: CategoryWithGroup): CategoryRow {
  return { name: c.name, groupId: c.groupId ?? null, groupName: c.groupName ?? null, color: c.color ?? null, saving: false };
}

function byGroupOrder(a: GroupRow, b: GroupRow): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'pl');
}

function byCategoryName(a: CategoryRow, b: CategoryRow): number {
  return a.name.localeCompare(b.name, 'pl');
}

function toRow(m: CategoryMapping): EditRow {
  return {
    id: m.id, key: m.key, category: m.category, spendingsCount: m.spendingsCount,
    draftKey: m.key, draftCategory: m.category, editing: false, saving: false,
  };
}

function byCategory(a: EditRow, b: EditRow): number {
  return a.category.localeCompare(b.category, 'pl') || a.key.localeCompare(b.key, 'pl');
}

function describeError(err: unknown, fallback: string): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { message?: string; detail?: string } | null;
    return body?.detail || body?.message || err.message || fallback;
  }
  return fallback;
}

/** `count` random colours with well separated hues (golden angle) in shuffled order, as "#rrggbb". */
function randomDistinctColors(count: number): string[] {
  const start = Math.random() * 360;
  const colors: string[] = [];
  for (let i = 0; i < count; i++) {
    const hue = (start + i * 137.508) % 360;
    const saturation = 60 + (i % 3) * 8; // 60, 68, 76 %
    const lightness = i % 2 === 0 ? 45 : 58;
    colors.push(hslToHex(hue, saturation, lightness));
  }
  for (let i = colors.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [colors[i], colors[j]] = [colors[j], colors[i]];
  }
  return colors;
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}
