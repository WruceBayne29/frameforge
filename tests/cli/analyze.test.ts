import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run, USAGE } from '../../scripts/analyze';
import type { CliIo } from '../../scripts/analyze';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sample = (name: string) => `${root}public/samples/${name}`;

function cli(args: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const io: CliIo = {
    readFile: (path) => readFileSync(path, 'utf8'),
    readStdin: () => stdin,
    writeFile: (path, text) => (written[path] = text),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = run(args, io);
  return { code, stdout: out.join(''), stderr: err.join(''), written };
}

describe('scripts/analyze.ts', () => {
  it('analyses a STAAD file and prints results JSON', () => {
    const { code, stdout, stderr } = cli([sample('portal-frame.std')]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.format).toBe('frameforge-results');
    expect(json.import.format).toBe('std');
    expect(json.import.warnings.length).toBeGreaterThan(0);
    expect(stderr).toMatch(/^warning: .*Load combinations/m);
    expect(json.reactions['1'].fy + json.reactions['4'].fy).toBeCloseTo(120, 8);
    expect(json.members['2'].stations).toBeUndefined();
  });

  it('passes options: load case, units, plane, name, stations, compact, output file', () => {
    const wind = JSON.parse(
      cli([sample('portal-frame.std'), '--load-case', '2', '--compact']).stdout,
    );
    expect(wind.appliedLoad[0]).toBeCloseTo(25, 12);
    const csv =
      '[nodes]\n1,0,0\n2,4000,0\n[members]\n1,1,2,ISMB 300\n[supports]\n1,fixed\n[nodal loads]\nnode,fy\n2,-10000';
    const r = cli(
      [
        '-',
        '--length',
        'mm',
        '--force',
        'N',
        '--plane',
        'none',
        '--name',
        'Stdin beam',
        '--stations',
        '-o',
        'out.json',
      ],
      csv,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    const json = JSON.parse(r.written['out.json']);
    expect(json.model).toMatchObject({ name: 'Stdin beam', plane: false });
    expect(json.reactions['1'].fy).toBeCloseTo(10, 9);
    expect(json.members['1'].stations.length).toBeGreaterThan(2);
    const forced = cli(
      ['-', '--format', 'json'],
      '{"nodes": [{"id": "a", "x": 0, "y": 0}, {"id": "b", "x": 1, "y": 0}], "members": [{"id": "m", "i": "a", "j": "b", "section": "ISMB 200"}], "supports": [{"node": "a", "restraints": "fixed"}]}',
    );
    expect(forced.code).toBe(0);
  });

  it('prints the imported model with --model', () => {
    const { code, stdout } = cli([sample('warren-truss.csv'), '--model']);
    expect(code).toBe(0);
    const model = JSON.parse(stdout);
    expect(model).toMatchObject({
      format: 'frameforge-project',
      kind: 'space',
      name: 'Warren truss (CSV sample)',
    });
    expect(model.members).toHaveLength(15);
    expect(
      JSON.parse(cli([sample('cantilever.json'), '--model', '--compact']).stdout).nodes,
    ).toHaveLength(2);
  });

  it('returns 2 for a model with errors and 3 for one that cannot be analysed', () => {
    const bad = cli(['-'], 'STAAD SPACE\nUNIT METER KN\nJOINT COORDINATES\n1 0 0 x');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('error: line 4: A joint line must contain only numbers.');
    expect(bad.stdout).toBe('');
    const mechanism = cli(
      ['-'],
      '{"nodes": [{"id": "a", "x": 0, "y": 0}, {"id": "b", "x": 1, "y": 0}], "members": [{"id": "m", "i": "a", "j": "b", "section": "ISMB 200"}]}',
    );
    expect(mechanism.code).toBe(3);
    expect(mechanism.stderr).toMatch(/^error: the model cannot be analysed/);
  });

  it('returns 1 for bad usage or an unreadable file', () => {
    expect(cli([]).code).toBe(1);
    expect(cli(['a', 'b']).code).toBe(1);
    expect(cli(['--bogus']).stderr).toMatch(/Unknown option --bogus/);
    expect(cli(['x.std', '--load-case']).stderr).toMatch(/--load-case needs a value/);
    for (const args of [
      ['--format', 'xml'],
      ['--length', 'ft'],
      ['--force', 'kip'],
      ['--load-case', 'two'],
      ['--plane', 'XZ'],
    ]) {
      expect(cli(['x', ...args]).code, args.join(' ')).toBe(1);
    }
    const missing = cli(['/nonexistent/model.std']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^Cannot read \/nonexistent\/model.std/);
    const help = cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toBe(USAGE);
  });

  it('runs as a real command through tsx', () => {
    const stdout = execFileSync(
      'npx',
      ['tsx', 'scripts/analyze.ts', sample('cantilever.json'), '--compact'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    expect(JSON.parse(stdout).reactions.A.fy).toBeCloseTo(15, 9);
    const failed = spawnSync('npx', ['tsx', 'scripts/analyze.ts', '-'], {
      cwd: root,
      input: 'nonsense',
      encoding: 'utf8',
    });
    expect(failed.status).toBe(2);
    expect(failed.stderr).toMatch(/Unrecognised model format/);
  }, 30000);
});
