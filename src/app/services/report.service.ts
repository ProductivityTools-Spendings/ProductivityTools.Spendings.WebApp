import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface CategoryMonth {
  month: string;
  category: string;
  total: number;
  count: number;
  /** Name of the category's group; null = ungrouped. */
  group: string | null;
}

/** Category group as returned in the hygiene report. */
export interface CategoryGroupInfo {
  id: number;
  name: string;
  color: string | null;
  sortOrder: number;
}

export interface CategoryDetail {
  id: number;
  operationDate: string;
  operationTime: string | null;
  operationType: string;
  name: string | null;
  amount: number;
  currency: string | null;
  amountPln: number;
  account: string | null;
  category: string | null;
  note: string | null;
  /** Name of the category's group; null = ungrouped or no category. */
  group: string | null;
}

export interface CashflowMonth {
  month: string;
  account: string;
  income: number;
  expenses: number;
  net: number;
  count: number;
}

export interface RecurringPayment {
  payee: string;
  dstAccount: string;
  category: string | null;
  occurrences: number;
  months: number;
  firstDate: string;
  lastDate: string;
  lastAmount: number;
  avgAmount: number;
  minAmount: number;
  maxAmount: number;
  monthlyAvg12m: number;
  active: boolean;
}

export interface HygieneCategory {
  category: string;
  count: number;
  total: number;
}

export interface Hygiene {
  uncategorized: number;
  withoutAccount: number;
  withoutPln: number;
  unmappedAccounts: number;
  unlinkedAuthorizations: number;
  allegroEmailsWithoutSpending: number;
  emailsInError: number;
  duplicates: number;
  proxyCategories: HygieneCategory[];
  uncategorizedSample: { id: number; operationDate: string; operationType: string; name: string; amountPln: number }[];
  /** Earliest month (YYYY-MM) with any spending; null when the table is empty. */
  firstMonth: string | null;
  /** All category groups (may be empty when the user has not created any). */
  groups: CategoryGroupInfo[];
  /** User-defined chart colours (category → "#rrggbb"); categories missing here use the palette. */
  categoryColors?: Record<string, string>;
}

@Injectable({ providedIn: 'root' })
export class ReportService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/api/reports`;

  categoryMonthly(from: string, to: string): Observable<CategoryMonth[]> {
    return this.http.get<CategoryMonth[]>(`${this.baseUrl}/category-monthly`, { params: new HttpParams({ fromObject: { from, to } }) });
  }

  /** Spendings behind a pivot cell; omit category for a whole month, pass '(bez kategorii)' for uncategorised. */
  categoryMonthlyDetails(from: string, to: string, category?: string): Observable<CategoryDetail[]> {
    const params: Record<string, string> = { from, to };
    if (category) params['category'] = category;
    return this.http.get<CategoryDetail[]>(`${this.baseUrl}/category-monthly/details`, { params: new HttpParams({ fromObject: params }) });
  }

  cashflow(from: string, to: string): Observable<CashflowMonth[]> {
    return this.http.get<CashflowMonth[]>(`${this.baseUrl}/cashflow`, { params: new HttpParams({ fromObject: { from, to } }) });
  }

  recurring(minMonths = 3): Observable<RecurringPayment[]> {
    return this.http.get<RecurringPayment[]>(`${this.baseUrl}/recurring`, { params: { minMonths } });
  }

  hygiene(): Observable<Hygiene> {
    return this.http.get<Hygiene>(`${this.baseUrl}/hygiene`);
  }
}
