/**
 * The process's readiness state, as `/health/ready` reports it.
 *
 * Three phases: `starting` until `bootServer` has listened, `ready` while
 * serving, `shutting_down` from the first SIGTERM. Readiness is what the load
 * balancer reads, so dropping it is the FIRST thing a shutdown does and the
 * last thing a boot does.
 *
 * `markRuntimeReady` THROWS unless migrations were marked complete: a task
 * that answers 200 on readiness against a schema it has not verified is the
 * task that serves 500s on every request that touches a new column.
 */

export type RuntimePhase = "starting" | "ready" | "shutting_down";

interface RuntimeHealthState {
  phase: RuntimePhase;
  migrationsComplete: boolean;
  reason?: string;
}

const state: RuntimeHealthState = {
  phase: "starting",
  migrationsComplete: false,
};

export function markMigrationsComplete(): void {
  state.migrationsComplete = true;
}

export function markRuntimeReady(): void {
  if (!state.migrationsComplete) {
    throw new Error("Cannot mark runtime ready before migrations complete");
  }
  state.phase = "ready";
  state.reason = undefined;
}

export function markRuntimeNotReady(reason: string): void {
  state.phase = "starting";
  state.reason = reason;
}

export function markRuntimeShuttingDown(): void {
  state.phase = "shutting_down";
  state.reason = "shutdown";
}

export function getRuntimeHealthState(): Readonly<RuntimeHealthState> {
  return { ...state };
}

/** Tests only: readiness is module state, and a test that flips it must put it back. */
export function resetRuntimeHealthState(): void {
  state.phase = "starting";
  state.migrationsComplete = false;
  state.reason = undefined;
}
