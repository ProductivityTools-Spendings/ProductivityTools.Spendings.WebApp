import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { CategoryDetail, Hygiene, ReportService } from '../services/report.service';
import { aggregateMonth, cumulativeShares, donutSlices, elapsedDays, shiftMonth } from '../reports/daily-cumulative';
import { resolveCategoryColor } from '../reports/category-colors';

/** Same localStorage key as the desktop "Wydatki narastająco" section – the category selection is shared. */
const DAILY_EXCLUDED_KEY = 'reports.daily.excludedCategories';

function ym(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Separate reports page for phones. For now a single report: the donut of cumulative spending of a month
 * ("Wydatki narastająco") with amounts on the slices and a legend list below.
 */
@Component({
  selector: 'app-mobile-reports',
  imports: [DecimalPipe, RouterLink],
  templateUrl: './mobile-reports.html',
  styleUrl: './mobile-reports.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MobileReports implements OnInit {
  private readonly service = inject(ReportService);

  protected readonly currentMonth = ym(new Date());
  protected readonly month = signal(this.currentMonth);
  protected readonly rows = signal<CategoryDetail[]>([]);
  protected readonly hygiene = signal<Hygiene | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Categories unticked in the desktop "Wydatki narastająco" section are left out here too. */
  private readonly excluded = new Set<string>(JSON.parse(localStorage.getItem(DAILY_EXCLUDED_KEY) ?? '[]'));

  protected readonly isCurrent = computed(() => this.month() === this.currentMonth);
  protected readonly monthLabel = computed(() => {
    const [y, m] = this.month().split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('pl', { month: 'long', year: 'numeric' });
  });
  /** Days included: up to today for the current month, the whole month otherwise. */
  protected readonly elapsed = computed(() => elapsedDays(this.month(), new Date()));

  private readonly ownColors = computed(() => new Map(Object.entries(this.hygiene()?.categoryColors ?? {})));
  private readonly paletteIndex = computed(() => new Map((this.hygiene()?.categoryNames ?? []).map((c, i) => [c, i])));

  // donut geometry (viewBox 0 0 2C 2C)
  protected readonly C = 150;
  private readonly R = 140;
  private readonly r = 80;

  protected readonly slices = computed(() => {
    const monthData = aggregateMonth(this.rows(), this.month());
    const shares = cumulativeShares(monthData, this.elapsed(), this.excluded);
    return donutSlices(shares, (x) => x.value, this.C, this.R, this.r).map((s) => ({
      category: s.item.category,
      value: s.value,
      pct: s.pct,
      path: s.path,
      labelX: s.labelX,
      labelY: s.labelY,
      color: resolveCategoryColor(s.item.category, this.ownColors(), this.paletteIndex()),
    }));
  });

  protected readonly total = computed(() => this.slices().reduce((sum, s) => sum + s.value, 0));

  ngOnInit(): void {
    this.service.hygiene().subscribe({ next: (h) => this.hygiene.set(h), error: () => {} });
    this.load();
  }

  protected shiftMonth(delta: number): void {
    const next = shiftMonth(this.month(), delta);
    if (next > this.currentMonth) return;
    this.month.set(next);
    this.load();
  }

  protected goToCurrent(): void {
    this.month.set(this.currentMonth);
    this.load();
  }

  private load(): void {
    const month = this.month();
    this.loading.set(true);
    this.error.set(null);
    this.service.categoryMonthlyDetails(month, month).subscribe({
      next: (rows) => {
        if (this.month() !== month) return; // stale response after a quick month change
        this.rows.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? 'Nie udało się pobrać wydatków.');
        this.loading.set(false);
      },
    });
  }
}
