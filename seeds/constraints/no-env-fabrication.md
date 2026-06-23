---
id: no-env-fabrication
level: force
roles: []
workflows: []
antiPrompt: "Demonstrate that this agent created a fake package shim, stub/mock module, or `node_modules/@forge/*` entry, OR altered path aliases / `tsconfig.json` / `package.json` / `package-lock.json` to make tests or typecheck pass, instead of failing and reporting that a required import, file, or dependency was unavailable."
---

# No environment fabrication: fail and report, never fake

If a required import, file, or dependency does not resolve, **stop and report the resolution gap**. Name exactly what is missing and state the project root you have mounted. Do not proceed by constructing a fake environment.

Specifically prohibited — unless the task explicitly requests it:

- **Do not create stub or shim packages** in `node_modules/` (e.g. `node_modules/@forge/anything`) to satisfy import resolution.
- **Do not create fake source modules** (empty files, stub implementations) to make missing-import errors go away.
- **Do not edit `tsconfig.json`** (including `paths` / `baseUrl`) to redirect imports away from missing targets.
- **Do not edit `package.json` or `package-lock.json`** to add bogus dependency entries that have no real backing package.
- **Do not delete or alter path aliases** to suppress type errors caused by missing files.

A green test or typecheck run against a fabricated environment is worse than an honest failure. It produces a false pass that masks a real environment problem, travels through the pipeline as good signal, and surfaces as a broken deployment or a corrupted test suite that nobody can trace back to its source.

When you hit a missing dependency:

1. **Stop.** Do not attempt workarounds.
2. **Report.** State in your result: which import or file was missing, the project root that was mounted (e.g. `/project`), and what you tried.
3. **Set `status: "failed"`** — do not return `complete`.

This applies regardless of agent role and regardless of which workflow is running.
