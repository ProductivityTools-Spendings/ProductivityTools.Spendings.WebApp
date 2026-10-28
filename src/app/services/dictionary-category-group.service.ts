import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

/** Mirrors DictionaryCategoryGroupController.Group: a named, coloured bucket of categories. */
export interface CategoryGroup {
  id: number;
  name: string;
  sortOrder: number;
  /** CSS colour (e.g. "#1976d2") or null when not set */
  color: string | null;
  /** names of the categories assigned to this group */
  categories: string[];
}

/** Payload for creating / updating a group. */
export interface CategoryGroupInput {
  name: string;
  sortOrder?: number;
  color?: string | null;
}

/** One dictionary category with its (optional) group assignment. */
export interface CategoryWithGroup {
  name: string;
  groupId: number | null;
  groupName: string | null;
  /** Chart colour ("#rrggbb") or null = automatic palette colour */
  color: string | null;
}

@Injectable({ providedIn: 'root' })
export class DictionaryCategoryGroupService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/api/dictionary/category-groups`;

  getAll(): Observable<CategoryGroup[]> {
    return this.http.get<CategoryGroup[]>(this.baseUrl);
  }

  create(input: CategoryGroupInput): Observable<CategoryGroup> {
    return this.http.post<CategoryGroup>(this.baseUrl, input);
  }

  update(id: number, input: CategoryGroupInput): Observable<CategoryGroup> {
    return this.http.put<CategoryGroup>(`${this.baseUrl}/${id}`, input);
  }

  delete(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }

  /** All dictionary categories with their current group. */
  getCategories(): Observable<CategoryWithGroup[]> {
    return this.http.get<CategoryWithGroup[]>(`${this.baseUrl}/categories`);
  }

  /** Sets (or clears, with null) the chart colour of a single category. */
  setCategoryColor(name: string, color: string | null): Observable<CategoryWithGroup> {
    return this.http.put<CategoryWithGroup>(
      `${this.baseUrl}/categories/${encodeURIComponent(name)}/color`,
      { color },
    );
  }

  /** Assigns (or clears, with null) the group of a single category. */
  setCategoryGroup(name: string, groupId: number | null): Observable<CategoryWithGroup> {
    return this.http.put<CategoryWithGroup>(
      `${this.baseUrl}/categories/${encodeURIComponent(name)}/group`,
      { groupId },
    );
  }
}
