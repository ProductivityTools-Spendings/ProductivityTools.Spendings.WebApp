import { Component, DestroyRef, effect, HostListener, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from './auth/auth.service';
import { AppEventsService } from './services/app-events.service';
import { EmailService, ProcessingResult } from './services/email.service';
import { environment } from '../environments/environment';

type Menu = 'browse' | 'settings' | 'gmail';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly emailService = inject(EmailService);
  protected readonly events = inject(AppEventsService);

  protected readonly title = signal('Family Expenses');
  protected readonly user = this.auth.user;

  /** Currently open dropdown menu (null = all closed). */
  protected readonly openMenu = signal<Menu | null>(null);
  /** Section of the current URL, highlights the dropdown trigger. */
  protected readonly section = signal<string>('');

  protected readonly mbankGmailImportUrl = environment.mbankGmailImportUrl;
  protected readonly allegroGmailImportUrl = environment.allegroGmailImportUrl;

  protected readonly processing = signal(false);
  /** Short result message shown under the header (auto-hides). */
  protected readonly toast = signal<{ text: string; error: boolean } | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), takeUntilDestroyed(inject(DestroyRef)))
      .subscribe((e) => {
        this.openMenu.set(null);
        this.section.set(e.urlAfterRedirects.split('/')[1] ?? '');
        if (this.user()) this.events.refreshPendingCount();
      });
    // load the statement badge as soon as the user is known
    effect(() => {
      if (this.user()) this.events.refreshPendingCount();
    });
  }

  protected toggleMenu(menu: Menu, event: Event): void {
    event.stopPropagation();
    this.openMenu.update((m) => (m === menu ? null : menu));
  }

  /** Close dropdowns on any click outside of them. */
  @HostListener('document:click')
  protected closeMenus(): void {
    this.openMenu.set(null);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.openMenu.set(null);
  }

  /** Processes e-mails already sent by the Gmail scripts (NEW + ERROR) and tells the pages to reload. */
  protected processEmails(): void {
    this.openMenu.set(null);
    if (this.processing()) return;
    this.processing.set(true);
    this.emailService.process().subscribe({
      next: (r) => {
        this.processing.set(false);
        this.showToast(describeProcessing(r), !r.started);
        this.events.notifyDataChanged();
      },
      error: (err) => {
        this.processing.set(false);
        this.showToast(err?.error?.message || err?.message || 'Nie udało się przetworzyć e-maili.', true);
      },
    });
  }

  private showToast(text: string, error: boolean): void {
    this.toast.set({ text, error });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 6000);
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigate(['/login']);
  }
}

function describeProcessing(r: ProcessingResult): string {
  if (!r.started) return 'Przetwarzanie już trwa – spróbuj za chwilę.';
  const parts = [`Przetworzono e-maili: ${r.processed}`];
  if (r.resetFromError) parts.push(`ponowione z błędem: ${r.resetFromError}`);
  if (r.remainingError) parts.push(`nadal z błędem: ${r.remainingError}`);
  if (r.remainingNew) parts.push(`czeka: ${r.remainingNew}`);
  return parts.join(' · ');
}
