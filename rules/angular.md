# Regras para Angular / TypeScript

- **Subscriptions**: `subscribe` sem `takeUntilDestroyed`, `async` pipe ou unsubscribe causa vazamento de memória.
- **RxJS**: evitar `subscribe` aninhado; preferir `switchMap`/`concatMap`/`mergeMap` conforme a semântica. Atenção a `switchMap` cancelando requisições de escrita (POST/PUT).
- **Change detection**: componentes novos devem preferir `ChangeDetectionStrategy.OnPush`. Evitar chamadas de função pesadas no template.
- **Signals**: em código novo, preferir `signal`/`computed`/`input()` quando o projeto já os usa; não misturar mutação direta de estado com signals.
- **Tipagem**: evitar `any`, `as any` e non-null assertion (`!`) sem justificativa.
- **Templates**: `@for`/`*ngFor` sem `track`/`trackBy` em listas grandes; `[innerHTML]` com conteúdo não sanitizado.
- **HTTP**: chamadas HTTP diretamente em componentes (devem ficar em serviços); tratamento de erro ausente.
- **Arquitetura**: lógica de negócio em componente; serviços com `providedIn: 'root'` guardando estado de tela.
- **Segurança**: tokens ou segredos em `environment.ts`, `localStorage` para dados sensíveis, uso de `bypassSecurityTrust*`.
