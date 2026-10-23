import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gpu = vi.hoisted(() => ({
  renderImpl: null,
  forceContextLoss: vi.fn(),
  dispose: vi.fn(),
  canvas: null,
}));

vi.mock("three", () => {
  class BufferAttribute {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
    }
  }
  class BufferGeometry {
    setAttribute() {}
    dispose() {}
  }
  class Color {
    constructor() {}
  }
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
    copy() {
      return this;
    }
    sub() {
      return this;
    }
    normalize() {
      return this;
    }
    addScaledVector() {
      return this;
    }
    applyMatrix4() {
      return this;
    }
    unproject() {
      return this;
    }
    dot() {
      return 0;
    }
  }
  class Matrix4 {
    constructor() {
      this.elements = new Array(16).fill(0);
    }
    copy() {
      return this;
    }
    invert() {
      return this;
    }
  }
  class Scene {
    add() {}
    clear() {}
  }
  class PerspectiveCamera {
    constructor() {
      this.position = { set() {}, x: 0, y: 0, z: 0 };
      this.projectionMatrix = new Matrix4();
      this.projectionMatrixInverse = new Matrix4();
      this.matrixWorldInverse = new Matrix4();
    }
    lookAt() {}
    updateProjectionMatrix() {}
    updateMatrixWorld() {}
  }
  class ShaderMaterial {
    dispose() {}
  }
  class Points {
    constructor() {
      this.frustumCulled = false;
    }
  }
  class Timer {
    update() {}
    getElapsed() {
      return 0.016;
    }
  }
  class WebGLRenderer {
    constructor() {
      gpu.canvas = document.createElement("canvas");
      this.domElement = gpu.canvas;
    }
    setPixelRatio() {}
    setClearColor() {}
    setSize() {}
    render(...args) {
      if (typeof gpu.renderImpl === "function") return gpu.renderImpl(...args);
    }
    dispose() {
      gpu.dispose();
    }
    forceContextLoss() {
      gpu.forceContextLoss();
    }
  }
  return {
    BufferAttribute,
    BufferGeometry,
    Color,
    Vector3,
    Scene,
    PerspectiveCamera,
    ShaderMaterial,
    Points,
    Timer,
    WebGLRenderer,
    AdditiveBlending: 2,
    MathUtils: {
      smoothstep: (x, a, b) => {
        if (x <= a) return 0;
        if (x >= b) return 1;
        const t = (x - a) / (b - a);
        return t * t * (3 - 2 * t);
      },
    },
  };
});

vi.mock("../../dashboard/components/ProviderIcon.jsx", () => ({
  ProviderIcon: () => null,
}));

import { TokenGalaxy } from "./TokenGalaxy";

describe("TokenGalaxy runtime WebGL fallback", () => {
  let rafCallbacks;

  beforeEach(() => {
    rafCallbacks = [];
    gpu.renderImpl = null;
    gpu.forceContextLoss.mockClear();
    gpu.dispose.mockClear();
    gpu.canvas = null;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls back to static mode when renderer.render throws shaderSource TypeError", async () => {
    let frames = 0;
    gpu.renderImpl = () => {
      frames += 1;
      // Succeed on the synchronous setup frame; fail on the next queued rAF —
      // matching Safari compiling shaders mid-loop (TOKENTRACKER-DASHBOARD-1).
      if (frames >= 2) {
        throw new TypeError(
          "Argument 1 ('shader') to WebGL2RenderingContext.shaderSource must be an instance of WebGLShader",
        );
      }
    };

    const { container, unmount } = render(<TokenGalaxy mode="full" progressRef={{ current: 0 }} />);
    await waitFor(() => {
      expect(container.firstElementChild).toHaveAttribute("data-mode", "webgl");
    });
    expect(rafCallbacks.length).toBeGreaterThan(0);

    // Drive the queued animation frame so the inner try/catch path runs.
    await act(async () => {
      rafCallbacks[rafCallbacks.length - 1]();
    });

    await waitFor(() => {
      expect(container.firstElementChild).toHaveAttribute("data-mode", "static");
    });
    expect(gpu.dispose).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalled();

    // Unmount after fallback must not dispose twice.
    unmount();
    expect(gpu.dispose).toHaveBeenCalledTimes(1);
  });

  it("falls back to static mode on webglcontextlost", async () => {
    const { container } = render(<TokenGalaxy mode="full" progressRef={{ current: 0 }} />);
    await waitFor(() => {
      expect(container.firstElementChild).toHaveAttribute("data-mode", "webgl");
    });
    expect(gpu.canvas).toBeTruthy();

    fireEvent(gpu.canvas, new Event("webglcontextlost", { cancelable: true }));

    await waitFor(() => {
      expect(container.firstElementChild).toHaveAttribute("data-mode", "static");
    });
    expect(gpu.dispose).toHaveBeenCalled();
  });
});
