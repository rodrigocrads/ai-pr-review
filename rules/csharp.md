# Regras para C# / .NET

- **Async**: `async void` (exceto handlers de evento), `.Result`/`.Wait()`/`.GetAwaiter().GetResult()` (deadlock e bloqueio de thread), `CancellationToken` não propagado.
- **Recursos**: `IDisposable` sem `using`; `HttpClient` criado com `new` em vez de `IHttpClientFactory`.
- **Exceções**: `catch (Exception)` vazio ou que só loga e segue; `throw ex;` (perde o stack trace, usar `throw;`).
- **Nulabilidade**: possíveis `NullReferenceException`; uso de `!` (null-forgiving) para silenciar o compilador.
- **EF Core / dados**: N+1 (acesso a navegação em laço), falta de `AsNoTracking` em leitura, `ToList()` antes de filtrar, SQL montado com concatenação/interpolação (usar parâmetros).
- **DI e ciclo de vida**: serviço `Scoped` (ex.: `DbContext`) injetado em `Singleton`; `new` de dependências que deveriam ser injetadas.
- **API**: endpoints sem validação de entrada ou sem `[Authorize]` quando deveriam ter; retorno de entidades de domínio direto em vez de DTOs.
- **Concorrência**: estado estático mutável compartilhado; `lock` em `this` ou em tipos públicos.
- **Segurança**: segredos em `appsettings.json` versionado, dados sensíveis em log.
