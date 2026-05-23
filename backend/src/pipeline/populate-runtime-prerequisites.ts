export interface PopulateRuntimePrerequisites {
  convexUrl?: string;
  convexAdminKey?: string;
  openRouterApiKey?: string;
  tinyFishApiKey?: string;
  shouldCommitRows?: boolean;
  shouldLoadDatasetContext?: boolean;
}

export function missingPopulateRuntimePrerequisites(
  input: PopulateRuntimePrerequisites
): string[] {
  const requiredKeys: Array<[string, string | undefined]> = [];
  if ((input.shouldCommitRows ?? true) || input.shouldLoadDatasetContext) {
    requiredKeys.push(["CONVEX_URL", input.convexUrl]);
    requiredKeys.push(["CONVEX_SELF_HOSTED_ADMIN_KEY", input.convexAdminKey]);
  }
  requiredKeys.push(
    ["OPENROUTER_API_KEY", input.openRouterApiKey],
    ["TINYFISH_API_KEY", input.tinyFishApiKey]
  );

  return requiredKeys
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

export function populateRuntimePrerequisiteError(
  input: PopulateRuntimePrerequisites
): string | undefined {
  const missingNames = missingPopulateRuntimePrerequisites(input);
  if (missingNames.length === 0) {
    return undefined;
  }
  return `Backend is missing required populate runtime keys: ${missingNames.join(", ")}.`;
}
