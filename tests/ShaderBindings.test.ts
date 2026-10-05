/**
 * Tests for the WGSL/bind-group-layout contract.
 *
 * A compute kernel's resources are checked against its pipeline layout by
 * WebGPU, but only at pipeline-creation time and only on a real device — which
 * in this sim means "the whole field turns into the WebGPU-unavailable message,
 * on hardware, with a validation error in the console". Since several kernels
 * share a layout, adding a binding to one of them and forgetting the layout is
 * an easy mistake with a very indirect symptom.
 *
 * So the layouts are declared as plain data in bindLayouts.ts and these tests
 * parse the shader sources to check that every binding a kernel declares exists
 * in the layout its pipelines are built with, with a compatible kind and, for
 * storage textures, the same format. No GPU required.
 *
 * The check is one-directional — shader ⊆ layout — because a shared layout may
 * legitimately carry entries a given kernel has no use for. The obstacle field
 * is bound to every compute layout, but the dye injection kernel never asks
 * where the body is.
 */

import { describe, expect, it } from "vitest";
import {
  BIND_LAYOUT_NAMES,
  BIND_LAYOUTS,
  type BindingSpec,
  layoutBinding,
  OBSTACLE_BINDING,
  SCALAR_FORMAT,
  SHADER_LAYOUTS,
} from "../src/common/gpu/bindLayouts.js";

/**
 * The preamble, which declares no bindings of its own and is concatenated ahead
 * of all the others rather than compiled as a shader.
 */
const PREAMBLE = "common.wgsl";

/** Every shader in the folder, keyed by file name, so a new one cannot hide. */
const SHADER_SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob("../src/common/gpu/shaders/*.wgsl", { query: "?raw", import: "default", eager: true }),
  )
    .map(([path, source]) => [path.split("/").pop() ?? path, source as string] as const)
    .filter(([file]) => file !== PREAMBLE),
);

type Declaration = {
  readonly binding: number;
  readonly group: number;
  readonly name: string;
  readonly spec: BindingSpec;
};

/**
 * Parses the `@group(g) @binding(b) var<space> name : type;` declarations out of
 * a shader, mapping each to the layout entry it requires.
 *
 * WGSL cannot express the difference between a filterable and an unfilterable
 * texture — both are `texture_2d<f32>` — so a plain texture is only checked to
 * be a texture. Storage textures carry their format in the type and are checked
 * exactly, which is the half that actually drifts.
 */
function declarations(source: string): Declaration[] {
  const pattern = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]*)>)?\s+(\w+)\s*:\s*([^;]+);/g;
  const found: Declaration[] = [];

  for (const match of source.matchAll(pattern)) {
    const [, group, binding, addressSpace, name, rawType] = match;
    const type = (rawType ?? "").trim();

    const space = (addressSpace ?? "").trim();

    let spec: BindingSpec;
    if (space === "uniform") {
      spec = { kind: "uniform" };
    } else if (space.startsWith("storage")) {
      // `var<storage, read_write>` or `var<storage, read>`; the access mode is
      // optional in WGSL and defaults to read. It is checked because a buffer
      // declared read_write against a read-only-storage layout entry is a
      // pipeline-creation error, and a vertex stage may not have a writable one
      // at all.
      spec = { kind: "storageBuffer", access: space.includes("read_write") ? "read-write" : "read-only" };
    } else if (type === "sampler") {
      spec = { kind: "sampler" };
    } else {
      const storage = type.match(/^texture_storage_2d<\s*(\w+)\s*,/);
      if (storage) {
        spec = { kind: "storageTexture", format: storage[1] as GPUTextureFormat };
      } else {
        expect(type, `unrecognised binding type for ${name}`).toMatch(/^texture_2d</);
        spec = { kind: "texture", sampleType: "float" };
      }
    }

    found.push({ group: Number(group), binding: Number(binding), name: name ?? "", spec });
  }

  return found;
}

describe("shader binding declarations", () => {
  it("covers every shader file with a layout", () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect(Object.keys(SHADER_SOURCES).sort(byName)).toEqual(Object.keys(SHADER_LAYOUTS).sort(byName));
  });

  it("finds the declarations at all — every kernel binds at least a uniform and an output", () => {
    // Without this, a regex that stopped matching would make every check below
    // pass by looping over nothing.
    for (const [file, source] of Object.entries(SHADER_SOURCES)) {
      const found = declarations(source);
      expect(found.length, `${file} parsed to no bindings`).toBeGreaterThanOrEqual(2);
      expect(
        found.map((declaration) => declaration.spec.kind),
        file,
      ).toContain("uniform");
    }
  });

  it("declares every resource in group 0, which is the only group any pipeline binds", () => {
    for (const [file, source] of Object.entries(SHADER_SOURCES)) {
      for (const declaration of declarations(source)) {
        expect(declaration.group, `${file}: ${declaration.name}`).toBe(0);
      }
    }
  });

  it("declares no binding index twice within one shader", () => {
    for (const [file, source] of Object.entries(SHADER_SOURCES)) {
      const indices = declarations(source).map((declaration) => declaration.binding);
      expect(new Set(indices).size, `${file} reuses a binding index`).toBe(indices.length);
    }
  });

  it("matches every declared binding to an entry of the same kind in its layout", () => {
    for (const [file, layoutName] of Object.entries(SHADER_LAYOUTS)) {
      const source = SHADER_SOURCES[file];
      expect(source, `no source for ${file}`).toBeDefined();

      for (const declaration of declarations(source ?? "")) {
        const entry = layoutBinding(layoutName, declaration.binding);
        expect(
          entry,
          `${file}: binding ${declaration.binding} (${declaration.name}) is not in layout ${layoutName}`,
        ).toBeDefined();
        if (entry === undefined) {
          continue;
        }

        expect(entry.kind, `${file}: ${declaration.name} is a ${declaration.spec.kind}`).toBe(declaration.spec.kind);

        if (declaration.spec.kind === "storageTexture" && entry.kind === "storageTexture") {
          expect(entry.format, `${file}: ${declaration.name} writes a different format than its layout declares`).toBe(
            declaration.spec.format,
          );
        }

        if (declaration.spec.kind === "storageBuffer" && entry.kind === "storageBuffer") {
          expect(entry.access, `${file}: ${declaration.name} asks for a different access than its layout grants`).toBe(
            declaration.spec.access,
          );
        }
      }
    }
  });

  it("puts the obstacle field at the same binding in every kernel that reads it", () => {
    for (const [file, source] of Object.entries(SHADER_SOURCES)) {
      const obstacle = declarations(source).find((declaration) => declaration.name === "obstacleTex");
      if (obstacle !== undefined) {
        expect(obstacle.binding, `${file} binds the obstacle field somewhere else`).toBe(OBSTACLE_BINDING);
        expect(obstacle.spec.kind).toBe("texture");
      }
    }
  });

  it("offers the obstacle field to every compute layout except the one that writes it", () => {
    for (const name of BIND_LAYOUT_NAMES) {
      if (name === "mask" || BIND_LAYOUTS[name].stage !== "compute") {
        continue;
      }
      expect(layoutBinding(name, OBSTACLE_BINDING), `${name} cannot see the obstacle`).toEqual({
        kind: "texture",
        sampleType: "unfilterable-float",
      });
    }
  });

  it("writes the obstacle field as the scalar format the readers are declared with", () => {
    expect(BIND_LAYOUTS.mask.bindings[1]).toEqual({ kind: "storageTexture", format: SCALAR_FORMAT });
  });
});
