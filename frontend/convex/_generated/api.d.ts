/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type * as auth_config from "../auth.config.js";
import type * as datasetRows from "../datasetRows.js";
import type * as datasets from "../datasets.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_quota from "../lib/quota.js";
import type * as publicSeed from "../publicSeed.js";
import type * as quota from "../quota.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  "auth.config": typeof auth_config;
  "datasetRows": typeof datasetRows;
  "datasets": typeof datasets;
  "lib/authz": typeof lib_authz;
  "lib/quota": typeof lib_quota;
  "publicSeed": typeof publicSeed;
  "quota": typeof quota;
}>;
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
export declare const components: {};
