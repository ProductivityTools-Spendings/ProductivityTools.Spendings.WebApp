import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { environment } from '../../environments/environment';

/** App-wide state shared between the header and the pages. */
@Injectable({ providedIn: 'root' })
export class AppEventsService {
  private readonly http = inject(HttpClient);

  /** Incremented whenever transactions may have changed (e.g. e-mails processed from the header) – pages reload. */
  readonly dataVersion = signal(0);
  /** Statement operations waiting for a decision (missing + candidates); null = not loaded yet. */
  readonly pendingStatementCount = signal<number | null>(null);

  notifyDataChanged(): void {
    this.dataVersion.update((v) => v + 1);
    this.refreshPendingCount();
  }

  refreshPendingCount(): void {
    this.http
      .get<{ total: number }>(`${environment.apiUrl}/api/mbank-statements/pending-count`)
      .subscribe({ next: (r) => this.pendingStatementCount.set(r.total), error: () => {} });
  }
}
