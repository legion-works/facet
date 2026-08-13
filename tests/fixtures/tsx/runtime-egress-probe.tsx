import React, { useEffect } from "react";

export default function RuntimeEgressProbe() {
  useEffect(() => {
    const {
      fetch: runtimeFetch,
      XMLHttpRequest: RuntimeXHR,
      WebSocket: RuntimeWebSocket,
      EventSource: RuntimeEventSource,
      Worker: RuntimeWorker,
      SharedWorker: RuntimeSharedWorker,
    } = globalThis;
    const target = "__FACET_EGRESS_ORIGIN__";
    const socket = "__FACET_EGRESS_SOCKET__";
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch {}
    };
    attempt(() => {
      void runtimeFetch(target + "/fetch").catch(() => {});
    });
    attempt(() => {
      const request = new RuntimeXHR();
      request.open("GET", target + "/xhr");
      request.send();
    });
    attempt(() => {
      void new RuntimeWebSocket(socket + "/ws");
    });
    attempt(() => {
      void new RuntimeEventSource(target + "/events");
    });
    attempt(() => {
      void new RuntimeWorker(target + "/worker.js");
    });
    attempt(() => {
      void new RuntimeSharedWorker(target + "/shared-worker.js");
    });
    attempt(() => {
      const image = new Image();
      image.src = target + "/image";
      document.body.appendChild(image);
    });
    attempt(() => {
      const script = document.createElement("script");
      script.src = target + "/script.js";
      document.head.appendChild(script);
    });
    attempt(() => {
      navigator.sendBeacon(target + "/beacon", "x");
    });
    attempt(() => {
      void window.parent.location.href;
    });
  }, []);

  return (
    <main>
      <h1>Runtime egress probe</h1>
      <p>Alias paths reached the runtime boundary.</p>
    </main>
  );
}
