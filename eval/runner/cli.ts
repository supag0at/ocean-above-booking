// T13b eval entry. `node --experimental-strip-types eval/runner/cli.ts deterministic|agent|all`
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent.ts';
import { runDeterministic } from './deterministic.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'eval', 'reports');
const cmd = process.argv[2] ?? 'all';

mkdirSync(outDir, { recursive: true });

if (cmd === 'deterministic' || cmd === 'all') {
  const report = await runDeterministic();
  writeFileSync(join(outDir, 'deterministic.json'), JSON.stringify(report, null, 2));
  console.log(
    `deterministic ${report.passed}/${report.total} failed=${report.failed.length} oracleNotes=${report.oracleDisagreements.length}`,
  );
}

if (cmd === 'agent' || cmd === 'all') {
  try {
    const report = await runAgent(20);
    writeFileSync(join(outDir, 'agent.json'), JSON.stringify(report, null, 2));
    const passed = report.ran.filter((r) => r.status === 'pass').length;
    const failed = report.ran.filter((r) => r.status === 'fail').length;
    console.log(
      `agent pass=${passed} fail=${failed} calls=${report.modelCalls} notRun=${report.notRun.length} ${report.stoppedBecause}`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    writeFileSync(
      join(outDir, 'agent.json'),
      JSON.stringify({ modelCalls: 0, budget: 20, ran: [], notRun: [], stoppedBecause: reason }, null, 2),
    );
    console.error(reason);
    process.exitCode = 1;
  }
}
