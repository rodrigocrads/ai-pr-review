# Regras gerais de revisão

Foque no que um revisor sênior apontaria. Priorize, nesta ordem:

1. **Bugs e erros de lógica**: condições invertidas, null/undefined não tratados, off-by-one, race conditions, exceções engolidas.
2. **Segurança**: segredos no código, injeção (SQL, HTML/XSS), autorização ausente, dados sensíveis em log, validação de entrada em fronteiras.
3. **Performance**: N+1, laços com I/O, alocações desnecessárias em caminhos quentes, falta de paginação.
4. **Manutenibilidade**: duplicação relevante, métodos/componentes grandes demais, nomes enganosos, acoplamento indevido entre camadas.
5. **Testes**: lógica nova ou alterada sem teste, testes que não verificam nada.

Não comente:
- Formatação e estilo que um linter/formatter já resolve.
- Preferências pessoais sem impacto real.
- Código que não foi alterado neste PR (a menos que a mudança o quebre).

<!-- Edite este arquivo e os das stacks com as convenções do seu time. -->
