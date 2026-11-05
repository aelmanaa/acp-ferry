# 0005: TypeScript; the spec package is runtime-neutral, the broker is Node-only

Status: Accepted (2026-11-05)

## Context

ACP's main SDK is TypeScript. The spec types should be usable by any client, including editors,
browsers and edge runtimes. The broker spawns agent processes and reads session files, which needs
Node.

## Decision

- Write everything in strict TypeScript: no `any`, no `@ts-` directives, no casts, and a type-escape
  check whose allowlist starts empty.
- `@acp-ferry/spec` holds the draft types, the identifier parsers and later the JSON Schemas. It uses
  only web-platform globals and never imports a Node built-in.
- `@acp-ferry/broker` and later packages that spawn processes or touch the file system are
  Node-only.

## Consequences

- Enforced twice for `packages/spec`: oxlint `import/no-nodejs-modules`, and
  `tsconfig.build.json` builds with `types: []`, so Node APIs do not typecheck.
- Spec types are `readonly`, use discriminated unions, and are marked `@experimental` until the
  extension is reviewed upstream.
