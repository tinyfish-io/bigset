/**
 * Wraps a LanguageModel with a Proxy to cap or default the maxTokens parameter.
 * This prevents OpenRouter 402 errors due to requesting the default 65535 maxTokens.
 */
export function wrapModelWithTokenLimit(
  model: any,
  maxTokensLimit: number = 8192,
): any {
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === "doGenerate") {
        return async function (options: any) {
          const modifiedOptions = { ...options };
          if (typeof modifiedOptions.maxTokens === "number") {
            modifiedOptions.maxTokens = Math.min(modifiedOptions.maxTokens, maxTokensLimit);
          } else {
            modifiedOptions.maxTokens = maxTokensLimit;
          }
          return target.doGenerate(modifiedOptions);
        };
      }
      if (prop === "doStream") {
        return async function (options: any) {
          const modifiedOptions = { ...options };
          if (typeof modifiedOptions.maxTokens === "number") {
            modifiedOptions.maxTokens = Math.min(modifiedOptions.maxTokens, maxTokensLimit);
          } else {
            modifiedOptions.maxTokens = maxTokensLimit;
          }
          return target.doStream(modifiedOptions);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === "function") {
        return val.bind(target);
      }
      return val;
    },
  });
}
