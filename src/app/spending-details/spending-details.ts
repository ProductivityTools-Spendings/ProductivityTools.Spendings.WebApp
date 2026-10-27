import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { SpendingFullDetails, SpendingService } from '../services/spending.service';

/** Details of a single transaction with copy buttons (full title from the statement when e-mail truncated it). */
@Component({
  selector: 'app-spending-details',
  imports: [DecimalPipe, RouterLink],
  templateUrl: './spending-details.html',
  styleUrl: './spending-details.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpendingDetails implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly service = inject(SpendingService);

  protected readonly data = signal<SpendingFullDetails | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Key of the field that was just copied (shows "Skopiowano"). */
  protected readonly copied = signal<string | null>(null);

  ngOnInit(): void {
    this.route.paramMap.subscribe((params) => {
      const id = Number(params.get('id'));
      if (Number.isFinite(id)) this.load(id);
    });
  }

  private load(id: number): void {
    this.loading.set(true);
    this.error.set(null);
    this.service.getDetails(id).subscribe({
      next: (d) => {
        this.data.set(d);
        this.loading.set(false);
      },
      error: (err) => {
        const body = err instanceof HttpErrorResponse ? (err.error as { message?: string } | null) : null;
        this.error.set(body?.message || 'Nie udało się pobrać transakcji.');
        this.loading.set(false);
      },
    });
  }

  protected copy(key: string, value: string | number | null | undefined): void {
    if (value === null || value === undefined || value === '') return;
    navigator.clipboard.writeText(String(value)).then(() => {
      this.copied.set(key);
      setTimeout(() => {
        if (this.copied() === key) this.copied.set(null);
      }, 1500);
    });
  }
}
