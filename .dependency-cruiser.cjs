// @ts-check
/**
 * dependency-cruiser rules (T00). Row-by-row translation of A-01 §1.2 (dependency rules table and
 * the @fb/platform sub-entry table) plus R-U1 (apps/web may only import @fb/contracts/web, A-01 §1.3).
 *
 * Every table row becomes:
 *   - `<module>-allowed`   : the "允许依赖" column as an allow-list (anything else is an error)
 *   - `<module>-forbidden` : the "禁止依赖" column as explicit forbidden edges (clearer error message)
 *   - `<module>-reach-*`   : for forbidden third-party drivers, a transitive (reachable) check, so that
 *                            e.g. "harness has no pg driver" also holds through @fb/platform (A-01 §1.2).
 *
 * Path conventions: targets are matched on the resolved path (workspace packages resolve to
 * `packages/<pkg>/src/...` through pnpm symlinks) OR on the bare specifier when the module cannot be
 * resolved (e.g. business deps before T01, or the temp-dir guardrail test). Both forms are covered.
 */
const fs = require('node:fs');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** third-party package(s) by name; `namePattern` is a regex fragment for the package name */
const npmRe = (namePattern) => `(^|/)node_modules/${namePattern}(/|$)|^${namePattern}(/|$)`;
const npm = (...names) => names.map((n) => npmRe(esc(n))).join('|');
/** workspace module: resolved source dir and/or bare specifier */
const ws = (dir, spec) => `^${esc(dir)}|^${esc(spec)}(/|$)`;
const core = (...names) => `^(node:)?(${names.join('|')})(/|$)`;
const any = (...res) => res.map((r) => `(?:${r})`).join('|');

// --- building blocks -------------------------------------------------------------------------
const CONTRACTS_ANY = ws('packages/contracts/', '@fb/contracts');
const CONTRACTS_WEB = any(ws('packages/contracts/src/web/', '@fb/contracts/web'));
const PLATFORM_ANY = ws('packages/platform/', '@fb/platform');
const platformSub = (sub) => ws(`packages/platform/src/${sub}/`, `@fb/platform/${sub}`);
const FLIGHT_CORE = ws('packages/flight-core/', '@fb/flight-core');
const MEMORY = ws('packages/memory/', '@fb/memory');
const ANY_SERVICE = any('^services/', '^@fb/(gateway|booking|hands|harness)(/|$)');
const TYPEBOX = npm('typebox', '@sinclair/typebox');
const PG = npm('pg', 'pg-pool', 'pg-protocol', 'pg-native', 'pg-cursor', 'pg-query-stream');
const IOREDIS = npm('ioredis');
const BULLMQ = npm('bullmq');
const PI = npmRe('@earendil-works/pi-[^/]+');
/** Network / file IO capable core modules (A-01: "任何网络或文件 IO", flight-core "网络"). */
const CORE_IO = core(
  'fs',
  'net',
  'http',
  'https',
  'http2',
  'dgram',
  'tls',
  'dns',
  'child_process',
  'vm',
  'worker_threads',
  'cluster',
  'inspector',
);
const CORE_NET = core('net', 'http', 'https', 'http2', 'dgram', 'tls', 'dns');
/** "third-party or workspace" target, i.e. not core and not a relative file inside the same module */
const NON_CORE = [
  'local',
  'npm',
  'npm-dev',
  'npm-optional',
  'npm-peer',
  'npm-bundled',
  'npm-no-pkg',
  'npm-unknown',
  'aliased',
  'aliased-workspace',
  'aliased-subpath-import',
  'aliased-tsconfig',
  'unknown',
  'undetermined',
];

