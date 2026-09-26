export function isFrameScriptError(event: Event, frameWindow: Window): boolean {
  return event.target === frameWindow;
}
