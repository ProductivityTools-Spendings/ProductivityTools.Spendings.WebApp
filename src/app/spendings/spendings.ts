import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { Spending } from '../models/spending';
import { FillResult, RefundState, SpendingService } from '../services/spending.service';
import { EmailService, ProcessingResult } from '../services/email.service';
import { AllegroPurchase, AllegroService } from '../services/allegro.service';
import { openPreviewWindow, showHtmlInWindow } from '../services/mbank-raw-email.service';

type Action = 'process' | 'fillAccounts' | 'fillCategories' | 'markDuplicates' | 'fillPln';

@Component({
  selector: 'app-spendings',
  imports: [CurrencyPipe, DecimalPipe, FormsModule, RouterLink],
  templateUrl: './spendings.html',
  styleUrl: './spendings.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Spendings implements OnInit {
  private readonly spendingService = inject(SpendingService);
  private readonly emailService = inject(EmailService);
  private readonly allegroService = inject(AllegroService);

  // --- Allegro order popup ----------------------------------------------------
  /** Spending whose Allegro order is shown in the popup; null = closed. */
  protected readonly allegroPopup = signal<Spending | null>(null);
  protected readonly allegroItems = signal<AllegroPurchase[]>([]);
  protected readonly allegroLoading = signal(false);
  protected readonly allegroItemsTotal = computed(() => this.allegroItems().reduce((sum, p) => sum + p.itemCost, 0));

  protected openAllegro(s: Spending): void {
    if (s.allegroRawEmailId === null) return;
    this.allegroPopup.set(s);
    this.allegroItems.set([]);
    this.allegroLoading.set(true);
    this.allegroService.getPurchasesForEmail(s.allegroRawEmailId).subscribe({
      next: (items) => {
        this.allegroItems.set(items);
        this.allegroLoading.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? 'Nie udało się pobrać zamówienia Allegro.');
        this.allegroLoading.set(false);
      },
    });
  }

  protected closeAllegro(): void {
    this.allegroPopup.set(null);
  }

  /** Opens the original Allegro e-mail in a new tab. */
  protected showAllegroEmail(): void {
    const s = this.allegroPopup();
    if (!s || s.allegroRawEmailId === null) return;
    const preview = openPreviewWindow();
    this.allegroService.downloadEmail(s.allegroRawEmailId).subscribe({
      next: (file) => showHtmlInWindow(preview, file.blob),
      error: () => preview?.close(),
    });
  }

  protected readonly spendings = signal<Spending[]>([]);

  // --- inline edit of category / note ---------------------------------------
  /** Row being edited with its draft values; null = nothing in edit mode. */
  protected readonly editing = signal<{ id: number; category: string; note: string } | null>(null);
  protected readonly saving = signal(false);
  protected readonly categories = signal<string[]>([]);

  protected startEdit(s: Spending): void {
    if (this.saving() || this.editing()?.id === s.id) return;
    this.editing.set({ id: s.id, category: s.category ?? '', note: s.note ?? '' });
  }

  /** Dictionary categories plus the row's current value when it is not in the dictionary (legacy data). */
  protected readonly categoryOptions = computed(() => {
    const current = this.editing()?.category;
    const list = this.categories();
    return current && !list.includes(current) ? [current, ...list] : list;
  });

  protected cancelEdit(): void {
    this.editing.set(null);
  }

  protected isEditing(s: Spending): boolean {
    return this.editing()?.id === s.id;
  }

  protected saveEdit(): void {
    const draft = this.editing();
    if (!draft) return;
    const category = draft.category.trim() || null;
    const note = draft.note.trim() || null;
    this.saving.set(true);
    this.spendingService.updateAnnotations(draft.id, category, note).subscribe({
      next: (res) => {
        // apply to the row and to its duplicate twins, exactly as the API did
        const twins = new Set<number>([draft.id]);
        for (const s of this.spendings()) {
          if (s.id === draft.id && s.duplicateOf !== null) twins.add(s.duplicateOf);
          if (s.duplicateOf === draft.id) twins.add(s.id);
        }
        this.spendings.update((rows) =>
          rows.map((s) => (twins.has(s.id) ? { ...s, category: res.category, note: res.note } : s)),
        );
        if (res.category && !this.categories().includes(res.category)) {
          this.categories.update((c) => [...c, res.category!].sort((a, b) => a.localeCompare(b, 'pl')));
        }
        this.editing.set(null);
        this.saving.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? 'Nie udało się zapisać kategorii/notatki.');
        this.saving.set(false);
      },
    });
  }

  /** Category picked from the dropdown – saved immediately, no Enter needed (the note keeps its draft). */
  protected onCategoryPicked(category: string): void {
    const draft = this.editing();
    if (!draft) return;
    this.editing.set({ ...draft, category });
    this.saveEdit();
  }

  protected onEditKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.saveEdit();
    } else if (event.key === 'Escape') {
      this.cancelEdit();
    }
  }

  protected readonly hideDuplicates = signal(true);

  // --- refund marking / linking ----------------------------------------------
  /** Expense for which the user is currently picking a refund row; null = link mode off. */
  protected readonly linkingFor = signal<Spending | null>(null);
  /** Ids of rows with a refund request in flight (their buttons are disabled). */
  protected readonly refundBusy = signal<Set<number>>(new Set());
  /** In link mode: true for rows whose amount is the exact opposite of the expense (likely refund candidates). */
  protected isRefundCandidate(s: Spending): boolean {
    const expense = this.linkingFor();
    if (!expense || s.id === expense.id) return false;
    const a = s.amountPln ?? s.amount;
    const e = expense.amountPln ?? expense.amount;
    return a > 0 && Math.abs(a + e) < 0.005;
  }

  /** Row briefly highlighted after a badge click; null = none. */
  protected readonly highlight = signal<number | null>(null);
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;

  /** Red background only while the refund is expected but not linked yet. */
  protected isRefundExpected(s: Spending): boolean {
    return s.refundExpected && s.refundSpendingId === null;
  }

  protected isRefundBusy(s: Spending): boolean {
    return this.refundBusy().has(s.id);
  }

  protected expectRefund(s: Spending): void {
    this.refundRequest(s.id, this.spendingService.expectRefund(s.id), (state) => this.applyRefundState(state));
  }

  protected startLinking(s: Spending): void {
    this.linkingFor.set(s);
  }

  protected cancelLinking(): void {
    this.linkingFor.set(null);
  }

  /** Links the expense in link mode with `refund` and leaves link mode. */
  protected linkRefund(refund: Spending): void {
    const expense = this.linkingFor();
    if (!expense || expense.id === refund.id) return;
    this.refundRequest(expense.id, this.spendingService.linkRefund(expense.id, refund.id), (state) => {
      this.applyRefundState(state);
      this.linkingFor.set(null);
    });
  }

  /** Removes the flag and the link; the refund row loses its back-reference locally. */
  protected clearRefund(s: Spending): void {
    const linked = s.refundSpendingId;
    this.refundRequest(s.id, this.spendingService.clearRefund(s.id), (state) => {
      this.applyRefundState(state);
      if (linked !== null) {
        this.spendings.update((rows) => rows.map((r) => (r.id === linked ? { ...r, refundOfSpendingId: null } : r)));
      }
    });
  }

  private refundRequest(id: number, request: Observable<RefundState>, apply: (state: RefundState) => void): void {
    if (this.refundBusy().has(id)) return;
    this.refundBusy.update((set) => new Set(set).add(id));
    const release = () =>
      this.refundBusy.update((set) => {
        const next = new Set(set);
        next.delete(id);
        return next;
      });
    request.subscribe({
      next: (state) => {
        apply(state);
        release();
      },
      error: (err) => {
        this.error.set(err?.message ?? 'Nie udało się zapisać oznaczenia zwrotu.');
        release();
      },
    });
  }

  /** Writes the expense's state and the matching back-reference on its refund row. */
  private applyRefundState(state: RefundState): void {
    this.spendings.update((rows) =>
      rows.map((r) => {
        if (r.id === state.spendingId) {
          return {
            ...r,
            refundExpected: state.refundExpected,
            refundSpendingId: state.refundSpendingId,
            refundOfSpendingId: state.refundOfSpendingId,
          };
        }
        if (r.id === state.refundSpendingId) return { ...r, refundOfSpendingId: state.spendingId };
        return r;
      }),
    );
  }

  /** Scrolls to the given row and highlights it for 2 s. */
  protected focusRow(id: number): void {
    document.getElementById(`spending-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.highlight.set(id);
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => this.highlight.set(null), 2000);
  }
  protected readonly visibleSpendings = computed(() =>
    this.hideDuplicates() ? this.spendings().filter((s) => s.duplicateOf === null) : this.spendings(),
  );

  // ---- column filters ----
  /** Per-column filter values (empty = no filter). */
  protected readonly filters = signal<ColumnFilters>({ ...EMPTY_FILTERS });
  protected readonly hasFilters = computed(() => Object.values(this.filters()).some((v) => v !== ''));

  /** Distinct values for the select filters, computed from the loaded rows. */
  protected readonly typeOptions = computed(() => distinct(this.visibleSpendings().map((s) => s.operationType)));
  protected readonly accountOptions = computed(() => distinct(this.visibleSpendings().map((s) => s.account)));
  protected readonly categoryFilterOptions = computed(() => distinct(this.visibleSpendings().map((s) => s.category)));

  /** Rows shown in the table: duplicates toggle + column filters. */
  protected readonly filteredSpendings = computed(() => {
    const f = this.filters();
    const rows = this.visibleSpendings();
    if (!Object.values(f).some((v) => v !== '')) return rows;
    const amountMatcher = parseAmountFilter(f.amount);
    return rows.filter((s) =>
      contains(String(s.id), f.id) &&
      contains(s.operationDate, f.date) &&
      contains(s.operationTime, f.time) &&
      equalsOrEmpty(s.operationType, f.type) &&
      (contains(s.name, f.name) || (f.name !== '' && contains(s.details, f.name))) &&
      amountMatcher(s.amountPln ?? s.amount) &&
      equalsOrEmpty(s.account, f.account) &&
      equalsOrEmpty(s.category, f.category) &&
      matchesAllegro(s, f.allegro) &&
      matchesRefund(s, f.refund) &&
      contains(s.note, f.note),
    );
  });

  protected setFilter(key: keyof ColumnFilters, value: string): void {
    this.filters.update((f) => ({ ...f, [key]: value ?? '' }));
  }

  protected clearFilters(): void {
    this.filters.set({ ...EMPTY_FILTERS });
  }
  protected readonly duplicateCount = computed(() => this.spendings().filter((s) => s.duplicateOf !== null).length);
  /** Ids of canonical rows that have at least one duplicate pointing at them. */
  protected readonly primaryIds = computed(
    () => new Set(this.spendings().filter((s) => s.duplicateOf !== null).map((s) => s.duplicateOf as number)),
  );

  protected isPrimary(s: Spending): boolean {
    return this.primaryIds().has(s.id);
  }
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Which maintenance action is currently running (null = none). */
  protected readonly runningAction = signal<Action | null>(null);
  protected readonly statusMessage = signal<string | null>(null);
  protected readonly statusFailed = signal(false);

  ngOnInit(): void {
    this.load();
    this.spendingService.getCategories().subscribe({ next: (c) => this.categories.set(c), error: () => undefined });
  }

  protected get busy(): boolean {
    return this.loading() || this.runningAction() !== null;
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.linkingFor.set(null);
    this.spendingService.getAll().subscribe({
      next: (data) => {
        this.spendings.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? 'Nie udało się pobrać transakcji.');
        this.loading.set(false);
      },
    });
  }

  /** Triggers server-side processing of raw e-mails (NEW + ERROR), then refreshes the list. */
  protected processEmails(): void {
    this.run('process', this.emailService.process(), (r) => ({
      message: this.describeProcessing(r),
      failed: !r.started,
      reload: r.started,
    }));
  }

  /** Fills missing accounts from dictionary_account. */
  protected fillAccounts(): void {
    this.run('fillAccounts', this.spendingService.fillAccounts(), (r) => ({
      message: this.describeFill('rachunki', 'bez rachunku', r),
      failed: false,
      reload: r.updated > 0,
    }));
  }

  /** Fills missing categories from account rules and dictionary_category_mapping. */
  protected fillCategories(): void {
    this.run('fillCategories', this.spendingService.fillCategories(), (r) => ({
      message: this.describeFill('kategorie', 'bez kategorii', r),
      failed: false,
      reload: r.updated > 0,
    }));
  }

  /** Converts foreign-currency amounts to PLN using NBP rates. */
  protected fillPln(): void {
    this.run('fillPln', this.spendingService.fillPln(), (r) => ({
      message: `Przeliczono na PLN: ${r.updated}. Nadal bez kwoty PLN: ${r.remainingEmpty}.`,
      failed: false,
      reload: r.updated > 0,
    }));
  }

  protected isForeign(s: Spending): boolean {
    return !!s.currency && s.currency !== 'PLN';
  }

  /** Tooltip explaining how the PLN amount was derived. */
  protected plnTitle(s: Spending): string {
    if (!this.isForeign(s)) return '';
    if (s.amountPln === null) return 'Brak kursu NBP – kliknij „Przelicz na PLN”';
    return `Kurs średni NBP z ${s.fxRateDate} (ostatni dzień roboczy przed operacją)`;
  }

  /** Marks debits that mirror an outgoing transfer as duplicates. */
  protected markDuplicates(): void {
    this.run('markDuplicates', this.spendingService.markDuplicates(), (r) => ({
      message: `Oznaczono nowych duplikatów: ${r.updated}. Łącznie duplikatów: ${r.remainingEmpty}.`,
      failed: false,
      reload: r.updated > 0,
    }));
  }

  protected toggleDuplicates(): void {
    this.hideDuplicates.update((v) => !v);
  }

  private run<T>(
    action: Action,
    request: Observable<T>,
    describe: (result: T) => { message: string; failed: boolean; reload: boolean },
  ): void {
    this.runningAction.set(action);
    this.statusMessage.set(null);
    this.statusFailed.set(false);
    request.subscribe({
      next: (result) => {
        const { message, failed, reload } = describe(result);
        this.statusMessage.set(message);
        this.statusFailed.set(failed);
        this.runningAction.set(null);
        if (reload) {
          this.load();
        }
      },
      error: (err) => {
        this.statusMessage.set(err?.message ?? 'Operacja nie powiodła się.');
        this.statusFailed.set(true);
        this.runningAction.set(null);
      },
    });
  }

  private describeProcessing(r: ProcessingResult): string {
    if (!r.started) {
      return `Przetwarzanie już trwa w tle – spróbuj za chwilę (oczekujące: ${r.remainingNew}).`;
    }
    const parts = [`przetworzono ${r.processed}`];
    if (r.resetFromError > 0) {
      parts.push(`ponowiono z błędem ${r.resetFromError}`);
    }
    if (r.remainingError > 0) {
      parts.push(`nadal z błędem ${r.remainingError}`);
    }
    if (r.remainingNew > 0) {
      parts.push(`oczekujące ${r.remainingNew}`);
    }
    return `Gotowe: ${parts.join(', ')}.`;
  }

  private describeFill(what: string, missingLabel: string, r: FillResult): string {
    return `Uzupełniono ${what}: ${r.updated}. Nadal ${missingLabel}: ${r.remainingEmpty}.`;
  }
}

/** Filter value per table column. Select filters use '' = all, NONE = empty value. */
interface ColumnFilters {
  id: string;
  date: string;
  time: string;
  type: string;
  name: string;
  amount: string;
  account: string;
  category: string;
  allegro: string;
  refund: string;
  note: string;
}

const EMPTY_FILTERS: ColumnFilters = {
  id: '', date: '', time: '', type: '', name: '', amount: '',
  account: '', category: '', allegro: '', refund: '', note: '',
};

/** Select-filter value meaning "no value" (e.g. spendings without a category). */
const NONE = '__none__';

function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, 'pl'));
}

/** Case-insensitive "contains"; an empty filter matches everything. */
function contains(value: string | null | undefined, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return (value ?? '').toLowerCase().includes(f);
}

function equalsOrEmpty(value: string | null | undefined, filter: string): boolean {
  if (!filter) return true;
  if (filter === NONE) return !value;
  return value === filter;
}

/**
 * Amount filter syntax: "123" (equal or equal absolute value, also "123,45"), ">100", "<-50", ">=10", "<=10", "10..50" (range),
 * "-" prefix works for expenses (amounts are negative). Invalid input matches everything.
 */
function parseAmountFilter(raw: string): (amount: number | null) => boolean {
  const f = raw.trim().replace(/\s/g, '').replace(/,/g, '.');
  if (!f) return () => true;
  const range = f.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return (x) => x !== null && x >= lo && x <= hi;
  }
  const cmp = f.match(/^(>=|<=|>|<|=)?(-?\d+(?:\.\d+)?)$/);
  if (!cmp) return () => true;
  const n = Number(cmp[2]);
  switch (cmp[1]) {
    case '>': return (x) => x !== null && x > n;
    case '<': return (x) => x !== null && x < n;
    case '>=': return (x) => x !== null && x >= n;
    case '<=': return (x) => x !== null && x <= n;
    // a plain positive number also finds the expense with the same absolute value (12,99 -> -12,99)
    default: return (x) => x !== null && (Math.abs(x - n) < 0.005 || (n > 0 && Math.abs(Math.abs(x) - n) < 0.005));
  }
}

function matchesAllegro(s: Spending, filter: string): boolean {
  if (filter === 'yes') return s.allegroRawEmailId !== null;
  if (filter === 'no') return s.allegroRawEmailId === null;
  return true;
}

function matchesRefund(s: Spending, filter: string): boolean {
  switch (filter) {
    case 'expected': return s.refundExpected && s.refundSpendingId === null;
    case 'linked': return s.refundSpendingId !== null;
    case 'refund': return s.refundOfSpendingId !== null;
    case 'none': return !s.refundExpected && s.refundSpendingId === null && s.refundOfSpendingId === null;
    default: return true;
  }
}
