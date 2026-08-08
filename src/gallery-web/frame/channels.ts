/**
 * Frame-side channel primitives.
 *
 * The shell holds port1 of two distinct MessageChannels:
 *   1. SOURCE ingress — one-shot: artifact bytes cross the channel ONCE,
 *      after which the port closes. A second postMessage would be a
 *      no-op AND any read on the frame side after closure sees nothing.
 *   2. CONTROL — closure-held: never on window/global, never closed by
 *      the frame; the shell closes it on frame replacement.
 *
 * Trust path is the closure-held port. The shell does NOT install a
 * `window.addEventListener('message', ...)` security gate as its trust
 * path — that path is for the postMessage handshake only, to transfer
 * the port2 ends into the frame, and the bootstrap verifies the
 * per-frame nonce on the handshake.
 *
 * No zod — the frame bundle speaks plain JS only.
 */

export interface MessageChannelCtor {
  new (): {
    readonly port1: MessagePort;
    readonly port2: MessagePort;
  };
}

export interface ChannelPairOptions {
  readonly messageChannelCtor: MessageChannelCtor;
}

export interface ChannelPair {
  /** Shell-held end of the source ingress (port1). */
  readonly ingressPort: MessagePort;
  /** Shell-held end of the control channel (port1). */
  readonly controlPort: MessagePort;
  /** Frame-side ends (port2) to transfer via postMessage into the iframe. */
  readonly frameIngressPort: MessagePort;
  readonly frameControlPort: MessagePort;
  /** Send the artifact exactly once; subsequent calls are no-ops. */
  deliverSource(payload: unknown): void;
  /** Send a control event (boot-ready, render-complete, etc). Stays open. */
  sendControl(payload: unknown): void;
  /** Close the control port (called on frame replacement). */
  closeControl(): void;
  /** Close both ports (test convenience — production code closes per-channel). */
  close(): void;
  /** True until the source port has been delivered + closed. */
  readonly ingressOpen: boolean;
  /** True until closeControl() runs. */
  readonly controlOpen: boolean;
  /**
   * Test hook: when set, the port's onmessage is forwarded to this
   * function (used by the lifecycle test). Production code does not
   * touch this — in production the port is transferred into the frame,
   * where the bootstrap's listener consumes the artifact.
   */
  onIngressMessage?: ((event: { data: unknown }) => void) | undefined;
}

export function createChannelPair(options: ChannelPairOptions): ChannelPair {
  const ingress = new options.messageChannelCtor();
  const control = new options.messageChannelCtor();
  let ingressDelivered = false;
  let controlOpen = true;

  const pair: ChannelPair = {
    ingressPort: ingress.port1,
    controlPort: control.port1,
    frameIngressPort: ingress.port2,
    frameControlPort: control.port2,
    get ingressOpen() {
      return !ingressDelivered;
    },
    get controlOpen() {
      return controlOpen;
    },
    deliverSource(payload) {
      if (ingressDelivered) return;
      ingressDelivered = true;
      try {
        ingress.port1.postMessage(payload);
      } finally {
        try {
          ingress.port1.close();
        } catch {
          // already closed by structured-clone failure or earlier error
        }
      }
    },
    sendControl(payload) {
      if (!controlOpen) return;
      try {
        control.port1.postMessage(payload);
      } catch {
        // control channel torn down — drop silently; the shell will
        // close + recreate on the next swap
      }
    },
    closeControl() {
      if (!controlOpen) return;
      controlOpen = false;
      try {
        control.port1.close();
      } catch {
        // already closed
      }
    },
    close() {
      pair.deliverSource(null);
      pair.closeControl();
    },
    onIngressMessage: undefined,
  };

  // Wire onIngressMessage to port2 (frame-side) on assignment so the
  // test gate can observe structured-clone delivery end-to-end without
  // a real iframe. Production code never sets this — the port is
  // transferred into the frame, where the bootstrap listener consumes
  // it.
  Object.defineProperty(pair, "onIngressMessage", {
    get(): ((event: { data: unknown }) => void) | undefined {
      return undefined;
    },
    set(handler: ((event: { data: unknown }) => void) | undefined): void {
      ingress.port2.addEventListener("message", (ev: MessageEvent) => {
        handler?.({ data: ev.data });
      });
    },
    enumerable: true,
    configurable: true,
  });

  return pair;
}

/**
 * Fresh nonce per frame. Cryptographically random; the shell pins it
 * into the CSP meta + the <script nonce> + the bootstrap's handshake
 * verification. A future regression that reuses a nonce across swaps
 * would let an old bootstrap survive a CSP bypass attempt.
 */
export function freshFrameNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
