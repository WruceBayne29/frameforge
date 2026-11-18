/**
 * Headless analysis: reads a model (FrameForge / interchange JSON, CSV bundle or STAAD.Pro
 * .std), runs the same solver as the app and prints the results as JSON, so other software
 * can use FrameForge without a browser.
 *
 *   npx tsx scripts/analyze.ts model.std > results.json
 *   npm run --silent analyze -- model.csv --length mm --force N --stations
 *   cat model.json | npx tsx scripts/analyze.ts -
 *
 * Exit codes: 0 analysed, 1 bad usage or unreadable file, 2 the model has errors,
 * 3 the model cannot be analysed (e.g. a mechanism). Problems go to stderr.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ImportFormat, ModelImportOptions, PlaneOption } from '../src/import';
import { importModelText, issueText, resultsJson } from '../src/import';
import { analyzeProject3D } from '../src/model3d/analysis';
import { serializeProject3D } from '../src/io/projectFile3d';

export const USAGE = `Usage: analyze <model file | -> [options]

Reads a FrameForge .json model, a CSV bundle or a STAAD.Pro .std file and prints the
analysis results as JSON (kN, m, rad). "-" reads the model from standard input.

Options:
  --format json|csv|std   format of the input (default: from the extension / content)
  --length m|mm           CSV: length unit (default m, or the bundle's [settings])
  --force kN|N            CSV: force unit (default kN, or the bundle's [settings])
  --load-case N           STAAD: primary load case to analyse (default: the first)
  --plane auto|XY|none    plane-frame mode (CSV / STAAD; default auto / from the file)
  --name NAME             model name
  --stations              include internal forces along every member
  --model                 print the imported model (FrameForge .json) instead of results
  --compact               print JSON on one line
  -o, --output FILE       write to FILE instead of standard output
  -h, --help              show this help
`;

export interface CliIo {
  readFile: (path: string) => string;
  readStdin: () => string;
  writeFile: (path: string, text: string) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const VALUE_OPTIONS = new Set([
  '--format',
  '--length',
  '--force',
  '--load-case',
  '--plane',
  '--name',
  '-o',
  '--output',
]);
const FLAG_OPTIONS = new Set(['--stations', '--model', '--compact', '-h', '--help']);

/** Runs the command line; returns the exit code. */
export function run(args: string[], io: CliIo): number {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const files: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (VALUE_OPTIONS.has(arg)) {
      if (k + 1 >= args.length) {
        io.stderr(`${arg} needs a value.\n\n${USAGE}`);
        return 1;
      }
      values[arg === '-o' ? '--output' : arg] = args[++k];
    } else if (FLAG_OPTIONS.has(arg)) flags.add(arg === '-h' ? '--help' : arg);
    else if (arg.startsWith('-') && arg !== '-') {
      io.stderr(`Unknown option ${arg}.\n\n${USAGE}`);
      return 1;
    } else files.push(arg);
  }
  if (flags.has('--help')) {
    io.stdout(USAGE);
    return 0;
  }
  if (files.length !== 1) {
    io.stderr(USAGE);
    return 1;
  }

  const options: ModelImportOptions = {};
  const format = values['--format'];
  if (format !== undefined) {
    if (!['json', 'csv', 'std'].includes(format)) {
      io.stderr('--format must be json, csv or std.\n');
      return 1;
    }
    options.format = format as ImportFormat;
  }
  const length = values['--length'];
  const force = values['--force'];
  if ((length && length !== 'm' && length !== 'mm') || (force && force !== 'kN' && force !== 'N')) {
    io.stderr('--length must be m or mm, and --force kN or N.\n');
    return 1;
  }
  if (length || force) {
    options.units = {};
    if (length) options.units.length = length as 'm' | 'mm';
    if (force) options.units.force = force as 'kN' | 'N';
  }
  if (values['--load-case'] !== undefined) {
    const n = Number(values['--load-case']);
    if (!Number.isInteger(n)) {
      io.stderr('--load-case must be a whole number.\n');
      return 1;
    }
    options.loadCase = n;
  }
  const plane = values['--plane'];
  if (plane !== undefined) {
    if (!['auto', 'XY', 'none'].includes(plane)) {
      io.stderr('--plane must be auto, XY or none.\n');
      return 1;
    }
    options.plane = plane as PlaneOption;
  }
  if (values['--name']) options.name = values['--name'];

  const file = files[0];
  let text: string;
  try {
    text = file === '-' ? io.readStdin() : io.readFile(file);
  } catch (e) {
    io.stderr(`Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (file !== '-') options.filename = basename(file);

  const imported = importModelText(text, options);
  for (const w of imported.warnings) io.stderr(`warning: ${issueText(w)}\n`);
  if (!imported.project) {
    for (const e of imported.errors) io.stderr(`error: ${issueText(e)}\n`);
    return 2;
  }
  const project = imported.project;
  const indent = flags.has('--compact') ? undefined : 2;
  let output: string;
  if (flags.has('--model')) {
    output = flags.has('--compact')
      ? JSON.stringify(JSON.parse(serializeProject3D(project)))
      : serializeProject3D(project);
  } else {
    let results;
    try {
      results = resultsJson(project, analyzeProject3D(project), {
        stations: flags.has('--stations'),
      });
    } catch (e) {
      io.stderr(
        `error: the model cannot be analysed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 3;
    }
    output = JSON.stringify(
      {
        ...results,
        import: { format: imported.format, warnings: imported.warnings.map(issueText) },
      },
      null,
      indent,
    );
  }
  if (values['--output']) io.writeFile(values['--output'], `${output}\n`);
  else io.stdout(`${output}\n`);
  return 0;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = run(process.argv.slice(2), {
    readFile: (path) => readFileSync(path, 'utf8'),
    readStdin: () => readFileSync(0, 'utf8'),
    writeFile: (path, text) => writeFileSync(path, text),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
