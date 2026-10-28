import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe, formatNumber, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { CategoryDetail, CategoryMonth, Hygiene, RecurringPayment, ReportService } from '../services/report.service';
import {
  aggregateMonth, arcPath, cumulativeShares, dayLabel, donutSlices, elapsedDays, forecast, mergeCategories, niceStep, NO_CATEGORY, ticks, totalSeries,
} from './daily-cumulative';
import {
  aggregateByGroup, categoryGroupMap, effectiveSelection, groupCategories, groupColor, groupLabel, groupOrder, GroupRow, isCategoryVisible, NO_GROUP,
  orderedGroups, toggleGroupExclusion,
} from './category-groups';

/** One stacked-bar segment of the cumulative daily chart. */
interface DailySegment {
  key: string;
  category: string;
  day: number;
  date: string;
  x: number;
  y: number;
  h: number;
  color: string;
  amount: number;
  cum: number;
  cumTotal: number;
  tip: string;
}

/** Row of the category × month pivot (report 1). */
interface PivotRow {
  category: string;
  byMonth: Record<string, number>;
  total: number;
  avg: number;
}

/** One slice of the category-share donut (inner ring = categories, outer ring = groups). */
interface PieSlice {
  category: string;
  /** Group key of the category (NO_GROUP when ungrouped). */
  group: string;
  groupLabel: string;
  value: number;
  pct: number;
  color: string;
  path: string;
  labelX: number;
  labelY: number;
}

/** Outer-ring slice: one group with the summed share of its categories. */
interface PieGroupSlice {
  group: string;
  label: string;
  value: number;
  pct: number;
  color: string;
  path: string;
  labelX: number;
  labelY: number;
  categories: string[];
}

/** One stacked segment of the pivot bar chart (a category or a group in one month). */
interface PivotBarSegment {
  key: string;
  label: string;
  color: string;
  value: number;
  y: number;
  h: number;
  /** Group row for group segments (drill-down opens the group); null for categories. */
  group: GroupRow<PivotRow> | null;
}

/** One month column of the pivot bar chart. */
interface PivotBarColumn {
  month: string;
  x: number;
  w: number;
  total: number;
  /** y of the top of the spending stack (label position). */
  topY: number;
  segments: PivotBarSegment[];
}

type PivotMode = 'categories' | 'groups';

const PIE_COLORS = [
  '#1976d2', '#e53935', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#fdd835', '#6d4c41',
  '#3949ab', '#d81b60', '#7cb342', '#f4511e', '#5e35b1', '#00897b', '#c0ca33', '#757575',
  '#039be5', '#ad1457', '#2e7d32', '#ef6c00', '#4527a0', '#00695c', '#9e9d24', '#546e7a',
];

function ym(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  return ym(new Date(y, m - 1 + delta, 1));
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = shiftMonth(cur, 1);
  }
  return out;
}

