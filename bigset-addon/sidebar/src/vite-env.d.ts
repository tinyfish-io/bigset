/// <reference types="svelte" />
/// <reference types="vite/client" />

// Google Apps Script runtime — available in the sidebar iframe
declare const google: {
  script: {
    run: {
      withSuccessHandler<T>(cb: (value: T) => void): {
        withFailureHandler(cb: (err: Error | string) => void): unknown;
        [key: string]: (...args: unknown[]) => unknown;
      };
      [key: string]: (...args: unknown[]) => unknown;
    };
  };
} | undefined;
