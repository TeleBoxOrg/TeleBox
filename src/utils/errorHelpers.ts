/**
 * Type-safe error handling utilities.
 *
 * These helpers replace `catch (error: any)` patterns with
 * `catch (error: unknown)` while still providing convenient access
 * to error message and code properties.
 */

/**
 * Extract the message from an unknown caught error.
 * Safely handles Error objects, strings, and other types.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    error !== null &&
    error !== undefined &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

/**
 * Extract the code from an unknown caught error (e.g., Node.js errno codes).
 */
export function getErrorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    error !== undefined &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

/**
 * Narrow an unknown caught value to an Error instance.
 * Returns the Error if it is one, otherwise wraps it in a new Error.
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(getErrorMessage(error));
}

/**
 * Extract stdout/stderr from a child_process.exec error (or any object
 * that carries those fields).  Returns { stdout, stderr } with empty
 * strings for missing fields.
 */
export function getExecErrorOutput(error: unknown): {
  stdout: string;
  stderr: string;
  message: string;
} {
  if (error !== null && error !== undefined && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    return {
      stdout: typeof obj.stdout === "string" ? obj.stdout : String(obj.stdout ?? "").trim(),
      stderr: typeof obj.stderr === "string" ? obj.stderr : String(obj.stderr ?? "").trim(),
      message: getErrorMessage(error),
    };
  }
  return { stdout: "", stderr: "", message: getErrorMessage(error) };
}