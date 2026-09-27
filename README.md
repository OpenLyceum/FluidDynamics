# Fluid Dynamics

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

Flow past an obstacle, from smooth laminar streamlines to a Kármán vortex
street to a turbulent wake — solved in real time on the GPU.

Built with [SceneryStack](https://scenerystack.org/), Vite 8, TypeScript 7 and
Biome 2.

Dye is injected in bands at the left edge of a channel and carried past a body in
the middle. Raising the flow speed (or lowering the viscosity) raises the
Reynolds number, and the wake changes character: attached and symmetric below
Re ≈ 47, shedding a periodic train of alternating vortices above it, and losing
coherence entirely by Re ≈ 200. The Reynolds number and the regime it implies are
shown beneath the field.

- **Intro** — a fixed cylinder and one control: flow speed.
- **Lab** — viscosity, obstacle size, shape (cylinder, flat plate, airfoil) and
  position, and four views of the field (dye, speed, vorticity, pressure).
  Vortex detail, dye fade and grid resolution live in Preferences → Simulation.
  Drag anywhere in the channel to push the fluid and add dye.

**WebGPU required.** The solver is Jos Stam's *Stable Fluids* running entirely in
WGSL compute shaders — there is no CPU fallback. Recent Chrome, Edge and Safari
support it. Where it is unavailable the sim boots normally and shows a message in
place of the field.

See [`doc/model.md`](doc/model.md) for the physics and its limits, and
[`doc/implementation-notes.md`](doc/implementation-notes.md) for the architecture.

## Features

- Stable Fluids solver in WGSL compute shaders (MacCormack advection, implicit
  viscous diffusion, vorticity confinement, red-black SOR pressure projection)
- Analytic signed-distance obstacles, so the body can be dragged and resized with
  no GPU resource churn
- Live accessible description of the flow, shared by the field and the screen
  summaries
- English, Spanish, and French localization via `StringManager`
- Default and projector color profiles
- Progressive Web App (installable, offline-capable)
- Git hooks for Biome pre-commit checks
- Shared GitHub Actions CI via `OpenLyceum/Baton`

## Quick Start

```bash
npm install
npm run icons    # generate PNG icons from public/icons/icon.svg
npm start        # dev server → http://localhost:5173
```

## Scripts

| Command | Description |
|---|---|
| `npm start` / `npm run dev` | Start Vite dev server |
| `npm run build` | Type-check + production build → `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm test` | Run Vitest unit tests (includes memory-leak suite) |
| `npm run test:fuzz` | Optional Playwright fuzz smoke: pointer (`?fuzz`) + keyboard (`?fuzzBoard`), with `?ea`, 30s each |
| `npm run test:fuzz -- 90` | Same fuzz for 90 seconds (`--duration 90` or `FUZZ_DURATION=90` also work) |
| `npm run test:fuzz:quick` | Shorter fuzz smoke (10s) |
| `npm run test:fuzz:long` | Longer fuzz smoke (300s) |
| `npm run test:browser` | WebGPU engine integration and toolbox drag tests (Playwright, `tests/browser/`) |
| `npm run check` | TypeScript type check |
| `npm run lint` | Biome lint check |
| `npm run format` | Auto-format all files |
| `npm run fix` | Lint + auto-fix |
| `npm run icons` | Regenerate PNG icons from `public/icons/icon.svg` |
| `npm run release` | `check && lint && build && test`, then version patch + push tags |
| `npm run clean` | Remove `dist/` |

## Tech Stack

| Tool | Version | Purpose |
|---|---|---|
| [SceneryStack](https://scenerystack.org/) | ^3.0.0 | Simulation framework |
| [Vite](https://vitejs.dev/) | ^8 | Build tool + dev server |
| [TypeScript](https://www.typescriptlang.org/) | ^7 | Type-safe JavaScript |
| [Biome](https://biomejs.dev/) | ^2.5 | Linting + formatting |
| [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) | ^1 | PWA + service worker |

## License

GNU Affero General Public License v3.0 — see [OpenLyceum org license](https://github.com/OpenLyceum/.github/blob/main/LICENSE).

## Contributing

See [OpenLyceum contributing guidelines](https://github.com/OpenLyceum/.github/blob/main/CONTRIBUTING.md).
Report bugs via GitHub Issues; use org issue templates.
