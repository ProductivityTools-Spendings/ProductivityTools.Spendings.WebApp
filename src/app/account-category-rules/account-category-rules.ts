import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { forkJoin } from 'rxjs';
import {
  AccountCategoryRule,
  AccountCategoryRuleRequest,
  AccountCategoryRuleService,
  RuleMatchedSpending,
} from '../services/account-category-rule.service';
import { SpendingService } from '../services/spending.service';
import { DictionaryAccountService } from '../services/dictionary-account.service';

interface RuleRow extends AccountCategoryRule {
  draftAccountNumber: string;
  draftLabel: string;
  draftCategory: string;
  draftOverwrite: boolean;
  editing: boolean;
  saving: boolean;
}

/** Account suggestion for the new-rule form (from dictionary_account). */
interface AccountSuggestion {
  key: string;
  name: string;
}

/**
 * Rules "account number → category": every spending sent from or to the account gets the category
 * (e.g. own accounts → PrzelewWlasny). Reuses the accounts dictionary styles.
 */
@Component({
  selector: 'app-account-category-rules',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './account-category-rules.html',
  styleUrl: '../dictionary-accounts/dictionary-accounts.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountCategoryRules implements OnInit {
  private readonly service = inject(AccountCategoryRuleService);
  private readonly spendingService = inject(SpendingService);
  private readonly accountService = inject(DictionaryAccountService);

  protected readonly rows = signal<RuleRow[]>([]);
  protected readonly categories = signal<string[]>([]);
  protected readonly accounts = signal<AccountSuggestion[]>([]);
  protected readonly loading = signal(false);
  protected readonly applying = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly status = signal<string | null>(null);

  /** Rule whose matched spendings are shown in the preview panel. */
  protected readonly previewRule = signal<RuleRow | null>(null);
  protected readonly previewRows = signal<RuleMatchedSpending[]>([]);
  protected readonly previewLoading = signal(false);

  // new-rule form
  protected newAccountNumber = '';
  protected newLabel = '';
  protected newCategory = '';
  protected newOverwrite = true;
  protected readonly creating = signal(false);

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    forkJoin({
      rules: this.service.getAll(),
      categories: this.spendingService.getCategories(),
      accounts: this.accountService.getAll(),
    }).subscribe({
      next: ({ rules, categories, accounts }) => {
        this.rows.set(rules.map(toRow));
        this.categories.set(categories);
        this.accounts.set(accounts.map((a) => ({ key: a.key, name: a.name })));
        this.loading.set(false);
        const preview = this.previewRule();
        if (preview) {
          const fresh = this.rows().find((r) => r.id === preview.id);
          if (fresh) this.showPreview(fresh); else this.previewRule.set(null);
        }
      },
      error: (err) => {
        this.error.set(describeError(err, 'Nie udało się pobrać reguł.'));
        this.loading.set(false);
      },
    });
  }

  /** Fills the label when an account from the dictionary is typed/selected. */
  protected onNewAccountChange(value: string): void {
    this.newAccountNumber = value;
    const match = this.accounts().find((a) => a.key === value.trim());
    if (match && !this.newLabel.trim()) this.newLabel = match.name;
  }

  protected create(): void {
    const request = this.buildRequest(this.newAccountNumber, this.newLabel, this.newCategory, this.newOverwrite);
    if (!request) return;
    this.creating.set(true);
    this.error.set(null);
    this.service.create(request).subscribe({
      next: (created) => {
        this.rows.update((rs) => [...rs, toRow(created)]);
        this.newAccountNumber = '';
        this.newLabel = '';
        this.newCategory = '';
        this.newOverwrite = true;
        this.creating.set(false);
        this.status.set(`Dodano regułę dla rachunku ${created.accountNumber}. Kliknij „Zastosuj reguły”, aby przeliczyć istniejące wydatki.`);
      },
      error: (err) => {
        this.error.set(describeError(err, 'Nie udało się dodać reguły.'));
        this.creating.set(false);
      },
    });
  }

  protected startEdit(r: RuleRow): void {
    this.patch(r.id, {
      editing: true,
      draftAccountNumber: r.accountNumber,
      draftLabel: r.label ?? '',
      draftCategory: r.category,
      draftOverwrite: r.overwrite,
    });
  }

  protected cancelEdit(r: RuleRow): void {
    this.patch(r.id, { editing: false });
  }

  protected save(r: RuleRow): void {
    const request = this.buildRequest(r.draftAccountNumber, r.draftLabel, r.draftCategory, r.draftOverwrite);
    if (!request) return;
    this.patch(r.id, { saving: true });
    this.error.set(null);
    this.service.update(r.id, request).subscribe({
      next: (updated) => {
        this.rows.update((rs) => rs.map((x) => (x.id === r.id ? toRow(updated) : x)));
        this.status.set('Zapisano regułę.');
      },
      error: (err) => {
        this.error.set(describeError(err, 'Nie udało się zapisać reguły.'));
        this.patch(r.id, { saving: false });
      },
    });
  }

  protected remove(r: RuleRow): void {
    if (!confirm(`Usunąć regułę dla rachunku ${r.accountNumber}${r.label ? ' (' + r.label + ')' : ''}? Kategorie już przypisanych wydatków zostaną bez zmian.`)) {
      return;
    }
    this.patch(r.id, { saving: true });
    this.service.delete(r.id).subscribe({
      next: () => {
        this.rows.update((rs) => rs.filter((x) => x.id !== r.id));
        if (this.previewRule()?.id === r.id) this.previewRule.set(null);
        this.status.set('Usunięto regułę.');
      },
      error: (err) => {
        this.error.set(describeError(err, 'Nie udało się usunąć reguły.'));
        this.patch(r.id, { saving: false });
      },
    });
  }

  protected applyAll(): void {
    const toChange = this.rows().reduce((sum, r) => sum + r.toChangeCount, 0);
    if (toChange > 0 && !confirm(`Reguły zmienią kategorię ${toChange} wydatków. Kontynuować?`)) {
      return;
    }
    this.applying.set(true);
    this.error.set(null);
    this.service.applyAll().subscribe({
      next: (res) => {
        this.applying.set(false);
        this.status.set(`Zastosowano reguły – zmieniono kategorię ${res.updated} wydatków.`);
        this.load();
      },
      error: (err) => {
        this.applying.set(false);
        this.error.set(describeError(err, 'Nie udało się zastosować reguł.'));
      },
    });
  }

  protected showPreview(r: RuleRow): void {
    this.previewRule.set(r);
    this.previewLoading.set(true);
    this.service.getSpendings(r.id).subscribe({
      next: (rows) => {
        this.previewRows.set(rows);
        this.previewLoading.set(false);
      },
      error: (err) => {
        this.error.set(describeError(err, 'Nie udało się pobrać wydatków reguły.'));
        this.previewLoading.set(false);
      },
    });
  }

  protected closePreview(): void {
    this.previewRule.set(null);
    this.previewRows.set([]);
  }

  protected accountName(accountNumber: string): string | null {
    const digits = accountNumber.replace(/\D/g, '');
    const match = this.accounts().find((a) => {
      const key = a.key.replace(/\D/g, '');
      return key.length >= 6 && key.slice(-6) === digits.slice(-6);
    });
    return match ? match.name : null;
  }

  private buildRequest(account: string, label: string, category: string, overwrite: boolean): AccountCategoryRuleRequest | null {
    const digits = (account ?? '').replace(/\D/g, '');
    if (digits.length < 6) {
      this.error.set('Numer rachunku musi mieć co najmniej 6 cyfr.');
      return null;
    }
    if (!category?.trim()) {
      this.error.set('Wybierz kategorię.');
      return null;
    }
    return { accountNumber: digits, label: label?.trim() || null, category: category.trim(), overwrite };
  }

  private patch(id: number, changes: Partial<RuleRow>): void {
    this.rows.update((rs) => rs.map((r) => (r.id === id ? { ...r, ...changes } : r)));
  }
}

function toRow(r: AccountCategoryRule): RuleRow {
  return {
    ...r,
    draftAccountNumber: r.accountNumber,
    draftLabel: r.label ?? '',
    draftCategory: r.category,
    draftOverwrite: r.overwrite,
    editing: false,
    saving: false,
  };
}

function describeError(err: unknown, fallback: string): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { message?: string; detail?: string } | null;
    return body?.detail || body?.message || err.message || fallback;
  }
  return fallback;
}
