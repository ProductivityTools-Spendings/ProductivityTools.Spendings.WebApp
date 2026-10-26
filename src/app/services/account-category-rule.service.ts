import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

/** Mirrors AccountCategoryRuleController.RuleDto: account number → category. */
export interface AccountCategoryRule {
  id: number;
  accountNumber: string;
  label: string | null;
  category: string;
  /** true: overrides existing categories; false: only fills spendings without a category */
  overwrite: boolean;
  /** spendings sent from or to the account */
  matchedCount: number;
  /** matched spendings whose category would change when the rule is applied */
  toChangeCount: number;
}

export interface AccountCategoryRuleRequest {
  accountNumber: string;
  label: string | null;
  category: string;
  overwrite: boolean;
}

/** Mirrors AccountCategoryRuleService.MatchedSpending. */
export interface RuleMatchedSpending {
  id: number;
  operationDate: string | null;
  operationType: string | null;
  name: string | null;
  amount: number;
  currency: string | null;
  srcAccount: string | null;
  dstAccount: string | null;
  category: string | null;
  willChange: boolean;
}

@Injectable({ providedIn: 'root' })
export class AccountCategoryRuleService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/api/dictionary/account-category-rules`;

  getAll(): Observable<AccountCategoryRule[]> {
    return this.http.get<AccountCategoryRule[]>(this.baseUrl);
  }

  getSpendings(id: number): Observable<RuleMatchedSpending[]> {
    return this.http.get<RuleMatchedSpending[]>(`${this.baseUrl}/${id}/spendings`);
  }

  create(request: AccountCategoryRuleRequest): Observable<AccountCategoryRule> {
    return this.http.post<AccountCategoryRule>(this.baseUrl, request);
  }

  update(id: number, request: AccountCategoryRuleRequest): Observable<AccountCategoryRule> {
    return this.http.put<AccountCategoryRule>(`${this.baseUrl}/${id}`, request);
  }

  delete(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }

  applyAll(): Observable<{ updated: number }> {
    return this.http.post<{ updated: number }>(`${this.baseUrl}/apply`, null);
  }
}
