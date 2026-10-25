import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { SpendingService } from '../services/spending.service';

export interface MBankStatementRowDto {
  id: number | null;
  rowIndex: number;
  operationDate: string;
  rawDescription: string;
  title: string;
  operationType: string;
  dstAccount: string | null;
  accountName: string;
  accountMask: string;
  resolvedAccountNumber: string | null;
  mbankCategory: string;
  amount: number;
  currency: string;
  reconciliationStatus: string | null;
  matchedSpendingId: number | null;
  matchType: string | null;
  matchConfidence: number | null;
}

export interface DbSpendingCandidateDto {
  id: number;
  effectiveDate: string;
  rawOperationDate: string;
  title: string;
  operationType: string;
  amount: number;
  currency: string;
  amountPln: number | null;
  srcAccount: string | null;
  dstAccount: string | null;
  categoryName: string | null;
  accountKey: string | null;
}

export interface StatementMatchedItemDto {
  statementRow: MBankStatementRowDto;
  matchedSpending: DbSpendingCandidateDto;
  matchReason: string;
}

export interface StatementCandidateItemDto {
  statementRow: MBankStatementRowDto;
  candidateSpending: DbSpendingCandidateDto;
  dateDiffDays: number;
  reason: string;
}

export interface StatementImportedItemDto {
  statementRow: MBankStatementRowDto;
  linkedSpending: DbSpendingCandidateDto | null;
}

export interface StatementReconciliationSummaryDto {
  periodFrom: string;
  periodTo: string;
  newlyInsertedCount: number;
  alreadyStoredCount: number;
  totalInPeriodCount: number;
  unreconciledCount: number;
  candidateDateShiftCount: number;
  matchedEmailCount: number;
  importedToSpendingsCount: number;
  ignoredCount: number;
  onlyInDbCount: number;
  unreconciledTotalPln: number;
  importedToSpendingsTotalPln: number;
  unreconciledRows: MBankStatementRowDto[];
  candidateRows: StatementCandidateItemDto[];
  importedRows: StatementImportedItemDto[];
  matchedRows: StatementMatchedItemDto[];
  ignoredRows: MBankStatementRowDto[];
  onlyInDbRows: DbSpendingCandidateDto[];
}

type ActiveTab = 'unreconciled' | 'candidates' | 'imported' | 'matched' | 'onlyInDb' | 'ignored';

@Component({
  selector: 'app-statement-import',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './statement-import.html',
  styleUrl: './statement-import.css'
})
export class StatementImport implements OnInit {
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private apiUrl = environment.apiUrl;
  private spendingService = inject(SpendingService);

  selectedFile: File | null = null;
  selectedFileName = '';
  loading = false;
  actionInProgress = false;
  error: string | null = null;
  successMessage: string | null = null;

  periodFrom = '';
  periodTo = '';

  result: StatementReconciliationSummaryDto | null = null;
  activeTab: ActiveTab = 'unreconciled';
  searchQuery = '';
  accountFilter = 'ALL';

  selectedStatementIds = new Set<number>();

  /** Known category names (dictionary_category) offered in the category pickers. */
  categories: string[] = [];
  /** User-chosen category per statement operation id, sent along when promoting to spendings. */
  chosenCategories: Record<number, string> = {};
  bulkCategory = '';

  ngOnInit(): void {
    this.loadReconciliationView();
    this.spendingService.getCategories().subscribe({
      next: (cats) => {
        this.categories = cats;
        this.cdr.detectChanges();
      },
      error: () => { /* category suggestions are optional */ }
    });
  }

  setChosenCategory(id: number | null, value: string): void {
    if (id == null) return;
    if (value && value.trim()) {
      this.chosenCategories[id] = value;
    } else {
      delete this.chosenCategories[id];
    }
  }

