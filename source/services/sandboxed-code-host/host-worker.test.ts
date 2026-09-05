import { describe, expect, it } from 'vitest';
import { buildWorkerSource } from './host-worker.js';

describe('buildWorkerSource', () => {
  it('injects capability names into a fixed template and nothing else', () => {
    const source = buildWorkerSource([
      { name: 'agent', kind: 'factory' },
      { name: 'tools', kind: 'namespace', members: ['read_file', 'grep'] },
    ]);

    expect(source).toMatchSnapshot();
  });

  it('differs between capability sets only in the injected name list', () => {
    const a = buildWorkerSource([{ name: 'agent', kind: 'factory' }]);
    const b = buildWorkerSource([{ name: 'tools', kind: 'namespace', members: ['grep'] }]);
    const strip = (source: string) => source.replace(/^const capabilities = .*$/m, 'const capabilities = <injected>;');

    expect(strip(a)).toBe(strip(b));
  });

  it('cannot turn a hostile capability name into executable source', () => {
    const name = "');process.exit(1);('";
    const source = buildWorkerSource([{ name, kind: 'factory' }]);
    const lines = source.split('\n').filter((line) => line.includes('process.exit'));

    // The name survives only as a JSON string on the injected line; it never
    // reaches the template as source.
    expect(lines).toEqual([`const capabilities = ${JSON.stringify([{ name, kind: 'factory' }])};`]);
  });

  it('reports idle from the template bridge, not the vm pending map, without relaxing codeGeneration', () => {
    const source = buildWorkerSource([{ name: 'tools', kind: 'namespace', members: ['echo'] }]);
    const installStart = source.indexOf('function installContextBindings');
    const installEnd = source.indexOf('const resolveResponse');
    const inContext = source.slice(installStart, installEnd);
    const template = source.slice(0, installStart) + source.slice(installEnd);

    expect(source).toContain('codeGeneration: { strings: false, wasm: false }');
    expect(inContext).not.toContain('workflow.idle');
    expect(inContext).not.toContain('workflow.busy');
    expect(template).toContain("send('workflow.idle'");
    expect(template).toContain("send('workflow.busy'");
    expect(template).toMatch(/endsWith\('\.run'\)/);
    expect(template).toMatch(/endsWith\('\.result'\)/);
  });
});
