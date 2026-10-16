// Invalidate account-bound continuations before an auth IPC request is sent,
// rather than waiting for React to render the worker's account-change event.
let revision = 0;
let pending = 0;
export function beginAccountTransition(): () => void {
  revision++;
  pending++;
  let finished = false;
  return () => { if (!finished) { finished = true; pending--; } };
}
export function captureAccountOperation(): () => void {
  const expected = revision;
  const assert = () => {
    if (pending || revision !== expected) throw Error("Аккаунт переключается или изменился. Повторите действие после переключения.");
  };
  assert();
  return assert;
}
