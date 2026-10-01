// A package index that accepts connections and never answers: a hung mirror. Scenarios point pip
// at it to get a setup step that never finishes, deterministically and without the network.

import net from "node:net";

export interface Blackhole {
  url: string;
  /** Connections accepted so far (each one is a client left waiting). */
  connections(): number;
  close(): Promise<void>;
}

export async function startBlackhole(): Promise<Blackhole> {
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer((s) => {
    accepted++;
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
    s.resume(); // read the request, never reply
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/simple/`,
    connections: () => accepted,
    close: () =>
      new Promise((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => ok());
      }),
  };
}
