// WO-3277 (a): the native Linux bridge links Uc100Net's Compat UC100 in place
// of the Windows DLL (pendant/uccnc-bridge/uccnc-bridge-net.csproj). The bridge
// reads the soft-limit enable back after Apply and at Connect through
// Machine.cs TryGetSoftLimitEnabled, which binds `public static int
// GetSoftLimit(ref bool)` by reflection. Without that method the native route
// printed "does not expose GetSoftLimit, so it could not be read back"
// (src/tests/evidence/WO-3121/machine-seat/sim-acceptance-20261026/run1/gaps.txt).
//
// This compiles the wrapper's own sources with a small probe into a temp
// directory (nothing is written into the repo), binds GetSoftLimit exactly as
// the bridge does, and reads back what SetSoftLimit stored, both on and off.
// No board is open on the desk, so every call returns rc 1 (not open), as
// GetOffline does for its flag; the value still has to be the one set.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const repo = path.resolve(__dirname, '../../..')
const uc100 = path.join(repo, 'pendant/uc100net/src/Uc100Net/Compat/UC100.cs')
const machine = path.join(repo, 'pendant/uccnc-bridge/Machine.cs')

function findDotnet(): string | null {
  const exe = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'
  const candidates = [
    process.env.DOTNET_ROOT && path.join(process.env.DOTNET_ROOT, exe),
    path.join(homedir(), '.dotnet', exe),
    ...(process.env.PATH ?? '').split(path.delimiter).map(dir => dir && path.join(dir, exe)),
  ]
  return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null
}
const dotnet = findDotnet()

const probeSource = String.raw`
using System;
using System.Reflection;
using Uc100Net.Compat;

static class Probe
{
    // Machine.cs TryGetSoftLimitEnabled, the same binding.
    static bool TryGetSoftLimitEnabled(ref bool enabled, out int rc)
    {
        MethodInfo method = typeof(UC100).GetMethod(
            "GetSoftLimit",
            BindingFlags.Public | BindingFlags.Static,
            null,
            new Type[] { typeof(bool).MakeByRefType() },
            null);
        if (method == null) { rc = 0; return false; }
        object[] args = { enabled };
        rc = (int)method.Invoke(null, args);
        enabled = (bool)args[0];
        return true;
    }

    static void Main()
    {
        foreach (bool wanted in new[] { true, false, true })
        {
            int setRc = UC100.SetSoftLimit(wanted);
            bool got = !wanted;
            bool bound = TryGetSoftLimitEnabled(ref got, out int getRc);
            Console.WriteLine("READBACK " + wanted + " set=" + setRc + " bound=" + bound + " get=" + getRc + " value=" + got);
        }
    }
}
`

describe('WO-3277 native UC100 soft-limit readback', () => {
  const roots: string[] = []
  afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) })

  it('declares GetSoftLimit with the signature the bridge binds', () => {
    const bridge = fs.readFileSync(machine, 'utf8')
    expect(bridge).toMatch(/GetMethod\(\s*"GetSoftLimit"[\s\S]{0,200}typeof\(bool\)\.MakeByRefType\(\)/)
    const wrapper = fs.readFileSync(uc100, 'utf8')
    expect(wrapper).toMatch(/public static int GetSoftLimit\(ref bool \w+\)/)
  })

  it.skipIf(!dotnet)('reads back the soft-limit enable SetSoftLimit stored, on and off', () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'liencam-wo3277-'))
    roots.push(root)
    const sources = path.join(repo, 'pendant/uc100net/src/Uc100Net').split(path.sep).join('/')
    fs.writeFileSync(path.join(root, 'Probe.cs'), probeSource)
    fs.writeFileSync(path.join(root, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
    <NoWarn>$(NoWarn);CS8600;CS8602;CS8605</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Probe.cs" />
    <Compile Include="${sources}/**/*.cs" Exclude="${sources}/obj/**;${sources}/bin/**" />
  </ItemGroup>
</Project>
`)
    const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' }
    const out = execFileSync(dotnet!, ['run', '--project', path.join(root, 'Probe.csproj'), '-c', 'Release'],
      { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 })
    const lines = out.split(/\r?\n/).filter(line => line.startsWith('READBACK '))
    expect(lines).toEqual([
      'READBACK True set=1 bound=True get=1 value=True',
      'READBACK False set=1 bound=True get=1 value=False',
      'READBACK True set=1 bound=True get=1 value=True',
    ])
  }, 300_000)
})
