import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Funcao describeRefreshOutcome extraida e refatorada de LimitsPage.jsx.
 *
 * O que este teste executa:
 * Valida que a agregacao do resultado do refresh considera o filtro de provedores
 * visiveis (prefs.visibleOrdered), garantindo que provedores ocultos/fechados com falha
 * nao acionem o aviso de 'partial' ou 'stale' quando os provedores visiveis tiveram exito.
 */
function describeRefreshOutcome(data, visibleProviders) {
  const visibleFilter = Array.isArray(visibleProviders)
    ? new Set(visibleProviders)
    : visibleProviders instanceof Set
      ? visibleProviders
      : null;

  const providers = Object.entries(data || {}).filter(
    ([key, value]) =>
      key !== 'fetched_at' &&
      value &&
      typeof value === 'object' &&
      value.configured !== false &&
      (!visibleFilter || visibleFilter.has(key)),
  );
  const errored = providers.filter(([, provider]) => Boolean(provider.error));
  const extrasErrored = providers.some(([, provider]) =>
    Boolean(provider.start_plan?.error) || Boolean(provider.reset_credits?.error));
  const cached = providers.filter(([, provider]) =>
    provider.provenance?.stale === true
    || provider.provenance?.source === 'disk-cache',
  );
  if (providers.length && errored.length === 0 && !extrasErrored && cached.length === providers.length) {
    return { kind: 'stale' };
  }
  if (errored.length || cached.length || extrasErrored) {
    return { kind: 'partial', at: data?.fetched_at };
  }
  return { kind: 'updated', at: data?.fetched_at };
}

test('Issue #956: Provedor oculto com erro nao deve forcar status partial quando os provedores visiveis estao ok', () => {
  // O que este teste executa:
  // Simula payload com antigravity e claude com erro/stale, mas ambos foram desligados/ocultados pelo usuario.
  // Provedores visiveis (codex, copilot) estao 100% atualizados e sem erro.
  const payload = {
    fetched_at: 1730380000,
    codex: {
      configured: true,
      provenance: { source: 'live', stale: false },
    },
    copilot: {
      configured: true,
      provenance: { source: 'live', stale: false },
    },
    antigravity: {
      configured: true,
      error: 'Not logged in',
      provenance: { source: 'disk-cache', stale: true },
    },
    claude: {
      configured: true,
      error: 'Token expired (HTTP 401)',
      provenance: { source: 'disk-cache', stale: true },
    },
  };

  const visibleProviders = ['codex', 'copilot'];

  const outcomeWithFilter = describeRefreshOutcome(payload, visibleProviders);
  assert.equal(outcomeWithFilter.kind, 'updated');
  assert.equal(outcomeWithFilter.at, 1730380000);

  const outcomeWithoutFilter = describeRefreshOutcome(payload);
  assert.equal(outcomeWithoutFilter.kind, 'partial');
});

test('Issue #956: Se um provedor visivel falhar, status deve retornar partial', () => {
  // O que este teste executa:
  // Garante que falhas reais em provedores que o usuario esta visualizando continuam
  // notificando adequadamente como partial.
  const payload = {
    fetched_at: 1730380000,
    codex: {
      configured: true,
      error: 'Rate limit exceeded',
      provenance: { source: 'live', stale: false },
    },
    copilot: {
      configured: true,
      provenance: { source: 'live', stale: false },
    },
  };

  const visibleProviders = ['codex', 'copilot'];
  const outcome = describeRefreshOutcome(payload, visibleProviders);
  assert.equal(outcome.kind, 'partial');
});

test('Issue #956: Provedores visiveis servidos 100% de cache retornam status stale', () => {
  // O que este teste executa:
  // Garante que quando todos os provedores visiveis vem de cache em disco sem novos dados,
  // o status stale seja retornado conforme comportamento original.
  const payload = {
    fetched_at: 1730380000,
    codex: {
      configured: true,
      provenance: { source: 'disk-cache', stale: true },
    },
    copilot: {
      configured: true,
      provenance: { source: 'disk-cache', stale: true },
    },
    hidden_error_provider: {
      configured: true,
      error: 'Failed to fetch',
    },
  };

  const visibleProviders = ['codex', 'copilot'];
  const outcome = describeRefreshOutcome(payload, visibleProviders);
  assert.equal(outcome.kind, 'stale');
});
