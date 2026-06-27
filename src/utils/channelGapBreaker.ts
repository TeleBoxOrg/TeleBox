/**
 * Channel gap recovery circuit breaker.
 *
 * When _recoverChannelGap (in teleproto) encounters persistent PTS desync
 * errors (PERSISTENT_TIMESTAMP_OUTDATED / HISTORY_GET_FAILED) for a
 * channel, it retries indefinitely — wasting API calls and log bandwidth.
 *
 * This module hooks into the Logger's existing downgrade interceptor and
 * tracks per-channel failure counts. Once a channel exceeds the failure
 * threshold within the tracking window, we clear its PTS state from the
 * TelegramClient so that subsequent update dispatches treat new updates
 * as "apply immediately" instead of detecting a gap and triggering
 * another round of hopeless GetChannelDifference calls.
 *
 * Importantly, this only touches TeleBox code — the teleproto library
 * itself is not modified.
 */

// Note: this module intentionally does NOT import getGlobalClient — it needs
// SYNC access to the active runtime's client (see tryGetClient() below), and
// getGlobalClient() is async. We grab the client via a lazy require() of
// runtimeManager.tryGetCurrentRuntime() instead.

// --- Configuration -----------------------------------------------------------

/** How many consecutive PTS failures before we circuit-break the channel. */
const FAILURE_THRESHOLD = 2;

/**
 * Sliding window in ms. Failures older than this are forgotten.
 * Set to 30 minutes so that transient issues self-heal.
 */
const FAILURE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Base cooldown in ms after circuit-breaking a channel before we allow it to
 * accumulate failures again. This prevents the breaker from firing on
 * every single update when a broken channel is still receiving messages.
 *
 * For channels that repeatedly circuit-break, the cooldown grows exponentially
 * (base × 2^(repeatCount-1)), capped at MAX_COOLDOWN_MS. A permanently
 * desynced channel (e.g. 1680975844) would go: 6h → 12h → 24h → 48h → 72h,
 * drastically reducing API waste and log noise.
 */
const BASE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_COOLDOWN_MS = 72 * 60 * 60 * 1000; // 72 hours (3 days)

// --- Types -------------------------------------------------------------------

interface FailureRecord {
  timestamps: number[];
  brokenAt: number | null; // timestamp when circuit-breaker was triggered
  breakCount: number;     // how many times this channel has been circuit-broken
}

// --- State -------------------------------------------------------------------

const channelFailures = new Map<string, FailureRecord>();

/**
 * Maximum number of channel records to track. If exceeded, oldest inactive
 * records are evicted to prevent unbounded memory growth over long uptimes.
 */
const MAX_TRACKED_CHANNELS = 500;

/**
 * Minimum age (ms) before a record with no active failures can be evicted.
 * Only entries that have been inactive for at least this long are candidates.
 */
const EVICTION_MIN_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// --- Public API --------------------------------------------------------------

/**
 * Called by the Logger's downgrade interceptor each time a
 * PERSISTENT_TIMESTAMP_OUTDATED or HISTORY_GET_FAILED error is detected
 * for a channel.
 *
 * @param channelId - The Telegram channel/group ID as a string (e.g. "1680975844")
 */
export function recordChannelGapFailure(channelId: string): void {
  const now = Date.now();

  // Evict stale entries if the map grows too large
  if (channelFailures.size >= MAX_TRACKED_CHANNELS) {
    evictStaleRecords(now);
  }

  let record = channelFailures.get(channelId);

  if (!record) {
    record = { timestamps: [], brokenAt: null, breakCount: 0 };
    channelFailures.set(channelId, record);
  }

  // Compute the effective cooldown for this channel based on its repeat break count
  const effectiveCooldown = getEffectiveCooldown(record.breakCount);

  // If we recently broke this channel, skip *counting* during cooldown but
  // still aggressively clear any new pts that teleproto re-set after the
  // last break. Without this, every new update for the channel re-establishes
  // pts -> gap detected -> GetChannelDifference retry -> PTS warn, even
  // though we're "broken". Silent re-clear keeps the breaker effective for
  // the full cooldown window.
  if (record.brokenAt && now - record.brokenAt < effectiveCooldown) {
    silentlyClearChannelPts(channelId);
    return;
  }

  // Prune timestamps outside the sliding window
  record.timestamps = record.timestamps.filter((t) => now - t < FAILURE_WINDOW_MS);
  record.timestamps.push(now);

  if (record.timestamps.length >= FAILURE_THRESHOLD) {
    circuitBreakChannel(channelId);
  }
}

/**
 * Check whether a channel has been circuit-broken and should be skipped.
 * This can be used to avoid logging redundant warnings.
 */
