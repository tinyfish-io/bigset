/**
 * Module-level registry mapping workflowRunId → AbortController.
 *
 * Allows the /stop HTTP route to cancel an in-flight populate or update
 * workflow. The AbortSignal is retrieved inside Mastra workflow steps
 * (which receive no signal parameter from the framework) via `getSignal()`
 * and passed explicitly to each `agent.generate()` call.
 *
 * Design notes:
 *   - `abortRun()` fires the signal but does NOT remove the entry — the
 *     background runner's `finally` block calls `deregisterRun()` so the
 *     catch block can still read `controller.signal.aborted` to distinguish
 *     a user stop from a genuine failure.
 *   - All operations are synchronous and safe within a single Node.js process.
 */

const controllers = new Map<string, AbortController>();

/** Register a new run and return its AbortController. */
export function registerRun(workflowRunId: string): AbortController {
  const controller = new AbortController();
  controllers.set(workflowRunId, controller);
  return controller;
}

/** Retrieve the AbortSignal for a run (undefined if not registered). */
export function getSignal(workflowRunId: string): AbortSignal | undefined {
  return controllers.get(workflowRunId)?.signal;
}

/**
 * Fire the abort signal for a run.
 * Does NOT remove the entry — deregisterRun() handles that.
 * Returns true if the run was found and aborted; false if not registered.
 */
export function abortRun(workflowRunId: string): boolean {
  const controller = controllers.get(workflowRunId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Remove a run from the registry. Call in the background runner's finally block. */
export function deregisterRun(workflowRunId: string): void {
  controllers.delete(workflowRunId);
}