  applyBulkCategory(): void {
    const category = this.bulkCategory.trim();
    if (!category) return;
    for (const id of this.selectedStatementIds) {
      this.chosenCategories[id] = category;
    }
    this.cdr.detectChanges();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.selectedFile = input.files[0];
      this.selectedFileName = this.selectedFile.name;
      this.error = null;
      this.successMessage = null;
    }
  }

  loadReconciliationView(): void {
    this.loading = true;
    this.error = null;
    this.cdr.detectChanges();

    const params: Record<string, string> = {};
    if (this.periodFrom) params['from'] = this.periodFrom;
    if (this.periodTo) params['to'] = this.periodTo;

    this.http.get<any>(`${this.apiUrl}/api/mbank-statements/reconciliation`, { params })
      .subscribe({
        next: (res) => {
          this.applyResult(res);
          this.loading = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.error = err?.error?.message || err?.message || 'Błąd podczas pobierania stanu rekonsyliacji.';
          this.loading = false;
          this.cdr.detectChanges();
        }
      });
  }

  importAndReconcile(): void {
    if (!this.selectedFile) {
      this.error = 'Wybierz plik HTML z eksportem mBanku.';
      this.cdr.detectChanges();
      return;
    }

    this.loading = true;
    this.error = null;
    this.successMessage = null;
    this.cdr.detectChanges();

    const formData = new FormData();
    formData.append('file', this.selectedFile);

    this.http.post<any>(`${this.apiUrl}/api/mbank-statements/import`, formData)
      .subscribe({
        next: (res) => {
          const normalized = this.applyResult(res);
          this.loading = false;
          this.successMessage = `Zaimportowano wyciąg (${normalized.newlyInsertedCount} nowych operacji, ${normalized.alreadyStoredCount} już było w bazie). Uzgodniono z wydatkami.`;
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.error = err?.error?.message || err?.message || 'Wystąpił błąd podczas importu i rekonsyliacji wyciągu.';
          this.loading = false;
          this.cdr.detectChanges();
        }
      });
  }

  reRunReconciliation(): void {
    this.actionInProgress = true;
    this.error = null;
    this.successMessage = null;
    this.cdr.detectChanges();

    const body: Record<string, string> = {};
    if (this.periodFrom) body['from'] = this.periodFrom;
    if (this.periodTo) body['to'] = this.periodTo;

    this.http.post<any>(`${this.apiUrl}/api/mbank-statements/reconcile`, body)
      .subscribe({
        next: (res) => {
          this.applyResult(res);
          this.actionInProgress = false;
          this.successMessage = 'Ponownie uruchomiono automatyczną rekonsyliację dla wybranego okresu.';
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.error = err?.error?.message || err?.message || 'Błąd podczas ponownej rekonsyliacji.';
          this.actionInProgress = false;
          this.cdr.detectChanges();
        }
      });
  }

  private applyResult(rawPayload: any): StatementReconciliationSummaryDto {
    const raw = rawPayload?.report ?? rawPayload ?? {};
    const normalizeRow = (r: any, idx = 0): MBankStatementRowDto => ({
      id: r.id ?? null,
      rowIndex: r.rowIndex ?? r.sameDaySequence ?? idx + 1,
      operationDate: r.operationDate ?? '',
      rawDescription: r.rawDescription ?? '',
      title: r.title ?? '',
      operationType: r.operationType ?? '',
      dstAccount: r.dstAccount ?? r.dstAccountFull ?? r.dstAccountShort ?? r.counterpartyAccount ?? null,
      accountName: r.accountName ?? '',
      accountMask: r.accountMask ?? r.srcAccountShort ?? r.accountNumberMask ?? '',
      resolvedAccountNumber: r.resolvedAccountNumber ?? r.srcAccountFull ?? r.fullAccountNumber ?? null,
      mbankCategory: r.mbankCategory ?? '',
      amount: Number(r.amount ?? 0),
      currency: r.currency ?? 'PLN',
      reconciliationStatus: r.reconciliationStatus ?? 'UNRECONCILED',
      matchedSpendingId: r.matchedSpendingId ?? r.spendingId ?? null,
      matchType: r.matchType ?? null,
      matchConfidence: r.matchConfidence ?? r.matchScore ?? null,
    });

    const unreconciledRows: MBankStatementRowDto[] = (raw.unreconciledRows ?? raw.unReconciled ?? [])
      .map((r: any, i: number) => normalizeRow(r, i));

    const candidateRows: StatementCandidateItemDto[] = (raw.candidateRows ?? raw.candidateDateShift ?? [])
      .map((r: any, i: number): StatementCandidateItemDto => ({
        statementRow: r.statementRow ? normalizeRow(r.statementRow, i) : normalizeRow(r, i),
        candidateSpending: r.candidateSpending,
        dateDiffDays: r.dateDiffDays ?? 0,
        reason: r.reason ?? r.matchType ?? 'Kandydat (±3 dni)',
      }))
      .filter((item: StatementCandidateItemDto) => item.candidateSpending != null);

    const importedRows: StatementImportedItemDto[] = (raw.importedRows ?? raw.importedToSpendings ?? [])
      .map((r: any, i: number): StatementImportedItemDto => ({
        statementRow: r.statementRow ? normalizeRow(r.statementRow, i) : normalizeRow(r, i),
        linkedSpending: r.linkedSpending ?? null,
      }));

    const matchedRows: StatementMatchedItemDto[] = (raw.matchedRows ?? raw.matchedEmail ?? [])
      .map((r: any, i: number): StatementMatchedItemDto => ({
        statementRow: r.statementRow ? normalizeRow(r.statementRow, i) : normalizeRow(r, i),
        matchedSpending: r.matchedSpending ?? r.linkedSpending,
        matchReason: r.matchReason ?? r.matchType ?? 'EXACT',
      }))
      .filter((item: StatementMatchedItemDto) => item.matchedSpending != null);

    const ignoredRows: MBankStatementRowDto[] = (raw.ignoredRows ?? raw.ignored ?? [])
      .map((r: any, i: number) => normalizeRow(r, i));

    const onlyInDbRows: DbSpendingCandidateDto[] = raw.onlyInDbRows ?? raw.onlyInDb ?? [];

    const normalized: StatementReconciliationSummaryDto = {
      periodFrom: raw.periodFrom ?? '',
      periodTo: raw.periodTo ?? '',
      newlyInsertedCount: raw.newlyInsertedCount ?? 0,
      alreadyStoredCount: raw.alreadyStoredCount ?? raw.alreadyExistedCount ?? 0,
      totalInPeriodCount: raw.totalInPeriodCount ?? raw.totalStatementOperations ?? 0,
      matchedEmailCount: raw.matchedEmailCount ?? matchedRows.length,
      importedToSpendingsCount: raw.importedToSpendingsCount ?? importedRows.length,
      candidateDateShiftCount: raw.candidateDateShiftCount ?? candidateRows.length,
      unreconciledCount: raw.unreconciledCount ?? raw.unReconciledCount ?? unreconciledRows.length,
      ignoredCount: raw.ignoredCount ?? ignoredRows.length,
      onlyInDbCount: raw.onlyInDbCount ?? onlyInDbRows.length,
      unreconciledTotalPln: Number(raw.unreconciledTotalPln ?? raw.unReconciledTotalAmount ?? 0),
      importedToSpendingsTotalPln: Number(raw.importedToSpendingsTotalPln ?? raw.importedToSpendingsTotalAmount ?? 0),
      unreconciledRows,
      candidateRows,
      importedRows,
      matchedRows,
      ignoredRows,
      onlyInDbRows,
    };

    this.result = normalized;
    if (normalized.periodFrom && !this.periodFrom) this.periodFrom = normalized.periodFrom;
    if (normalized.periodTo && !this.periodTo) this.periodTo = normalized.periodTo;
    this.selectedStatementIds.clear();
    return normalized;
  }

  setTab(tab: ActiveTab): void {
    this.activeTab = tab;
  }

  toggleSelection(id: number | null, event: Event): void {
    if (id == null) return;
    const checked = (event.target as HTMLInputElement).checked;
    if (checked) {
      this.selectedStatementIds.add(id);
    } else {
      this.selectedStatementIds.delete(id);
    }
  }

  isSelected(id: number | null): boolean {
    return id != null && this.selectedStatementIds.has(id);
  }

  areAllFilteredUnreconciledSelected(): boolean {
    const rows = this.filteredUnreconciledRows.filter(r => r.id != null);
    return rows.length > 0 && rows.every(r => this.selectedStatementIds.has(r.id!));
  }

  toggleSelectAllFilteredUnreconciled(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    for (const row of this.filteredUnreconciledRows) {
      if (row.id != null) {
        if (checked) {
          this.selectedStatementIds.add(row.id);
        } else {
          this.selectedStatementIds.delete(row.id);
        }
      }
    }
  }

  promoteSelected(): void {
    const ids = Array.from(this.selectedStatementIds);
    if (ids.length === 0) return;
    this.promoteIds(ids, `Dodano ${ids.length} operacji z wyciągu do tabeli wydatków (wraz z przypisaniem kont, kategorii i wykrywaniem duplikatów).`);
  }

  promoteAllFilteredUnreconciled(): void {
    const ids = this.filteredUnreconciledRows
      .map(r => r.id)
      .filter((id): id is number => id != null);
    if (ids.length === 0) return;
    this.promoteIds(ids, `Dodano wszystkie widoczne brakujące operacje (${ids.length}) do tabeli wydatków.`);
  }

  promoteSingle(id: number | null): void {
    if (id == null) return;
    this.promoteIds([id], 'Dodano operację z wyciągu do tabeli wydatków.');
  }

  private promoteIds(ids: number[], successMsg: string): void {
    const categories: Record<number, string> = {};
    for (const id of ids) {
      const c = this.chosenCategories[id]?.trim();
      if (c) categories[id] = c;
    }
    this.actionInProgress = true;
    this.error = null;
    this.successMessage = null;
    this.cdr.detectChanges();

    this.http.post<{ promotedCount: number; promotedSpendingIds: number[] }>(
      `${this.apiUrl}/api/mbank-statements/promote`,
      { statementOperationIds: ids, categories }
    ).subscribe({
      next: (res) => {
        for (const id of ids) delete this.chosenCategories[id];
        this.actionInProgress = false;
        this.successMessage = `${successMsg} (Utworzono wydatków: ${res.promotedCount}).`;
        this.cdr.detectChanges();
        this.loadReconciliationView();
      },
      error: (err) => {
        this.actionInProgress = false;
        this.error = err?.error?.message || err?.message || 'Błąd podczas dodawania operacji do wydatków.';
        this.cdr.detectChanges();
      }
    });
  }

  linkCandidate(statementOperationId: number | null, spendingId: number): void {
    if (statementOperationId == null) return;
    this.actionInProgress = true;
    this.error = null;
    this.successMessage = null;
    this.cdr.detectChanges();

    this.http.post(`${this.apiUrl}/api/mbank-statements/link`, {
      statementOperationId,
      spendingId
    }).subscribe({
      next: () => {
        this.actionInProgress = false;
        this.successMessage = `Połączono operację z wyciągu (#${statementOperationId}) z istniejącym wydatkiem (#${spendingId}).`;
        this.cdr.detectChanges();
        this.loadReconciliationView();
      },
      error: (err) => {
        this.actionInProgress = false;
        this.error = err?.error?.message || err?.message || 'Błąd podczas łączenia operacji z wydatkiem.';
        this.cdr.detectChanges();
      }
    });
  }

  setIgnored(ids: number[], ignored: boolean): void {
    const validIds = ids.filter(id => id != null);
    if (validIds.length === 0) return;

    this.actionInProgress = true;
    this.error = null;
    this.successMessage = null;
    this.cdr.detectChanges();

    this.http.post(`${this.apiUrl}/api/mbank-statements/ignore`, {
      statementOperationIds: validIds,
      ignored
    }).subscribe({
      next: () => {
        this.actionInProgress = false;
        this.successMessage = ignored
          ? `Oznaczono ${validIds.length} operacji jako zignorowane.`
          : `Przywrócono ${validIds.length} operacji do ponownego uzgodnienia.`;
        this.cdr.detectChanges();
        this.loadReconciliationView();
      },
      error: (err) => {
        this.actionInProgress = false;
        this.error = err?.error?.message || err?.message || 'Błąd podczas zmiany statusu ignorowania.';
        this.cdr.detectChanges();
      }
    });
  }

  get availableAccounts(): string[] {
    if (!this.result) return [];
    const accounts = new Set<string>();
    const addAcc = (name: string | null | undefined) => {
      if (name && name.trim()) accounts.add(name.trim());
    };
    this.result.unreconciledRows.forEach(r => addAcc(r.accountName));
    this.result.candidateRows.forEach(r => addAcc(r.statementRow.accountName));
    this.result.importedRows.forEach(r => addAcc(r.statementRow.accountName));
    this.result.matchedRows.forEach(r => addAcc(r.statementRow.accountName));
    this.result.ignoredRows.forEach(r => addAcc(r.accountName));
    return Array.from(accounts).sort();
  }

  private matchesStatementRow(row: MBankStatementRowDto): boolean {
    if (this.accountFilter !== 'ALL' && row.accountName !== this.accountFilter) {
      return false;
    }
    if (!this.searchQuery.trim()) return true;
    const q = this.searchQuery.toLowerCase();
    return (
      (row.operationDate && row.operationDate.toLowerCase().includes(q)) ||
      (row.title && row.title.toLowerCase().includes(q)) ||
      (row.rawDescription && row.rawDescription.toLowerCase().includes(q)) ||
      (row.accountName && row.accountName.toLowerCase().includes(q)) ||
      (row.mbankCategory && row.mbankCategory.toLowerCase().includes(q)) ||
      String(row.amount).includes(q)
    );
  }

  get filteredUnreconciledRows(): MBankStatementRowDto[] {
    if (!this.result) return [];
    return this.result.unreconciledRows.filter(r => this.matchesStatementRow(r));
  }

  get filteredCandidateRows(): StatementCandidateItemDto[] {
    if (!this.result) return [];
    return this.result.candidateRows.filter(item => this.matchesStatementRow(item.statementRow));
  }

  get filteredImportedRows(): StatementImportedItemDto[] {
    if (!this.result) return [];
    return this.result.importedRows.filter(item => this.matchesStatementRow(item.statementRow));
  }

  get filteredMatchedRows(): StatementMatchedItemDto[] {
    if (!this.result) return [];
    return this.result.matchedRows.filter(item => this.matchesStatementRow(item.statementRow));
  }

  get filteredIgnoredRows(): MBankStatementRowDto[] {
    if (!this.result) return [];
    return this.result.ignoredRows.filter(r => this.matchesStatementRow(r));
  }

  get filteredOnlyInDbRows(): DbSpendingCandidateDto[] {
    if (!this.result) return [];
    return this.result.onlyInDbRows.filter(row => {
      if (!this.searchQuery.trim()) return true;
      const q = this.searchQuery.toLowerCase();
      return (
        (row.effectiveDate && row.effectiveDate.toLowerCase().includes(q)) ||
        (row.title && row.title.toLowerCase().includes(q)) ||
        (row.operationType && row.operationType.toLowerCase().includes(q)) ||
        (row.accountKey && row.accountKey.toLowerCase().includes(q)) ||
        (row.categoryName && row.categoryName.toLowerCase().includes(q)) ||
        String(row.amount).includes(q)
      );
    });
  }
}
