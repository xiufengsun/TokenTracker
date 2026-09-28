import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { TOKEN_FORMAT_MODES, TOKEN_FORMAT_STORAGE_KEY, TOKEN_UNIT_SYSTEM_STORAGE_KEY } from "../../../lib/token-format.js";
import { LocaleProvider } from "../LocaleProvider.jsx";
import { TokenFormatModeOverride, TokenFormatProvider } from "../TokenFormatProvider.jsx";

function createStorage() {
  const store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => {
      store[key] = String(value);
    },
  };
}

function Probe() {
  const { formatTokens, formatTokensTooltip, setMode, unitSystem, setUnitSystem } = useTokenFormat();
  return (
    <>
      <output>{formatTokens(12_345_678)}</output>
      <output>{formatTokensTooltip(12_345_678)}</output>
      <button type="button" onClick={() => setMode(TOKEN_FORMAT_MODES.FULL)}>
        {TOKEN_FORMAT_MODES.FULL}
      </button>
      <button type="button" onClick={() => setUnitSystem("chinese")}>
        unit-{unitSystem}
      </button>
    </>
  );
}

function OverrideProbe() {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  return (
    <>
      <output data-testid="override-value">{formatTokens(12_345_678)}</output>
      <output data-testid="override-tooltip">{formatTokensTooltip(12_345_678)}</output>
    </>
  );
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createStorage(),
  });
});

it("updates and persists the global display mode", async () => {
  const user = userEvent.setup();
  render(
    <LocaleProvider>
      <TokenFormatProvider>
        <Probe />
      </TokenFormatProvider>
    </LocaleProvider>,
  );

  expect(screen.getByText("12.3M")).toBeInTheDocument();
  expect(screen.getByText("12.3M · 12,345,678")).toBeInTheDocument();

  await act(async () => {
    await user.click(screen.getByRole("button", { name: "full" }));
  });

  expect(screen.getAllByText("12,345,678")).toHaveLength(2);
  expect(window.localStorage.getItem(TOKEN_FORMAT_STORAGE_KEY)).toBe("full");
});

it("switches compact units to Wan/Yi and persists the choice", async () => {
  const user = userEvent.setup();
  render(
    <LocaleProvider>
      <TokenFormatProvider>
        <Probe />
      </TokenFormatProvider>
    </LocaleProvider>,
  );

  expect(screen.getByText("12.3M")).toBeInTheDocument();

  await act(async () => {
    await user.click(screen.getByRole("button", { name: "unit-english" }));
  });

  expect(screen.getByText("1234.6万")).toBeInTheDocument();
  expect(screen.getByText("1234.6万 · 12,345,678")).toBeInTheDocument();
  expect(window.localStorage.getItem(TOKEN_UNIT_SYSTEM_STORAGE_KEY)).toBe("chinese");
});

it("migrates a persisted legacy chinese mode on mount", () => {
  window.localStorage.setItem(TOKEN_FORMAT_STORAGE_KEY, "chinese");

  render(
    <LocaleProvider>
      <TokenFormatProvider>
        <Probe />
      </TokenFormatProvider>
    </LocaleProvider>,
  );

  expect(screen.getByText("1234.6万")).toBeInTheDocument();
  expect(window.localStorage.getItem(TOKEN_FORMAT_STORAGE_KEY)).toBe("compact");
  expect(window.localStorage.getItem(TOKEN_UNIT_SYSTEM_STORAGE_KEY)).toBe("chinese");
});

it("keeps a scoped modal compact while the persisted global mode is full", () => {
  window.localStorage.setItem(TOKEN_FORMAT_STORAGE_KEY, TOKEN_FORMAT_MODES.FULL);

  render(
    <LocaleProvider>
      <TokenFormatProvider>
        <TokenFormatModeOverride mode={TOKEN_FORMAT_MODES.COMPACT}>
          <OverrideProbe />
        </TokenFormatModeOverride>
      </TokenFormatProvider>
    </LocaleProvider>,
  );

  expect(screen.getByTestId("override-value")).toHaveTextContent("12.3M");
  expect(screen.getByTestId("override-tooltip")).toHaveTextContent("12.3M · 12,345,678");
  expect(window.localStorage.getItem(TOKEN_FORMAT_STORAGE_KEY)).toBe("full");
});

it("honors Chinese units in an override without a parent provider", () => {
  window.localStorage.setItem(TOKEN_UNIT_SYSTEM_STORAGE_KEY, "chinese");
  render(<TokenFormatModeOverride mode="compact"><OverrideProbe /></TokenFormatModeOverride>);
  expect(screen.getByTestId("override-value")).toHaveTextContent("1234.6万");
  expect(screen.getByTestId("override-tooltip")).toHaveTextContent("1234.6万 · 12,345,678");
});

it("accepts a legacy Chinese preference from another window", () => {
  render(<LocaleProvider><TokenFormatProvider><Probe /></TokenFormatProvider></LocaleProvider>);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: TOKEN_FORMAT_STORAGE_KEY, newValue: "chinese" })));
  expect(screen.getByText("1234.6万")).toBeInTheDocument();
});

it("mirrors the unit system to the macOS menu bar on mount and on change", async () => {
  const postMessage = vi.fn();
  window.webkit = { messageHandlers: { nativeBridge: { postMessage } } };
  try {
    const user = userEvent.setup();
    render(<LocaleProvider><TokenFormatProvider><Probe /></TokenFormatProvider></LocaleProvider>);
    const unitPushes = () =>
      postMessage.mock.calls.map(([m]) => m).filter((m) => m.key === "tokenUnitSystem");
    expect(unitPushes()).toEqual([{ type: "setSetting", key: "tokenUnitSystem", value: "english" }]);

    await user.click(screen.getByRole("button", { name: "unit-english" }));
    expect(unitPushes().at(-1)).toEqual({ type: "setSetting", key: "tokenUnitSystem", value: "chinese" });
  } finally {
    delete window.webkit;
  }
});