/** @type {import('dependency-cruiser').IForbiddenRuleType[]} */
const forbidden = [
  // ---------------------------------------------------------------- global rules (A-01 §1.2 "另外")
  {
    name: 'no-child-process-vm',
    comment: 'A-01 §1.2: no package may use child_process or vm (eval is covered by ESLint).',
    severity: 'error',
    from: { path: '^(apps|services|packages)/' },
    to: { path: core('child_process', 'vm') },
  },
  {
    name: 'no-cross-service',
    comment: 'A-01 §1.2: a service never imports another service.',
    severity: 'error',
    from: { path: '^services/([^/]+)/' },
    to: { path: ANY_SERVICE, pathNot: ['^services/$1/', '^@fb/$1(/|$)'] },
  },

  // ---------------------------------------------------------------- packages/contracts
  {
    name: 'contracts-forbidden',
    comment: 'A-01 §1.2 contracts 禁止: 任何 workspace 包、任何网络或文件 IO.',
    severity: 'error',
    from: { path: '^packages/contracts/' },
    to: { path: any('^(apps|services|packages)/', '^@fb/', CORE_IO), pathNot: CONTRACTS_ANY },
  },
  {
    name: 'contracts-web-allowed',
    comment: 'A-01 §1.2 / §1.3: @fb/contracts/web may only use TypeBox (no server entry, no node:*).',
    severity: 'error',
    from: { path: '^packages/contracts/src/web/' },
    to: { pathNot: any('^packages/contracts/src/web/', '^@fb/contracts/web(/|$)', TYPEBOX) },
  },
  {
    name: 'contracts-server-allowed',
    comment:
      'A-01 §1.2: the server entry (and the tools/flight entries of CONTRACT-v1) may use TypeBox and node:crypto only.',
    severity: 'error',
    from: { path: '^packages/contracts/src/', pathNot: '^packages/contracts/src/web/' },
    to: { pathNot: any(CONTRACTS_ANY, TYPEBOX, core('crypto')) },
  },

  // ---------------------------------------------------------------- packages/flight-core
  {
    name: 'flight-core-allowed',
    comment: 'A-01 §1.2 flight-core 允许: contracts, node:sqlite, node:crypto.',
    severity: 'error',
    from: { path: '^packages/flight-core/' },
    to: { pathNot: any('^packages/flight-core/', '^@fb/flight-core(/|$)', CONTRACTS_ANY, core('sqlite', 'crypto')) },
  },
  {
    name: 'flight-core-forbidden',
    comment: 'A-01 §1.2 flight-core 禁止: platform, 任何服务, 网络.',
    severity: 'error',
    from: { path: '^packages/flight-core/' },
    to: { path: any(PLATFORM_ANY, ANY_SERVICE, CORE_NET) },
  },

  // ---------------------------------------------------------------- packages/memory
  {
    name: 'memory-allowed',
    comment: 'A-01 §1.2 memory 允许: contracts (storage is injected by hands).',
    severity: 'error',
    from: { path: '^packages/memory/' },
    to: { dependencyTypes: NON_CORE, pathNot: any('^packages/memory/', '^@fb/memory(/|$)', CONTRACTS_ANY) },
  },
  {
    name: 'memory-forbidden',
    comment: 'A-01 §1.2 memory 禁止: 任何服务, pg 驱动 (and no IO core modules — storage is injected).',
    severity: 'error',
    from: { path: '^packages/memory/' },
    to: { path: any(ANY_SERVICE, PG, platformSub('pg'), CORE_IO) },
  },

  // ---------------------------------------------------------------- packages/platform sub-entries
  ...[
    ['log', npm('pino')],
    ['trace', npmRe('@opentelemetry/api')],
    ['config', TYPEBOX],
    ['secrets', null],
    ['http', npm('undici')],
    ['fastify', any(npm('fastify'), npmRe('@fastify/[^/]+'), npmRe('ajv[^/]*'))],
    ['pg', PG],
    ['redis', IOREDIS],
  ].map(([sub, lib]) => ({
    name: `platform-${sub}-libs`,
    comment: `A-01 §1.2 sub-entry table: @fb/platform/${sub} may only use ${lib ? 'its own third-party library' : 'no third-party library'}.`,
    severity: /** @type {const} */ ('error'),
    from: { path: `^packages/platform/src/${sub}/` },
    to: {
      dependencyTypes: NON_CORE,
      pathNot: /** @type {string} */ (
        any('^packages/platform/', '^@fb/platform(/|$)', CONTRACTS_ANY, ...(lib ? [lib] : []))
      ),
    },
  })),

  // ---------------------------------------------------------------- services/gateway
  {
    name: 'gateway-allowed',
    comment:
      'A-01 §1.2 gateway 允许: contracts, platform 的全部子入口, bullmq. (type-only imports of npm types are tolerated)',
    severity: 'error',
    from: { path: '^services/gateway/' },
    to: {
      dependencyTypes: NON_CORE,
      dependencyTypesNot: ['type-only'],
      pathNot: any('^services/gateway/', CONTRACTS_ANY, PLATFORM_ANY, BULLMQ),
    },
  },
  {
    name: 'gateway-forbidden',
    comment: 'A-01 §1.2 gateway 禁止: flight-core, memory, 其他服务.',
    severity: 'error',
    from: { path: '^services/gateway/' },
    to: { path: any(FLIGHT_CORE, MEMORY) },
  },

  // ---------------------------------------------------------------- services/booking
  {
    name: 'booking-allowed',
    comment: 'A-01 §1.2 booking 允许: contracts, platform (除 redis).',
    severity: 'error',
    from: { path: '^services/booking/' },
    to: {
      dependencyTypes: NON_CORE,
      dependencyTypesNot: ['type-only'],
      pathNot: any('^services/booking/', CONTRACTS_ANY, PLATFORM_ANY),
    },
  },
  {
    name: 'booking-forbidden',
    comment: 'A-01 §1.2 booking 禁止: flight-core, memory, bullmq, ioredis, 其他服务 (and @fb/platform/redis).',
    severity: 'error',
    from: { path: '^services/booking/' },
    to: { path: any(FLIGHT_CORE, MEMORY, BULLMQ, IOREDIS, platformSub('redis')) },
  },
  {
    name: 'booking-reach-redis-bullmq',
    comment: 'A-01 §1.2: booking must not reach ioredis / bullmq transitively either.',
    severity: 'error',
    from: { path: '^services/booking/' },
    to: { path: any(BULLMQ, IOREDIS, platformSub('redis')), reachable: true },
  },

  // ---------------------------------------------------------------- services/hands
  {
    name: 'hands-allowed',
    comment: 'A-01 §1.2 hands 允许: contracts, platform (除 redis), flight-core, memory.',
    severity: 'error',
    from: { path: '^services/hands/' },
    to: {
      dependencyTypes: NON_CORE,
      dependencyTypesNot: ['type-only'],
      pathNot: any('^services/hands/', CONTRACTS_ANY, PLATFORM_ANY, FLIGHT_CORE, MEMORY),
    },
  },
  {
    name: 'hands-forbidden',
    comment: 'A-01 §1.2 hands 禁止: bullmq, ioredis, 其他服务, pi 的包 (and @fb/platform/redis).',
    severity: 'error',
    from: { path: '^services/hands/' },
    to: { path: any(BULLMQ, IOREDIS, PI, platformSub('redis')) },
  },
  {
    name: 'hands-reach-redis-bullmq-pi',
    comment: 'A-01 §1.2: hands must not reach ioredis / bullmq / pi transitively either.',
    severity: 'error',
    from: { path: '^services/hands/' },
    to: { path: any(BULLMQ, IOREDIS, PI, platformSub('redis')), reachable: true },
  },

  // ---------------------------------------------------------------- services/harness
  {
    name: 'harness-allowed',
    comment: 'A-01 §1.2 harness 允许: contracts, platform (除 pg), bullmq, @earendil-works/pi-*.',
    severity: 'error',
    from: { path: '^services/harness/' },
    to: {
      dependencyTypes: NON_CORE,
      dependencyTypesNot: ['type-only'],
      pathNot: any('^services/harness/', CONTRACTS_ANY, PLATFORM_ANY, BULLMQ, PI),
    },
  },
  {
    name: 'harness-forbidden',
    comment: 'A-01 §1.2 harness 禁止: @fb/platform/pg 和 pg, flight-core, memory, 其他服务.',
    severity: 'error',
    from: { path: '^services/harness/' },
    to: { path: any(platformSub('pg'), PG, FLIGHT_CORE, MEMORY) },
  },
  {
    name: 'harness-reach-pg',
    comment: 'A-01 §1.2: "harness 没有 pg 驱动" must hold transitively (e.g. through another platform sub-entry).',
    severity: 'error',
    from: { path: '^services/harness/' },
    to: { path: any(platformSub('pg'), PG), reachable: true },
  },

  // ---------------------------------------------------------------- apps/web (R-U1)
  {
    name: 'web-allowed',
    comment:
      'A-01 §1.2/§1.3, R-U1: apps/web may only import @fb/contracts/web among workspace packages, and no node:* builtins.',
    severity: 'error',
    from: { path: '^apps/web/' },
    to: { path: any('^(apps|services|packages)/', '^@fb/', '^node:'), pathNot: any('^apps/web/', CONTRACTS_WEB) },
  },
  {
    name: 'web-forbidden',
    comment:
      'A-01 §1.2 web 禁止: contracts 的其他入口, 任何服务, platform, flight-core, memory (plus Node core modules and server drivers).',
    severity: 'error',
    from: { path: '^apps/web/' },
    to: {
      path: any(
        CONTRACTS_ANY,
        ANY_SERVICE,
        PLATFORM_ANY,
        FLIGHT_CORE,
        MEMORY,
        PG,
        IOREDIS,
        BULLMQ,
        PI,
        npm('fastify', 'undici'),
      ),
      pathNot: CONTRACTS_WEB,
    },
  },
  {
    name: 'web-no-node-core',
    comment: 'apps/web runs in the browser: no Node core modules.',
    severity: 'error',
    from: { path: '^apps/web/' },
    to: { dependencyTypes: ['core'] },
  },

  // ---------------------------------------------------------------- eval/oracle
  {
    name: 'eval-oracle-isolated',
    comment:
      'A-01 §1.2 eval/oracle 什么都不依赖 (independent reference implementation, T04 must be isolated from flight-core).',
    severity: 'error',
    from: { path: '^eval/oracle/' },
    to: { path: any('^(apps|services|packages)/', '^@fb/') },
  },
];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden,
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|build|out|coverage)/|\\.d\\.ts$' },
    tsPreCompilationDeps: true,
    ...(fs.existsSync('tsconfig.base.json') ? { tsConfig: { fileName: 'tsconfig.base.json' } } : {}),
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    skipAnalysisNotInRules: true,
    reporterOptions: { text: { highlightFocused: true } },
  },
};
