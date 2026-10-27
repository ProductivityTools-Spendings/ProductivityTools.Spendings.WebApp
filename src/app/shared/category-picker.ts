import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  Output,
  ViewChild,
  inject,
} from '@angular/core';

/**
 * Text input with a filterable category list (replacement for the native <datalist>, whose popup is narrow
 * and cannot be styled). Typing filters the list; a value not on the list is accepted as a new category.
 * The list uses position: fixed, so it is not clipped by scrollable table wrappers.
 */
@Component({
  selector: 'app-category-picker',
  templateUrl: './category-picker.html',
  styleUrl: './category-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryPicker {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly host = inject(ElementRef<HTMLElement>);
  /** Scroll of any element (e.g. the table wrapper) moves the input away from the fixed list - close it. */
  private readonly onAnyScroll = (event: Event) => {
    if (event.target instanceof Node && this.host.nativeElement.contains(event.target)) return;
    this.hide();
  };

  @Input() categories: string[] = [];
  @Input() value = '';
  @Input() placeholder = '';
  @Output() valueChange = new EventEmitter<string>();

  @ViewChild('input', { static: true }) private input!: ElementRef<HTMLInputElement>;

  protected open = false;
  protected activeIndex = -1;
  protected listStyle: Record<string, string> = {};

  protected get filtered(): string[] {
    const q = (this.value ?? '').trim().toLowerCase();
    if (!q) return this.categories;
    const starts = this.categories.filter((c) => c.toLowerCase().startsWith(q));
    const contains = this.categories.filter((c) => !c.toLowerCase().startsWith(q) && c.toLowerCase().includes(q));
    return [...starts, ...contains];
  }

  protected onInput(text: string): void {
    this.value = text;
    this.valueChange.emit(text);
    this.activeIndex = -1;
    this.show();
  }

  protected show(): void {
    const rect = this.input.nativeElement.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const maxHeight = 260;
    const openUp = spaceBelow < 180 && rect.top > spaceBelow;
    this.listStyle = {
      left: `${rect.left}px`,
      minWidth: `${Math.max(rect.width, 200)}px`,
      maxHeight: `${Math.min(maxHeight, (openUp ? rect.top : spaceBelow) - 12)}px`,
      ...(openUp ? { bottom: `${window.innerHeight - rect.top + 2}px` } : { top: `${rect.bottom + 2}px` }),
    };
    if (!this.open) document.addEventListener('scroll', this.onAnyScroll, true);
    this.open = true;
    this.cdr.markForCheck();
  }

  protected hide(): void {
    document.removeEventListener('scroll', this.onAnyScroll, true);
    this.open = false;
    this.activeIndex = -1;
    this.cdr.markForCheck();
  }

  protected select(category: string): void {
    this.value = category;
    this.valueChange.emit(category);
    this.hide();
  }

  protected clear(event: MouseEvent): void {
    event.stopPropagation();
    this.select('');
    this.input.nativeElement.focus();
  }

  protected onKeydown(event: KeyboardEvent): void {
    const items = this.filtered;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!this.open) this.show();
        this.activeIndex = Math.min(this.activeIndex + 1, items.length - 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.activeIndex = Math.max(this.activeIndex - 1, 0);
        break;
      case 'Enter':
        if (this.open && this.activeIndex >= 0 && items[this.activeIndex]) {
          event.preventDefault();
          this.select(items[this.activeIndex]);
        } else {
          this.hide();
        }
        break;
      case 'Escape':
      case 'Tab':
        this.hide();
        break;
    }
    this.cdr.markForCheck();
  }

  /** Close when clicking outside the picker. */
  @HostListener('document:mousedown', ['$event'])
  protected onDocumentMouseDown(event: MouseEvent): void {
    if (this.open && !this.host.nativeElement.contains(event.target as Node)) {
      this.hide();
    }
  }

  @HostListener('window:resize')
  protected onResize(): void {
    if (this.open) this.hide();
  }
}