export function isChannelCircuitBroken(channelId: string): boolean {
  const record = channelFailures.get(channelId);
  if (!record || !record.brokenAt) return false;
  const now = Date.now();
  const effectiveCooldown = getEffectiveCooldown(record.breakCount);
  if (now - record.brokenAt >= effectiveCooldown) {
    // Cooldown expired — allow the channel to recover naturally
    // Don't delete the record; keep breakCount so that the next break
    // uses the escalated cooldown.
    record.brokenAt = null;
    record.timestamps = [];
    return false;
  }
  return true;
}

/**
 * Evict stale channel records to bound memory usage. Removes entries that
 * have no active failures and have been idle for EVICTION_MIN_AGE_MS.
 * Records with active circuit-breaks or recent failures are never evicted.
 */
function evictStaleRecords(now: number): void {
  for (const [channelId, record] of channelFailures) {
    const hasActiveFailures = record.timestamps.some((t) => now - t < FAILURE_WINDOW_MS);
    const isCircuitBroken = record.brokenAt !== null && now - record.brokenAt < getEffectiveCooldown(record.breakCount);

    // Determine last activity: prefer brokenAt, then latest timestamp.
    // If no failures ever recorded (brand-new record), lastActivity = 0 → not stale.
    const lastActivity = record.brokenAt
      ? record.brokenAt
      : (record.timestamps[record.timestamps.length - 1] ?? 0);

    // Only evict if the record has seen at least one failure in its lifetime
    // and has been idle for the minimum age.
    const isStale = lastActivity > 0 && now - lastActivity >= EVICTION_MIN_AGE_MS;

    if (!hasActiveFailures && !isCircuitBroken && isStale) {
      channelFailures.delete(channelId);
    }
  }
}

// --- Internal ----------------------------------------------------------------

/**
 * Compute the effective cooldown for a channel based on how many times it has
 * been circuit-broken. Uses exponential backoff:
 *   1st break: BASE_COOLDOWN_MS (6h)
 *   2nd break: BASE_COOLDOWN_MS × 2 (12h)
 *   3rd break: BASE_COOLDOWN_MS × 4 (24h)
 *   4th break: BASE_COOLDOWN_MS × 8 (48h)
 *   5th+ break: MAX_COOLDOWN_MS (72h)
 */
function getEffectiveCooldown(breakCount: number): number {
  if (breakCount <= 0) return BASE_COOLDOWN_MS;
  const multiplier = Math.pow(2, breakCount - 1);
  return Math.min(BASE_COOLDOWN_MS * multiplier, MAX_COOLDOWN_MS);
}

/**
 * Format a millisecond duration as a human-readable string for logging.
 */
function formatCooldown(ms: number): string {
  const hours = Math.round(ms / 3600000);
  if (hours >= 24) {
    const days = Math.round(hours / 24);
    return `${days}d`;
  }
  return `${hours}h`;
}

/**
 * Clear the channel's PTS state from the TelegramClient so that
 * gap recovery (fetchChannelDifference) stops retrying.
 *
 * Supports two teleproto layouts:
 *   - teleproto 1.224 and earlier: client._channelPts / _pendingChannelUpdates /
 *     _fetchingChannelDifference (flat Maps on the client).
 *   - teleproto 1.225+: client.updateManager.channels (Map<id, {pts: PtsWaiter,
 *     timer, inputChannel}>) plus client.updateManager.channelFailRetryTimers
 *     and client.updateManager.channelFailTimeoutS.
 *
 * After this, incoming updates for the channel re-init pts from the server
 * and gap detection effectively restarts from a clean slate.
 */
function circuitBreakChannel(channelId: string): void {
  const now = Date.now();
  const record = channelFailures.get(channelId);
  if (!record) return;

  record.breakCount++;
  record.brokenAt = now;

  const effectiveCooldown = getEffectiveCooldown(record.breakCount);

  try {
    const client = tryGetClient();
    if (!client) return;

    const summary = clearChannelStateOnClient(client, channelId);
    if (summary.cleared) {
      console.log(
        `[CircuitBreaker] Cleared pts=${summary.oldPts ?? "?"} for channel ${channelId} — ` +
        `${record.timestamps.length} PTS failures within ${Math.round(FAILURE_WINDOW_MS / 60000)}min window. ` +
        `Cooldown: ${formatCooldown(effectiveCooldown)} (repeat #${record.breakCount}) ` +
        `[layout=${summary.layout}]`
      );
    }

    // Reset failure counter after breaking
    record.timestamps = [];
  } catch {
    // Client might not be available during startup/shutdown
  }
}

/**
 * Silently clear the channel's pts state during cooldown. No log output,
 * no failure-counter changes — just defang teleproto's gap recovery so
 * the next update for this channel applies directly.
 */
