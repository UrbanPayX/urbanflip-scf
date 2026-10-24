/**
 * Stellar Wallets Kit reads `localStorage` while its modules load. In a
 * third-party iframe whose storage the browser blocks, merely reading
 * `window.localStorage` throws a SecurityError, which would stop the whole
 * bundle. This module is imported first and swaps in an in-memory store so
 * the widget still works (the kit then just forgets the last-used wallet).
 */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(String(key)) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => {
      data.delete(String(key));
    },
    setItem: (key, value) => {
      data.set(String(key), String(value));
    },
  };
}

try {
  globalThis.localStorage.getItem('@urbanflip/probe');
} catch {
  try {
    Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  } catch {
    // Not redefinable in this browser: the kit will fail to load. The page's
    // static "loading" text stays, and the host gets no message.
  }
}

export {};
