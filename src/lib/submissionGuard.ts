export interface ChatSubmissionLock {
  current: symbol | null;
}

export function isChatSubmissionInFlight(lock: ChatSubmissionLock): boolean {
  return lock.current !== null;
}

export function tryAcquireChatSubmission(
  lock: ChatSubmissionLock,
  isStreamingState: boolean
): symbol | null {
  if (isStreamingState || lock.current !== null) {
    return null;
  }
  const token = Symbol('chat-submission');
  lock.current = token;
  return token;
}

export function releaseChatSubmission(
  lock: ChatSubmissionLock,
  token?: symbol | null
): boolean {
  if (token !== undefined && lock.current !== token) {
    return false;
  }
  if (lock.current === null) {
    return false;
  }
  lock.current = null;
  return true;
}
