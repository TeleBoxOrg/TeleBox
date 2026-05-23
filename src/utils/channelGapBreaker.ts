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

import { getGlobalClient } from "./globalClient";

// --- Configuration -----------------------------------------------------------

/** How many consecutive PTS failures before we circuit-break the channel. */
const FAILURE_THRESHOLD = 2;

/**
 * Sliding window in ms. Failures older than this are forgotten.
 * Set to 30 minutes so that transient issues self-heal.
 */
const FAILURE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Cooldown in ms after circuit-breaking a channel before we allow it to
 * accumulate failures again. This prevents the breaker from firing on
 * every single update when a broken channel is still receiving messages.
 */
const BREAK_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

// --- Types -------------------------------------------------------------------

interface FailureRecord {
  timestamps: number[];
  brokenAt: number | null; // timestamp when circuit-breaker was triggered
}

// --- State -------------------------------------------------------------------

const channelFailures = new Map<string, FailureRecord>();

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
  let record = channelFailures.get(channelId);

  if (!record) {
    record = { timestamps: [], brokenAt: null };
    channelFailures.set(channelId, record);
  }

  // If we recently broke this channel, skip *counting* during cooldown but
  // still aggressively clear any new pts that teleproto re-set after the
  // last break. Without this, every new update for the channel re-establishes
  // pts -> gap detected -> GetChannelDifference retry -> PTS warn, even
  // though we're "broken". Silent re-clear keeps the breaker effective for
  // the full cooldown window.
  if (record.brokenAt && now - record.brokenAt < BREAK_COOLDOWN_MS) {
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
  if (now - record.brokenAt >= BREAK_COOLDOWN_MS) {
    // Cooldown expired — allow the channel to recover naturally
    channelFailures.delete(channelId);
    return false;
  }
  return true;
}

// --- Internal ----------------------------------------------------------------

/**
 * Clear the channel's PTS state from the TelegramClient so that
 * _recoverChannelGap no longer detects a gap for this channel.
 *
 * After this, incoming updates for this channel will have localPts === undefined,
 * which means the update handler skips gap detection and applies the update
 * directly (see _dispatchUpdate in updates.js, line ~820).
 */
function circuitBreakChannel(channelId: string): void {
  const now = Date.now();
  const record = channelFailures.get(channelId);
  if (!record) return;

  record.brokenAt = now;

  try {
    // Access the TelegramClient to clear PTS state
    const client = tryGetClient();
    if (!client) return;

    // Delete the channel's cached pts so gap detection is skipped
    if (client._channelPts && client._channelPts.has(channelId)) {
      const oldPts = client._channelPts.get(channelId);
      client._channelPts.delete(channelId);
      console.log(
        `[CircuitBreaker] Cleared pts=${oldPts} for channel ${channelId} — ` +
        `${record.timestamps.length} PTS failures within ${Math.round(FAILURE_WINDOW_MS / 60000)}min window. ` +
        `Cooldown: ${Math.round(BREAK_COOLDOWN_MS / 3600000)}h`
      );
    }

    // Also clear pending updates for this channel to prevent re-triggering
    if (client._pendingChannelUpdates && client._pendingChannelUpdates.has(channelId)) {
      client._pendingChannelUpdates.delete(channelId);
    }

    // Remove from fetching set in case it's stuck
    if (client._fetchingChannelDifference) {
      client._fetchingChannelDifference.delete(channelId);
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
    if (client._channelPts && client._channelPts.has(channelId)) {
      client._channelPts.delete(channelId);
    }
    if (client._pendingChannelUpdates && client._pendingChannelUpdates.has(channelId)) {
      client._pendingChannelUpdates.delete(channelId);
    }
    if (client._fetchingChannelDifference) {
      client._fetchingChannelDifference.delete(channelId);
    }
  } catch {
    // Client might not be available
  }
}

/**
 * Safely get the TelegramClient without throwing.
 * The client has _channelPts, _pendingChannelUpdates, and
 * _fetchingChannelDifference as internal Maps/Sets.
 */
function tryGetClient(): any | null {
  try {
    // getGlobalClient is async, but we need sync access.
    // Access the runtime's client directly.
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
 */
export function resetCircuitBreaker(): void {
  channelFailures.clear();
}