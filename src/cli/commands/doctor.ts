import { Command } from 'commander';
import { defaultBundlePath } from '../../core/bundle.js';
import { type CheckStatus, runDoctor } from '../../services/doctor.js';
import { parseOutputFormat, printRows } from '../output.js';

interface DoctorOptions {
  store: string;
  deep: boolean;
  deepSample: string;
  checks?: string;
  strict: boolean;
  outputFormat: string;
}

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Run health checks against a prosa bundle.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--deep', 'include slow checks (integrity_check, CAS hash sampling)', false)
    .option('--deep-sample <n>', 'number of CAS objects to verify when --deep is set', String(100))
    .option(
      '--checks <list>',
      'comma-separated check names or dotted prefixes to include (default: all)',
    )
    .option('--strict', 'exit non-zero on warnings as well as failures', false)
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .action(async (options: DoctorOptions) => {
      // Doctor intentionally does NOT go through withBundle: it must keep
      // running when the bundle is unopenable (missing manifest, schema
      // mismatch) so it can report the problem instead of crashing.
      const format = parseOutputFormat(options.outputFormat, 'table');
      const deepSample = Number.parseInt(options.deepSample, 10);
      if (!Number.isFinite(deepSample) || deepSample <= 0) {
        process.stderr.write(`invalid --deep-sample: ${options.deepSample}\n`);
        process.exit(2);
      }
      const checks = options.checks
        ? options.checks
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined;

      const report = await runDoctor({
        storePath: options.store,
        deep: options.deep,
        deepSample,
        checks,
      });

      printRows(report.checks, {
        format,
        columns: ['check', 'status', 'message', 'hint'],
        meta:
          format === 'json'
            ? {
                store_path: report.storePath,
                bundle_opened: report.bundleOpened,
                summary: report.summary,
              }
            : undefined,
      });
      if (format === 'table' || format === 'interactive') {
        const s = report.summary;
        process.stdout.write(
          `\npass=${s.pass} info=${s.info} warn=${s.warn} fail=${s.fail} skipped=${s.skipped} (${s.duration_ms} ms)\n`,
        );
      }

      process.exit(
        exitCodeFor(
          report.checks.map((c) => c.status),
          options.strict,
          report.bundleOpened,
        ),
      );
    });
}

function exitCodeFor(statuses: CheckStatus[], strict: boolean, bundleOpened: boolean): number {
  const hasFail = statuses.includes('fail');
  if (hasFail) return bundleOpened ? 1 : 2;
  if (strict && statuses.includes('warn')) return 1;
  return 0;
}