function silentlyClearChannelPts(channelId: string): void {
  try {
    const client = tryGetClient();
    if (!client) return;
    clearChannelStateOnClient(client, channelId);
  } catch {
    // Client might not be available
  }
}

/**
 * Probe both teleproto layouts and clear whichever one is in use. Returns
 * a summary so the caller can log the resolved layout for diagnostics.
 */
function clearChannelStateOnClient(
  client: any,
  channelId: string,
): { cleared: boolean; oldPts: number | string | null; layout: string } {
  let cleared = false;
  let oldPts: number | string | null = null;
  let layout: string = "none";

  // teleproto 1.225+ layout: client.updateManager.{channels, channelFailRetryTimers, channelFailTimeoutS}
  const um = client.updateManager;
  if (um && um.channels && typeof um.channels.get === "function") {
    layout = "updateManager";
    const tracker = um.channels.get(channelId);
    if (tracker) {
      try {
        if (tracker.pts && typeof tracker.pts.current === "function") {
          oldPts = tracker.pts.current();
        }
      } catch {
        // ignore
      }
      try {
        if (tracker.timer) {
          clearTimeout(tracker.timer);
          tracker.timer = undefined;
        }
        if (tracker.pts && typeof tracker.pts.clearSkippedUpdates === "function") {
          tracker.pts.clearSkippedUpdates();
        }
        if (tracker.pts && typeof tracker.pts.setRequesting === "function") {
          tracker.pts.setRequesting(false);
        }
      } catch {
        // best-effort
      }
      um.channels.delete(channelId);
      cleared = true;
    }
    if (um.channelFailRetryTimers && typeof um.channelFailRetryTimers.get === "function") {
      const t = um.channelFailRetryTimers.get(channelId);
      if (t) {
        try { clearTimeout(t); } catch { /* ignore */ }
        um.channelFailRetryTimers.delete(channelId);
        cleared = true;
      }
    }
    if (um.channelFailTimeoutS && typeof um.channelFailTimeoutS.delete === "function") {
      if (um.channelFailTimeoutS.has?.(channelId)) {
        um.channelFailTimeoutS.delete(channelId);
        cleared = true;
      }
    }
  }

  // teleproto 1.224 and earlier: flat maps on the client
  if (!cleared) {
    if (client._channelPts && typeof client._channelPts.get === "function" && client._channelPts.has(channelId)) {
      layout = "legacy";
      oldPts = client._channelPts.get(channelId);
      client._channelPts.delete(channelId);
      cleared = true;
    }
    if (client._pendingChannelUpdates && typeof client._pendingChannelUpdates.delete === "function") {
      if (client._pendingChannelUpdates.has?.(channelId)) {
        layout = layout === "none" ? "legacy" : layout;
        client._pendingChannelUpdates.delete(channelId);
        cleared = true;
      }
    }
    if (client._fetchingChannelDifference && typeof client._fetchingChannelDifference.delete === "function") {
      if (client._fetchingChannelDifference.has?.(channelId)) {
        layout = layout === "none" ? "legacy" : layout;
        client._fetchingChannelDifference.delete(channelId);
        cleared = true;
      }
    }
  }

  return { cleared, oldPts, layout };
}

/**
 * Safely get the TelegramClient without throwing.
 * The client has _channelPts, _pendingChannelUpdates, and
 * _fetchingChannelDifference as internal Maps/Sets.
 */
function tryGetClient(): any | null {
  try {
    // Sync access required; getGlobalClient() is async and unsuitable here.
    // tryGetCurrentRuntime returns the live runtime synchronously when set.
    const { tryGetCurrentRuntime } = require("./runtimeManager") as typeof import("./runtimeManager");
    const runtime = tryGetCurrentRuntime();
    if (runtime?.client) {
      return runtime.client;
    }
  } catch {
    // Runtime not available
  }
  return null;
}

/**
 * Reset the circuit breaker state. Called during runtime reload to
 * start fresh.
 *
 * IMPORTANT: breakCount is preserved across reloads. If a channel has been
 * circuit-broken repeatedly (e.g. a permanently desynced channel), resetting
 * breakCount would cause the exponential backoff to start over at 6h every
 * reload — defeating the escalation (6h→12h→24h→48h→72h). By keeping
 * breakCount, the cooldown stays at the escalated level, keeping log noise
 * and wasted API calls to a minimum for chronically broken channels.
 */
export function resetCircuitBreaker(): void {
  for (const [channelId, record] of channelFailures) {
    record.timestamps = [];
    record.brokenAt = null;
    // breakCount is intentionally preserved
    // If a channel's breakCount is stale (channel recovered), it only
    // matters if the channel starts failing again after reload — at which
    // point the escalated cooldown is correct behavior (the channel has
    // a history of repeated breaks).
  }
}