@Component({
  selector: 'app-reports',
  imports: [CurrencyPipe, DecimalPipe, FormsModule, RouterLink, NgTemplateOutlet],
  templateUrl: './reports.html',
  styleUrl: './reports.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Reports implements OnInit {
  private readonly service = inject(ReportService);

  // --- filters -------------------------------------------------------------
  protected readonly currentMonth = ym(new Date());
  protected from = shiftMonth(this.currentMonth, -11);
  protected to = this.currentMonth;

  // --- quick ranges ----------------------------------------------------------
  /** Earliest month with data (from hygiene); falls back to the current year when not loaded yet. */
  protected readonly firstMonth = computed(() => this.hygiene()?.firstMonth ?? `${new Date().getFullYear()}-01`);

  /** Years from the first month with data up to the current year – one quick button each. */
  protected readonly years = computed(() => {
    const first = Number(this.firstMonth().slice(0, 4));
    const current = new Date().getFullYear();
    const out: number[] = [];
    for (let y = first; y <= current; y++) out.push(y);
    return out;
  });

  /** Last N months ending with the current month. */
  protected setLastMonths(n: number): void {
    this.to = ym(new Date());
    this.from = shiftMonth(this.to, -(n - 1));
    this.load();
  }

  protected setYear(year: number): void {
    this.from = `${year}-01`;
    this.to = year === new Date().getFullYear() ? ym(new Date()) : `${year}-12`;
    this.load();
  }

  protected setAll(): void {
    this.from = this.firstMonth();
    this.to = ym(new Date());
    this.load();
  }

  /** Extends the range N months backwards, keeping the end date. */
  protected extendBack(n: number): void {
    this.from = shiftMonth(this.fromApplied(), -n);
    this.to = this.toApplied();
    this.load();
  }

  protected readonly canExtendBack = computed(() => this.fromApplied() > this.firstMonth());

  protected isRange(from: string, to: string): boolean {
    return this.fromApplied() === from && this.toApplied() === to;
  }

  protected isLastMonths(n: number): boolean {
    const to = ym(new Date());
    return this.isRange(shiftMonth(to, -(n - 1)), to);
  }

  protected isYear(year: number): boolean {
    return this.isRange(`${year}-01`, year === new Date().getFullYear() ? ym(new Date()) : `${year}-12`);
  }

  // --- data ----------------------------------------------------------------
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly categoryData = signal<CategoryMonth[]>([]);
  /** Range extended by 11 months backwards so that every month in the range has a full 12-month window. */
  protected readonly matData = signal<CategoryMonth[]>([]);
  protected readonly recurring = signal<RecurringPayment[]>([]);
  protected readonly hygiene = signal<Hygiene | null>(null);

  // --- category groups: chip filter ------------------------------------------
  protected readonly NO_GROUP = NO_GROUP;
  /** Groups from hygiene in display order (sortOrder, name). */
  protected readonly groups = computed(() => orderedGroups(this.hygiene()?.groups ?? []));
  protected readonly hasGroups = computed(() => this.groups().length > 0);
  /** category → group key, built from every loaded row set (pivot, MAT window, daily chart months). */
  protected readonly groupMap = computed(() =>
    categoryGroupMap([...this.categoryData(), ...this.matData(), ...this.dailyRows(), ...this.dailyPrevRows()]),
  );
  /** Group keys in display order (configured groups, unknown ones, "Bez grupy"). */
  protected readonly groupKeys = computed(() => groupOrder(this.groups(), this.groupMap()));

  /** Selected group chips as persisted; empty = all groups. */
  private static readonly GROUPS_KEY = 'reports.groups.selected';
  protected readonly selectedGroups = signal<Set<string>>(new Set(JSON.parse(localStorage.getItem(Reports.GROUPS_KEY) ?? '[]')));
  /** Selection restricted to groups that still exist; empty = no filtering. */
  protected readonly groupSelection = computed(() => effectiveSelection(this.selectedGroups(), this.groups()));

  protected isGroupSelected(key: string): boolean {
    return this.groupSelection().has(key);
  }

  protected toggleGroup(key: string): void {
    this.selectedGroups.update((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(Reports.GROUPS_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  protected selectAllGroups(): void {
    localStorage.setItem(Reports.GROUPS_KEY, '[]');
    this.selectedGroups.set(new Set());
  }

  protected groupColor(key: string): string {
    return groupColor(key, this.groups());
  }

  protected groupLabel(key: string): string {
    return groupLabel(key);
  }

  /** Group key of a category (NO_GROUP when ungrouped / unknown). */
  protected groupOf(category: string): string {
    return this.groupMap().get(category) ?? NO_GROUP;
  }

  /** True when the category passes the group chip filter; applied in every section before per-category checkboxes. */
  protected isVisible(category: string): boolean {
    return isCategoryVisible(category, this.groupMap(), this.groupSelection());
  }

  // --- report 1: pivot -----------------------------------------------------
  protected readonly months = computed(() => monthsBetween(this.fromApplied(), this.toApplied()));
  protected readonly fromApplied = signal(this.from);
  protected readonly toApplied = signal(this.to);

  protected readonly pivot = computed<PivotRow[]>(() => {
    const months = this.months();
    const map = new Map<string, PivotRow>();
    for (const r of this.categoryData()) {
      if (!this.isVisible(r.category)) continue;
      let row = map.get(r.category);
      if (!row) {
        row = { category: r.category, byMonth: {}, total: 0, avg: 0 };
        map.set(r.category, row);
      }
      row.byMonth[r.month] = (row.byMonth[r.month] ?? 0) + r.total;
      row.total += r.total;
    }
    const rows = [...map.values()].map((r) => ({ ...r, avg: months.length ? r.total / months.length : 0 }));
    return rows.sort((a, b) => a.total - b.total); // most negative (largest expense) first
  });

  /** Categories unticked in the pivot – greyed out and left out of the totals. Persisted in localStorage. */
  private static readonly EXCLUDED_KEY = 'reports.pivot.excludedCategories';
  protected readonly excluded = signal<Set<string>>(new Set(JSON.parse(localStorage.getItem(Reports.EXCLUDED_KEY) ?? '[]')));

  protected isIncluded(category: string): boolean {
    return !this.excluded().has(category);
  }

  protected toggleCategory(category: string): void {
    this.excluded.update((set) => {
      const next = new Set(set);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      localStorage.setItem(Reports.EXCLUDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  protected readonly allIncluded = computed(() => this.pivot().every((r) => this.isIncluded(r.category)));

  protected toggleAll(): void {
    const include = !this.allIncluded();
    this.excluded.update(() => {
      const next = include ? new Set<string>() : new Set(this.pivot().map((r) => r.category));
      localStorage.setItem(Reports.EXCLUDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  /** Month totals over included categories only. */
  protected readonly pivotMonthTotals = computed<Record<string, number>>(() => {
    const excluded = this.excluded();
    const totals: Record<string, number> = {};
    for (const r of this.categoryData()) {
      if (excluded.has(r.category) || !this.isVisible(r.category)) continue;
      totals[r.month] = (totals[r.month] ?? 0) + r.total;
    }
    return totals;
  });

  protected readonly pivotGrandTotal = computed(() => Object.values(this.pivotMonthTotals()).reduce((a, b) => a + b, 0));

  /** Largest absolute monthly value among the displayed rows (categories or groups) – scales the inline heat bars. */
  protected readonly pivotMax = computed(() => {
    const rows: { byMonth: Record<string, number> }[] = this.pivotMode() === 'groups' ? this.pivotGroups() : this.pivot();
    return Math.max(1, ...rows.flatMap((r) => Object.values(r.byMonth).map((v) => Math.abs(v))));
  });

  // --- report 1: "Grupy" mode ---------------------------------------------------
  private static readonly PIVOT_MODE_KEY = 'reports.pivot.mode';
  protected readonly pivotMode = signal<PivotMode>(localStorage.getItem(Reports.PIVOT_MODE_KEY) === 'groups' ? 'groups' : 'categories');

  protected setPivotMode(mode: PivotMode): void {
    this.pivotMode.set(mode);
    localStorage.setItem(Reports.PIVOT_MODE_KEY, mode);
  }

  /** Group rows (sortOrder, "Bez grupy" last) with monthly sums over their included categories. */
  protected readonly pivotGroups = computed<GroupRow<PivotRow>[]>(() => {
    const excluded = this.excluded();
    return aggregateByGroup(this.pivot(), this.groupMap(), this.groupKeys(), (c) => !excluded.has(c), this.months().length);
  });

  /** Expanded group rows (▾); not persisted. */
  protected readonly expandedGroups = signal<Set<string>>(new Set());

  protected isExpanded(group: string): boolean {
    return this.expandedGroups().has(group);
  }

  protected toggleExpanded(group: string): void {
    this.expandedGroups.update((set) => {
      const next = new Set(set);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  /** Group checkbox: ticks all categories of the group when any is unticked, otherwise unticks all. */
  protected toggleGroupCategories(g: GroupRow<PivotRow>): void {
    this.excluded.update((set) => {
      const next = toggleGroupExclusion(set, g.categories.map((r) => r.category));
      localStorage.setItem(Reports.EXCLUDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  // --- report 1: drill-down ---------------------------------------------------
  /** Currently opened pivot cell; null = panel closed. `group` set = a group cell (rows filtered client-side to `categories`). */
  protected readonly drill = signal<{ category: string | null; group: string | null; categories: string[] | null; from: string; to: string } | null>(null);
  protected readonly drillRows = signal<CategoryDetail[]>([]);
  protected readonly drillLoading = signal(false);
  protected readonly drillTotal = computed(() => this.drillRows().reduce((s, r) => s + r.amountPln, 0));

  /**
   * category = null → all categories; month = null → whole selected range.
   * With `group` the details are fetched without a category and filtered client-side to the group's categories.
   */
  protected openDrill(category: string | null, month: string | null, group?: { key: string; categories: string[] }): void {
    const from = month ?? this.fromApplied();
    const to = month ?? this.toApplied();
    const state = { category: group ? null : category, group: group?.key ?? null, categories: group?.categories ?? null, from, to };
    this.drill.set(state);
    this.drillLoading.set(true);
    this.service.categoryMonthlyDetails(from, to, state.category ?? undefined).subscribe({
      next: (rows) => {
        if (this.drill() !== state) return; // stale response
        const wanted = state.categories ? new Set(state.categories) : null;
        this.drillRows.set(wanted ? rows.filter((r) => wanted.has(r.category || NO_CATEGORY)) : rows);
        this.drillLoading.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? 'Nie udało się pobrać szczegółów.');
        this.drillLoading.set(false);
      },
    });
  }

  protected closeDrill(): void {
    this.drill.set(null);
    this.drillRows.set([]);
  }

  protected drillTitle(): string {
    const d = this.drill();
    if (!d) return '';
    const period = d.from === d.to ? d.from : `${d.from} – ${d.to}`;
    if (d.group) return `Grupa ${groupLabel(d.group)} · ${period}`;
    return `${d.category ?? 'Wszystkie kategorie'} · ${period}`;
  }

  /** Drill-down for a group row cell (month = null → whole range). */
  protected openGroupDrill(g: GroupRow<PivotRow>, month: string | null): void {
    this.openDrill(null, month, { key: g.group, categories: g.categories.map((r) => r.category) });
  }

  // --- report 1: bar chart under the pivot (same data as the table) -----------
  protected readonly barW = 1200;
  protected readonly barH = 300;
  protected readonly barPad = { l: 70, r: 16, t: 22, b: 36 };

  /** Stable colour per pivot category (by table order of all categories, so toggling does not recolour). */
  protected readonly pivotColors = computed(() => new Map(this.pivot().map((r, i) => [r.category, PIE_COLORS[i % PIE_COLORS.length]])));

  /** "wszystkie" / "żadna" for the pivot category chips (same selection as the table checkboxes). */
  protected pivotSetAll(include: boolean): void {
    this.excluded.update(() => {
      const next = include ? new Set<string>() : new Set(this.pivot().map((r) => r.category));
      localStorage.setItem(Reports.EXCLUDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  /** Series of the bar chart: included categories (categories mode) or groups (groups mode), in table order. */
  protected readonly pivotBarSeries = computed(() => {
    if (this.pivotMode() === 'groups' && this.hasGroups()) {
      return this.pivotGroups()
        .filter((g) => g.includedCount > 0)
        .map((g) => ({ key: g.group, label: g.label, color: this.groupColor(g.group), byMonth: g.byMonth, group: g as GroupRow<PivotRow> | null }));
    }
    const excluded = this.excluded();
    return this.pivot()
      .filter((r) => !excluded.has(r.category))
      .map((r) => ({ key: r.category, label: r.category, color: this.pivotColors().get(r.category) ?? PIE_COLORS[0], byMonth: r.byMonth, group: null }));
  });

  /** Largest stacked spending (up) and net inflow (down) per month – the chart's value range. */
  private readonly pivotBarRange = computed(() => {
    let up = 0;
    let down = 0;
    for (const m of this.months()) {
      let neg = 0;
      let pos = 0;
      for (const s of this.pivotBarSeries()) {
        const v = s.byMonth[m] ?? 0;
        if (v < 0) neg -= v; else pos += v;
      }
      up = Math.max(up, neg);
      down = Math.max(down, pos);
    }
    return { up: Math.max(up, 1), down };
  });

  protected barY(value: number): number {
    const { up, down } = this.pivotBarRange();
    const h = this.barH - this.barPad.t - this.barPad.b;
    // spending (negative) is drawn upwards from the zero axis, inflows below it
    return this.barPad.t + ((up + value) / (up + down)) * h;
  }

  protected readonly barZeroY = computed(() => this.barY(0));

  /** Gridlines labelled with net values (spending negative), like the other charts. */
  protected readonly barTicks = computed(() => {
    const { up, down } = this.pivotBarRange();
    const step = niceStep(up + down);
    const ticks: { y: number; value: number }[] = [];
    for (let v = 0; v <= up + 1e-9; v += step) ticks.push({ y: this.barY(-v), value: -v });
    for (let v = step; v <= down + 1e-9; v += step) ticks.push({ y: this.barY(v), value: v });
    return ticks;
  });

  protected readonly pivotBars = computed<PivotBarColumn[]>(() => {
    const months = this.months();
    const n = Math.max(months.length, 1);
    const slot = (this.barW - this.barPad.l - this.barPad.r) / n;
    const w = Math.min(60, slot * 0.7);
    const zero = this.barY(0);
    return months.map((m, i) => {
      let upTop = zero;
      let downBottom = zero;
      let total = 0;
      const segments: PivotBarSegment[] = [];
      for (const s of this.pivotBarSeries()) {
        const v = s.byMonth[m] ?? 0;
        if (!v) continue;
        total += v;
        const h = Math.abs(this.barY(v) - zero);
        if (v < 0) {
          upTop -= h;
          segments.push({ key: s.key, label: s.label, color: s.color, value: v, y: upTop, h, group: s.group });
        } else {
          segments.push({ key: s.key, label: s.label, color: s.color, value: v, y: downBottom, h, group: s.group });
          downBottom += h;
        }
      }
      return { month: m, x: this.barPad.l + i * slot + (slot - w) / 2, w, total, topY: upTop, segments };
    });
  });

  protected openBarDrill(seg: PivotBarSegment, month: string): void {
    if (seg.group) this.openGroupDrill(seg.group, month);
    else this.openDrill(seg.key, month);
  }

  // --- pie: category share -------------------------------------------------
  protected readonly pieR = 100;
  protected readonly pieInner = 58;
  protected readonly pieC = 110;
  /** Radii of the category ring: the full donut without groups, the inner ring under the group ring otherwise. */
  protected readonly pieCatRadii = computed(() => (this.hasGroups() ? { R: 78, r: 50 } : { R: this.pieR, r: this.pieInner }));
  /** Radii of the outer (group) ring. */
  protected readonly pieGroupRadii = { R: 100, r: 82 };

  /**
   * Expense categories (net < 0) included in the pivot, as donut slices with share of the total.
   * With groups the slices are ordered by group (then by amount) so that the category ring lines up with the group ring.
   */
  protected readonly pieSlices = computed<PieSlice[]>(() => {
    const excluded = this.excluded();
    const rows = this.pivot().filter((r) => !excluded.has(r.category) && r.total < 0);
    if (this.hasGroups()) {
      const rank = new Map(this.groupKeys().map((k, i) => [k, i]));
      rows.sort((a, b) => (rank.get(this.groupOf(a.category)) ?? 0) - (rank.get(this.groupOf(b.category)) ?? 0) || a.total - b.total);
    }
    const sum = rows.reduce((s, r) => s - r.total, 0);
    const { R, r: ir } = this.pieCatRadii();
    let angle = -Math.PI / 2;
    return rows.map((r, i) => {
      const value = -r.total;
      const frac = sum ? value / sum : 0;
      const start = angle;
      const end = angle + Math.min(frac, 0.99999) * 2 * Math.PI;
      angle = start + frac * 2 * Math.PI;
      const mid = (start + end) / 2;
      const lr = (R + ir) / 2;
      const group = this.groupOf(r.category);
      return {
        category: r.category,
        group,
        groupLabel: groupLabel(group),
        value,
        pct: frac * 100,
        color: PIE_COLORS[i % PIE_COLORS.length],
        path: this.arcPath(start, end, R, ir),
        labelX: this.pieC + lr * Math.cos(mid),
        labelY: this.pieC + lr * Math.sin(mid),
      };
    });
  });

  protected readonly pieTotal = computed(() => this.pieSlices().reduce((s, x) => s + x.value, 0));

  /** Outer ring: category slices summed per group (same order, so the rings align). Empty when there are no groups. */
  protected readonly pieGroupSlices = computed<PieGroupSlice[]>(() => {
    if (!this.hasGroups()) return [];
    const slices = this.pieSlices();
    const sum = slices.reduce((s, x) => s + x.value, 0);
    const { R, r } = this.pieGroupRadii;
    const lr = (R + r) / 2;
    const out: PieGroupSlice[] = [];
    let angle = -Math.PI / 2;
    for (let i = 0; i < slices.length; ) {
      const key = slices[i].group;
      let value = 0;
      const categories: string[] = [];
      for (; i < slices.length && slices[i].group === key; i++) {
        value += slices[i].value;
        categories.push(slices[i].category);
      }
      const frac = sum ? value / sum : 0;
      const start = angle;
      const end = angle + Math.min(frac, 0.99999) * 2 * Math.PI;
      angle = start + frac * 2 * Math.PI;
      const mid = (start + end) / 2;
      out.push({
        group: key, label: groupLabel(key), value, pct: frac * 100, color: this.groupColor(key), categories,
        path: this.arcPath(start, end, R, r), labelX: this.pieC + lr * Math.cos(mid), labelY: this.pieC + lr * Math.sin(mid),
      });
    }
    return out;
  });

  private arcPath(start: number, end: number, R: number, r: number): string {
    return arcPath(this.pieC, R, r, start, end);
  }

  // --- MAT: moving annual total --------------------------------------------
  private static readonly MAT_EXCLUDED_KEY = 'reports.mat.excludedCategories';
  protected readonly matExcluded = signal<Set<string>>(new Set(JSON.parse(localStorage.getItem(Reports.MAT_EXCLUDED_KEY) ?? '[]')));

  /** All categories present in the loaded MAT window, sorted by total spend. */
  protected readonly matCategories = computed(() => {
    const totals = new Map<string, number>();
    for (const r of this.matData()) {
      if (!this.isVisible(r.category)) continue;
      totals.set(r.category, (totals.get(r.category) ?? 0) + r.total);
    }
    return [...totals.entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c);
  });

  /** MAT categories split into groups (sortOrder, "Bez grupy" last), like the daily chart filter. */
  protected readonly matGroups = computed(() => {
    const excluded = this.matExcluded();
    return groupCategories(this.matCategories(), this.groupMap(), this.groupKeys()).map((g) => ({
      ...g,
      label: groupLabel(g.group),
      color: this.groupColor(g.group),
      includedCount: g.categories.filter((c) => !excluded.has(c)).length,
    }));
  });

  /** Same semantics as the pivot's group checkbox, persisted in the MAT key. */
  protected toggleMatGroup(categories: string[]): void {
    this.matExcluded.update((set) => {
      const next = toggleGroupExclusion(set, categories);
      localStorage.setItem(Reports.MAT_EXCLUDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  protected matIncluded(category: string): boolean {
    return !this.matExcluded().has(category);
  }

  protected toggleMatCategory(category: string): void {
    this.matExcluded.update((set) => {
      const next = new Set(set);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      localStorage.setItem(Reports.MAT_EXCLUDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  protected matSetAll(include: boolean): void {
    this.matExcluded.update(() => {
      const next = include ? new Set<string>() : new Set(this.matCategories());
      localStorage.setItem(Reports.MAT_EXCLUDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  /** Per displayed month: that month's net total and the rolling 12-month average (both over included categories). */
  protected readonly matRows = computed<{ month: string; monthly: number; mat: number; window: number }[]>(() => {
    const excluded = this.matExcluded();
    const first = this.firstMonth();
    const byMonth = new Map<string, number>();
    for (const r of this.matData()) {
      if (excluded.has(r.category) || !this.isVisible(r.category)) continue;
      byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + r.total);
    }
    return this.months().map((m) => {
      let sum = 0;
      let window = 0;
      for (let i = 0; i < 12; i++) {
        const wm = shiftMonth(m, -i);
        if (wm < first) break; // no data before the first month – don't dilute the average with empty months
        window++;
        sum += byMonth.get(wm) ?? 0;
      }
      return { month: m, monthly: byMonth.get(m) ?? 0, mat: window ? sum / window : 0, window };
    });
  });

  // SVG chart geometry
  protected readonly chartW = 1200;
  protected readonly chartH = 280;
  protected readonly chartPad = { l: 70, r: 16, t: 12, b: 36 };

  protected readonly matMax = computed(() => Math.max(1, ...this.matRows().flatMap((r) => [Math.abs(r.mat), Math.abs(r.monthly)])));

  protected chartX(i: number): number {
    const n = Math.max(1, this.matRows().length - 1);
    return this.chartPad.l + (i * (this.chartW - this.chartPad.l - this.chartPad.r)) / n;
  }

  protected chartY(value: number): number {
    const h = this.chartH - this.chartPad.t - this.chartPad.b;
    return this.chartPad.t + h - (Math.abs(value) / this.matMax()) * h;
  }

  protected readonly matPath = computed(() =>
    this.matRows().map((r, i) => `${i === 0 ? 'M' : 'L'}${this.chartX(i).toFixed(1)},${this.chartY(r.mat).toFixed(1)}`).join(' '),
  );

  /** Y-axis gridlines (4 steps). */
  protected readonly matTicks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: this.chartY(f * this.matMax()), value: -f * this.matMax() })));

  protected barHeight(value: number): number {
    return this.chartH - this.chartPad.b - this.chartY(value);
  }

  // --- daily cumulative: "Wydatki narastająco" ------------------------------
  private static readonly DAILY_EXCLUDED_KEY = 'reports.daily.excludedCategories';
  protected readonly dailyExcluded = signal<Set<string>>(new Set(JSON.parse(localStorage.getItem(Reports.DAILY_EXCLUDED_KEY) ?? '[]')));
  /** Month shown in the chart ('YYYY-MM'); independent of the page's Od–Do filter. */
  protected readonly dailyMonth = signal(this.currentMonth);
  protected readonly dailyLoading = signal(false);
  protected readonly dailyRows = signal<CategoryDetail[]>([]);
  protected readonly dailyPrevRows = signal<CategoryDetail[]>([]);

  protected readonly dailyCur = computed(() => aggregateMonth(this.dailyRows(), this.dailyMonth()));
  protected readonly dailyPrev = computed(() => aggregateMonth(this.dailyPrevRows(), shiftMonth(this.dailyMonth(), -1)));
  /** Categories passing the group filter (legend): current month's order, then categories present only in the previous month. */
  protected readonly dailyCategories = computed(() => mergeCategories(this.dailyCur(), this.dailyPrev()).filter((c) => this.isVisible(c)));
  /** Categories left out of the bars and totals: unticked ones plus those hidden by the group filter. */
  protected readonly dailyOmitted = computed(() => {
    const out = new Set(this.dailyExcluded());
    for (const c of mergeCategories(this.dailyCur(), this.dailyPrev())) if (!this.isVisible(c)) out.add(c);
    return out;
  });
  protected readonly dailyColors = computed(() => new Map(this.dailyCategories().map((c, i) => [c, PIE_COLORS[i % PIE_COLORS.length]])));
  protected readonly dailyIsCurrent = computed(() => this.dailyMonth() === this.currentMonth);
  /** Days drawn as bars: whole month for past months, up to today for the current one. */
  protected readonly dailyElapsed = computed(() => elapsedDays(this.dailyMonth(), new Date()));
  protected readonly dailyTotals = computed(() => totalSeries(this.dailyCur(), this.dailyOmitted()));
  protected readonly dailyPrevTotals = computed(() => totalSeries(this.dailyPrev(), this.dailyOmitted()));
  /** Net total of included categories up to today (or the whole month). */
  protected readonly dailyTotal = computed(() => (this.dailyElapsed() ? this.dailyTotals()[this.dailyElapsed() - 1] : 0));
  /** Previous month's cumulative total at the same day index. */
  protected readonly dailyPrevSameDay = computed(() => {
    const p = this.dailyPrevTotals();
    const e = Math.min(this.dailyElapsed(), p.length);
    return e ? p[e - 1] : 0;
  });
  protected readonly dailyForecast = computed(() => forecast(this.dailyTotal(), this.dailyElapsed(), this.dailyCur().days));
  protected readonly dailyMonthLabel = computed(() => {
    const [y, m] = this.dailyMonth().split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('pl', { month: 'long', year: 'numeric' });
  });

  /** Group toggles above the daily legend: visible legend categories bucketed by group (groupKeys order). */
  protected readonly dailyGroups = computed(() => {
    const excluded = this.dailyExcluded();
    return groupCategories(this.dailyCategories(), this.groupMap(), this.groupKeys()).map((g) => ({
      ...g,
      label: groupLabel(g.group),
      color: this.groupColor(g.group),
      includedCount: g.categories.filter((c) => !excluded.has(c)).length,
    }));
  });

  /** Same semantics as the pivot's group checkbox, persisted in the daily key. */
  protected toggleDailyGroup(categories: string[]): void {
    this.dailyExcluded.update((set) => {
      const next = toggleGroupExclusion(set, categories);
      localStorage.setItem(Reports.DAILY_EXCLUDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  protected dailyIncluded(category: string): boolean {
    return !this.dailyExcluded().has(category);
  }

  protected toggleDailyCategory(category: string): void {
    this.dailyExcluded.update((set) => {
      const next = new Set(set);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      localStorage.setItem(Reports.DAILY_EXCLUDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  protected dailySetAll(include: boolean): void {
    this.dailyExcluded.update(() => {
      const next = include ? new Set<string>() : new Set(this.dailyCategories());
      localStorage.setItem(Reports.DAILY_EXCLUDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  protected setDailyMonth(month: string): void {
    this.dailyMonth.set(month);
    this.loadDaily();
  }

  protected shiftDailyMonth(delta: number): void {
    this.setDailyMonth(shiftMonth(this.dailyMonth(), delta));
  }

  // --- daily cumulative: drill-down ("what is inside this cumulative bar") -----
  /** Clicked segment: category and the day its bar ends on; null = panel closed. */
  protected readonly dailyDrill = signal<{ category: string; month: string; day: number } | null>(null);
  protected readonly dailyDrillRows = signal<CategoryDetail[]>([]);
  protected readonly dailyDrillLoading = signal(false);
  protected readonly dailyDrillTotal = computed(() => this.dailyDrillRows().reduce((s, r) => s + r.amountPln, 0));

  /**
   * Opens the panel with the category's transactions of the chart's month from day 1 to `day` inclusive.
   * The endpoint is month-granular, so the day cut-off is applied client-side.
   */
  protected openDailyDrill(category: string, day: number): void {
    const month = this.dailyMonth();
    const until = dayLabel(month, day);
    const noCategory = category === NO_CATEGORY;
    this.dailyDrill.set({ category, month, day });
    this.dailyDrillLoading.set(true);
    this.service.categoryMonthlyDetails(month, month, noCategory ? undefined : category).subscribe({
      next: (rows) => {
        const d = this.dailyDrill();
        if (!d || d.month !== month || d.category !== category || d.day !== day) return; // stale response
        this.dailyDrillRows.set(rows.filter((r) => r.operationDate <= until && (!noCategory || !r.category)));
        this.dailyDrillLoading.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? 'Nie udało się pobrać szczegółów.');
        this.dailyDrillLoading.set(false);
      },
    });
  }

  protected closeDailyDrill(): void {
    this.dailyDrill.set(null);
    this.dailyDrillRows.set([]);
  }

  /** e.g. "Jedzenie · 1–15.03.2026". */
  protected dailyDrillTitle(): string {
    const d = this.dailyDrill();
    if (!d) return '';
    const [y, m] = d.month.split('-');
    return `${d.category} · 1–${d.day}.${m}.${y}`;
  }

  protected loadDaily(): void {
    const month = this.dailyMonth();
    const prev = shiftMonth(month, -1);
    this.closeDailyDrill();
    this.dailyLoading.set(true);
    forkJoin({
      cur: this.service.categoryMonthlyDetails(month, month),
      prev: this.service.categoryMonthlyDetails(prev, prev),
    }).subscribe({
      next: ({ cur, prev: prevRows }) => {
        if (this.dailyMonth() !== month) return; // stale response after a quick month change
        this.dailyRows.set(cur);
        this.dailyPrevRows.set(prevRows);
        this.dailyLoading.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? 'Nie udało się pobrać dziennych wydatków.');
        this.dailyLoading.set(false);
      },
    });
  }

  // daily chart geometry (spending drawn upwards, net inflows below the zero axis)
  protected readonly dailyW = 1200;
  protected readonly dailyH = 320;
  protected readonly dailyPad = { l: 70, r: 16, t: 28, b: 36 };
  protected readonly dailySlot = computed(() => (this.dailyW - this.dailyPad.l - this.dailyPad.r) / this.dailyCur().days);

  /** Left edge of the day's cell (1-based day). */
  protected dailyX(day: number): number {
    return this.dailyPad.l + (day - 1) * this.dailySlot();
  }

  protected dailyCX(day: number): number {
    return this.dailyX(day) + this.dailySlot() / 2;
  }

  /** Y range: `up` = largest stacked spending, `down` = largest stacked net inflow (both ≥ 0, in PLN). */
  protected readonly dailyScale = computed(() => {
    const cur = this.dailyCur();
    const excluded = this.dailyOmitted();
    let up = 0;
    let down = 0;
    for (let i = 0; i < this.dailyElapsed(); i++) {
      let u = 0;
      let d = 0;
      for (const c of cur.categories) {
        if (excluded.has(c)) continue;
        const v = cur.cumulative[c][i];
        if (v < 0) u -= v;
        else d += v;
      }
      up = Math.max(up, u);
      down = Math.max(down, d);
    }
    for (const v of this.dailyPrevTotals().slice(0, cur.days)) {
      if (v < 0) up = Math.max(up, -v);
      else down = Math.max(down, v);
    }
    const step = niceStep(up + down || 1);
    up = Math.max(up, step);
    const k = (this.dailyH - this.dailyPad.t - this.dailyPad.b) / (up + down);
    return { up, down, step, k, zeroY: this.dailyPad.t + up * k };
  });

  /** SVG y of a net value (negative = spending → above the zero axis). */
  protected dailyY(net: number): number {
    const s = this.dailyScale();
    return s.zeroY + net * s.k;
  }

  /** Gridlines labelled with net values (spending negative), like the MAT chart. */
  protected readonly dailyTicks = computed(() => {
    const s = this.dailyScale();
    return ticks(s.up, s.down, s.step).map((v) => ({ y: this.dailyY(-v), value: -v }));
  });

  protected readonly dailySegments = computed<DailySegment[]>(() => {
    const cur = this.dailyCur();
    const excluded = this.dailyOmitted();
    const colors = this.dailyColors();
    const totals = this.dailyTotals();
    const { zeroY, k } = this.dailyScale();
    const slot = this.dailySlot();
    const w = slot * 0.72;
    const out: DailySegment[] = [];
    for (let i = 0; i < this.dailyElapsed(); i++) {
      let upAcc = 0;
      let downAcc = 0;
      for (const c of cur.categories) {
        if (excluded.has(c)) continue;
        const cum = cur.cumulative[c][i];
        if (!cum) continue;
        const h = Math.abs(cum) * k;
        let y: number;
        if (cum < 0) {
          upAcc += h;
          y = zeroY - upAcc;
        } else {
          y = zeroY + downAcc;
          downAcc += h;
        }
        const amount = cur.daily[c][i];
        const pln = (v: number) => `${formatNumber(v, 'pl', '1.2-2')} zł`;
        out.push({
          key: `${i}|${c}`, category: c, day: i + 1, date: dayLabel(cur.month, i + 1),
          x: this.dailyX(i + 1) + (slot - w) / 2, y, h, color: colors.get(c) ?? PIE_COLORS[0],
          amount, cum, cumTotal: totals[i],
          tip: `${dayLabel(cur.month, i + 1)} · ${c}\ndzień: ${pln(amount)}\nnarastająco w kategorii: ${pln(cum)}\nnarastająco razem: ${pln(totals[i])}`,
        });
      }
    }
    return out;
  });

  protected readonly dailyBarW = computed(() => this.dailySlot() * 0.72);

  /** Previous month's cumulative total by day index (clipped to the current month's length). */
  protected readonly dailyPrevPoints = computed(() =>
    this.dailyPrevTotals()
      .slice(0, this.dailyCur().days)
      .map((v, i) => `${this.dailyCX(i + 1).toFixed(1)},${this.dailyY(v).toFixed(1)}`)
      .join(' '),
  );

  protected readonly dailyPrevLast = computed(() => {
    const p = this.dailyPrevTotals().slice(0, this.dailyCur().days);
    return p.length ? { x: this.dailyCX(p.length), y: this.dailyY(p[p.length - 1]) } : null;
  });

  /** Y of the net-total label above the last drawn bar. */
  protected readonly dailyLabelY = computed(() => {
    const e = this.dailyElapsed();
    const ys = this.dailySegments().filter((s) => s.day === e).map((s) => s.y);
    return (ys.length ? Math.min(...ys) : this.dailyScale().zeroY) - 6;
  });

  protected readonly dailyDays = computed(() => Array.from({ length: this.dailyCur().days }, (_, i) => i + 1));

  // daily donut: share of each included category in the cumulative spending up to the last drawn day
  protected readonly dailyPieC = 110;
  protected readonly dailyPieSlices = computed(() => {
    const colors = this.dailyColors();
    const shares = cumulativeShares(this.dailyCur(), this.dailyElapsed(), this.dailyOmitted());
    const pln = (v: number) => `${formatNumber(v, 'pl', '1.0-0')} zł`;
    return donutSlices(shares, (x) => x.value, this.dailyPieC, 100, 58).map((s) => ({
      category: s.item.category, value: s.value, pct: s.pct, path: s.path, labelX: s.labelX, labelY: s.labelY,
      color: colors.get(s.item.category) ?? PIE_COLORS[0],
      tip: `${s.item.category} · ${pln(s.value)} · ${formatNumber(s.pct, 'pl', '1.1-1')} %`,
    }));
  });
  protected readonly dailyPieTotal = computed(() => this.dailyPieSlices().reduce((s, x) => s + x.value, 0));

  // --- report 8: recurring ------------------------------------------------
  protected readonly showInactive = signal(false);
  protected readonly recurringRows = computed(() =>
    this.recurring().filter((r) => this.showInactive() || r.active),
  );
  protected readonly recurringMonthlyTotal = computed(() =>
    this.recurringRows().reduce((s, r) => s + r.monthlyAvg12m, 0),
  );

  ngOnInit(): void {
    this.load();
    this.loadDaily();
  }

  protected load(): void {
    if (this.from > this.to) {
      [this.from, this.to] = [this.to, this.from];
    }
    this.fromApplied.set(this.from);
    this.toApplied.set(this.to);
    this.loading.set(true);
    this.error.set(null);
    forkJoin({
      categories: this.service.categoryMonthly(this.from, this.to),
      mat: this.service.categoryMonthly(shiftMonth(this.from, -11), this.to),
      recurring: this.service.recurring(3),
      hygiene: this.service.hygiene(),
    }).subscribe({
      next: ({ categories, mat, recurring, hygiene }) => {
        this.categoryData.set(categories);
        this.matData.set(mat);
        this.recurring.set(recurring);
        this.hygiene.set(hygiene);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? 'Nie udało się pobrać raportów.');
        this.loading.set(false);
      },
    });
  }

  protected toggleInactive(): void {
    this.showInactive.update((v) => !v);
  }

}
