import { Routes } from '@angular/router';
import { Spendings } from './spendings/spendings';
import { MbankEmails } from './mbank-emails/mbank-emails';
import { CardAuthorizations } from './card-authorizations/card-authorizations';
import { DictionaryAccounts } from './dictionary-accounts/dictionary-accounts';
import { DictionaryCategoryMappings } from './dictionary-category-mappings/dictionary-category-mappings';
import { AllegroEmails } from './allegro-emails/allegro-emails';
import { AllegroPurchases } from './allegro-purchases/allegro-purchases';
import { Reports } from './reports/reports';
import { StatementImport } from './statement-import/statement-import';
import { AccountCategoryRules } from './account-category-rules/account-category-rules';
import { Login } from './auth/login';
import { authGuard, guestGuard } from './auth/auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'spendings', pathMatch: 'full' },
  { path: 'login', component: Login, title: 'Logowanie', canActivate: [guestGuard] },
  { path: 'spendings', component: Spendings, title: 'Transakcje', canActivate: [authGuard] },
  { path: 'card-authorizations', component: CardAuthorizations, title: 'Autoryzacje kart', canActivate: [authGuard] },
  { path: 'emails', component: MbankEmails, title: 'E-maile mBank', canActivate: [authGuard] },
  { path: 'allegro/emails', component: AllegroEmails, title: 'E-maile Allegro', canActivate: [authGuard] },
  { path: 'allegro/purchases', component: AllegroPurchases, title: 'Zakupy Allegro', canActivate: [authGuard] },
  { path: 'reports', component: Reports, title: 'Raporty', canActivate: [authGuard] },
  { path: 'statement-import', component: StatementImport, title: 'Import wyciągu', canActivate: [authGuard] },
  { path: 'dictionary/accounts', component: DictionaryAccounts, title: 'Słownik rachunków', canActivate: [authGuard] },
  { path: 'dictionary/categories', component: DictionaryCategoryMappings, title: 'Słownik kategorii', canActivate: [authGuard] },
  { path: 'dictionary/account-rules', component: AccountCategoryRules, title: 'Reguły rachunków', canActivate: [authGuard] },
  { path: '**', redirectTo: 'spendings' },
];
