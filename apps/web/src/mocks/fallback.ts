// Fallback mock transport for browsers that cannot register a Service Worker (e.g. embedded webviews):
// fetch is routed through the same MSW handlers via getResponse(), and EventSource is replaced by a small
// fetch-stream reader. Only used in dev when the Service Worker fails to start.
import { getResponse, type RequestHandler } from 'msw';

export function installFetchFallback(handlers: RequestHandler[]) {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), window.location.href), init);
    const res = await getResponse(handlers, request);
    return res ?? realFetch(request);
  };

  class FetchEventSource {
    static readonly CLOSED = 2;
    readyState = 0;
    private listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();
    private ctrl = new AbortController();
    constructor(url: string) {
      void this.run(url);
    }
    addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    close() {
      this.readyState = 2;
      this.ctrl.abort();
    }
    private emit(type: string, data: string, id: string) {
      for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data, lastEventId: id }));
    }
    private async run(url: string) {
      try {
        const res = await window.fetch(url, { signal: this.ctrl.signal, headers: { Accept: 'text/event-stream' } });
        this.readyState = 1;
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = 'message';
            let id = '';
            const data: string[] = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('id:')) id = line.slice(3).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (data.length) this.emit(event, data.join('\n'), id);
          }
        }
      } catch {
        /* aborted or stream error: the mock does not reconnect */
      }
    }
  }
  (window as unknown as { EventSource: unknown }).EventSource = FetchEventSource;
}
